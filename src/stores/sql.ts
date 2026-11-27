import {
  decideExtraction,
  type BeginExtractionArgs,
  type BeginExtractionResult,
  type ExtractionState,
  type FactPatch,
  type MemoryKey,
  type MemoryStore,
} from '../store.js';
import type {Fact, FactScope, NewFact, Pin, RelationshipStage, RelationshipState, Role} from '../types.js';
import {runMigrations, splitStatements} from './migrations.js';

/** Minimal async SQL interface. Adapters for node:sqlite / better-sqlite3 and Cloudflare D1 are below. */
export interface SqlDriver {
  run(sql: string, params?: unknown[]): Promise<{changes: number}>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** SQLite dialect (works on SQLite, libSQL/Turso and Cloudflare D1). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cm_story (
  user_id TEXT NOT NULL, agent_id TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, agent_id)
);
CREATE TABLE IF NOT EXISTS cm_pins (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_pins_key ON cm_pins (user_id, agent_id, created_at);
CREATE TABLE IF NOT EXISTS cm_facts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('persona', 'character', 'side')),
  subject_name TEXT, content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_facts_key ON cm_facts (user_id, agent_id, updated_at);
CREATE TABLE IF NOT EXISTS cm_relationship (
  user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  familiarity INTEGER NOT NULL, interaction_count INTEGER NOT NULL,
  trust INTEGER NOT NULL, attachment INTEGER NOT NULL, romance INTEGER NOT NULL,
  stage TEXT NOT NULL, notes_json TEXT NOT NULL, last_interaction_at INTEGER NOT NULL,
  last_turn_fp TEXT, PRIMARY KEY (user_id, agent_id)
);
CREATE TABLE IF NOT EXISTS cm_extraction (
  user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  status TEXT NOT NULL, last_turn INTEGER NOT NULL DEFAULT 0, last_thread_id TEXT,
  last_extracted_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent_id)
);
`;

type NodeSqliteLike = {
  prepare(sql: string): {
    run(...params: unknown[]): {changes: number | bigint};
    all(...params: unknown[]): unknown[];
  };
};

/** Adapter for `node:sqlite` (DatabaseSync) and `better-sqlite3`. */
export function fromNodeSqlite(db: NodeSqliteLike): SqlDriver {
  return {
    async run(sql, params = []) {
      return {changes: Number(db.prepare(sql).run(...params).changes)};
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}

type D1Like = {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      run(): Promise<{meta?: {changes?: number}}>;
      all<T>(): Promise<{results: T[]}>;
    };
  };
};

/** Adapter for a Cloudflare D1 binding. */
export function fromD1(db: D1Like): SqlDriver {
  return {
    async run(sql, params = []) {
      const res = await db.prepare(sql).bind(...params).run();
      return {changes: res.meta?.changes ?? 0};
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return (await db.prepare(sql).bind(...params).all<T>()).results;
    },
  };
}

type FactRow = {
  id: string;
  scope: FactScope;
  subject_name: string | null;
  content: string;
  source: 'auto' | 'manual';
  disabled: number;
  updated_at: number;
};

function toFact(r: FactRow): Fact {
  return {
    id: r.id,
    scope: r.scope,
    content: r.content,
    source: r.source,
    disabled: Boolean(r.disabled),
    updatedAt: Number(r.updated_at),
    ...(r.subject_name ? {subjectName: r.subject_name} : {}),
  };
}

export class SqlStore implements MemoryStore {
  private readonly now: () => number;

  constructor(
    private readonly sql: SqlDriver,
    options: {now?: () => number} = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Create or upgrade tables. Safe to call on every boot. Returns the migrations applied now. */
  async migrate(): Promise<string[]> {
    return runMigrations(this.sql, [{name: 'core-001', statements: splitStatements(SCHEMA_SQL)}]);
  }

  async getStory(key: MemoryKey) {
    const rows = await this.sql.all<{body: string}>(
      'SELECT body FROM cm_story WHERE user_id = ? AND agent_id = ?',
      [key.userId, key.agentId],
    );
    return rows[0]?.body ?? '';
  }
  async setStory(key: MemoryKey, body: string) {
    await this.sql.run(
      `INSERT INTO cm_story (user_id, agent_id, body, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, agent_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      [key.userId, key.agentId, body, this.now()],
    );
  }

  async listPins(key: MemoryKey) {
    const rows = await this.sql.all<{id: string; role: Role; content: string; created_at: number}>(
      'SELECT id, role, content, created_at FROM cm_pins WHERE user_id = ? AND agent_id = ? ORDER BY created_at, rowid',
      [key.userId, key.agentId],
    );
    return rows.map(r => ({id: r.id, role: r.role, content: r.content, createdAt: Number(r.created_at)}));
  }
  async addPin(key: MemoryKey, pin: {role: Role; content: string}) {
    const row: Pin = {id: crypto.randomUUID(), ...pin, createdAt: this.now()};
    await this.sql.run(
      'INSERT INTO cm_pins (id, user_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [row.id, key.userId, key.agentId, row.role, row.content, row.createdAt],
    );
    return row;
  }
  async removePin(key: MemoryKey, pinId: string) {
    await this.sql.run('DELETE FROM cm_pins WHERE id = ? AND user_id = ? AND agent_id = ?', [
      pinId,
      key.userId,
      key.agentId,
    ]);
  }

  async listFacts(key: MemoryKey) {
    const rows = await this.sql.all<FactRow>(
      `SELECT id, scope, subject_name, content, source, disabled, updated_at
       FROM cm_facts WHERE user_id = ? AND agent_id = ? ORDER BY updated_at, rowid`,
      [key.userId, key.agentId],
    );
    return rows.map(toFact);
  }
  async addFact(key: MemoryKey, fact: NewFact) {
    const id = crypto.randomUUID();
    const now = this.now();
    await this.sql.run(
      `INSERT INTO cm_facts (id, user_id, agent_id, scope, subject_name, content, source, disabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [id, key.userId, key.agentId, fact.scope, fact.subjectName ?? null, fact.content, fact.source, now, now],
    );
    return toFact({
      id,
      scope: fact.scope,
      subject_name: fact.subjectName ?? null,
      content: fact.content,
      source: fact.source,
      disabled: 0,
      updated_at: now,
    });
  }
  async updateFact(key: MemoryKey, factId: string, patch: FactPatch) {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.content !== undefined) sets.push('content = ?'), params.push(patch.content);
    if (patch.disabled !== undefined) sets.push('disabled = ?'), params.push(patch.disabled ? 1 : 0);
    if (patch.scope !== undefined) sets.push('scope = ?'), params.push(patch.scope);
    if (patch.subjectName !== undefined) sets.push('subject_name = ?'), params.push(patch.subjectName);
    if (!sets.length) return;
    sets.push('updated_at = ?');
    params.push(this.now(), factId, key.userId, key.agentId);
    await this.sql.run(`UPDATE cm_facts SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND agent_id = ?`, params);
  }
  async removeFact(key: MemoryKey, factId: string) {
    await this.sql.run('DELETE FROM cm_facts WHERE id = ? AND user_id = ? AND agent_id = ?', [
      factId,
      key.userId,
      key.agentId,
    ]);
  }

  async getRelationship(key: MemoryKey): Promise<RelationshipState | null> {
    const rows = await this.sql.all<{
      familiarity: number;
      interaction_count: number;
      trust: number;
      attachment: number;
      romance: number;
      stage: RelationshipStage;
      notes_json: string;
      last_interaction_at: number;
      last_turn_fp: string | null;
    }>('SELECT * FROM cm_relationship WHERE user_id = ? AND agent_id = ?', [key.userId, key.agentId]);
    const r = rows[0];
    if (!r) return null;
    let notes: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.notes_json);
      if (Array.isArray(parsed)) notes = parsed.filter((n): n is string => typeof n === 'string');
    } catch {
      notes = [];
    }
    return {
      familiarity: Number(r.familiarity),
      interactionCount: Number(r.interaction_count),
      trust: Number(r.trust),
      attachment: Number(r.attachment),
      romance: Number(r.romance),
      stage: r.stage,
      notes,
      lastInteractionAt: Number(r.last_interaction_at),
      ...(r.last_turn_fp ? {lastUserTurnFingerprint: r.last_turn_fp} : {}),
    };
  }
  async saveRelationship(key: MemoryKey, s: RelationshipState) {
    await this.sql.run(
      `INSERT INTO cm_relationship (user_id, agent_id, familiarity, interaction_count, trust, attachment, romance,
         stage, notes_json, last_interaction_at, last_turn_fp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, agent_id) DO UPDATE SET
         familiarity = excluded.familiarity, interaction_count = excluded.interaction_count,
         trust = excluded.trust, attachment = excluded.attachment, romance = excluded.romance,
         stage = excluded.stage, notes_json = excluded.notes_json,
         last_interaction_at = excluded.last_interaction_at, last_turn_fp = excluded.last_turn_fp`,
      [
        key.userId,
        key.agentId,
        s.familiarity,
        s.interactionCount,
        s.trust,
        s.attachment,
        s.romance,
        s.stage,
        JSON.stringify(s.notes),
        s.lastInteractionAt,
        s.lastUserTurnFingerprint ?? null,
      ],
    );
  }

  private async extractionState(key: MemoryKey): Promise<ExtractionState | null> {
    const rows = await this.sql.all<{
      status: ExtractionState['status'];
      last_turn: number;
      last_thread_id: string | null;
      last_extracted_at: number;
      updated_at: number;
    }>(
      'SELECT status, last_turn, last_thread_id, last_extracted_at, updated_at FROM cm_extraction WHERE user_id = ? AND agent_id = ?',
      [key.userId, key.agentId],
    );
    const r = rows[0];
    return r ?
        {
          status: r.status,
          lastTurn: Number(r.last_turn),
          lastThreadId: r.last_thread_id,
          lastExtractedAt: Number(r.last_extracted_at),
          updatedAt: Number(r.updated_at),
        }
      : null;
  }

  /** Read → decide → compare-and-set on (status, updated_at), so concurrent callers cannot both start. */
  async beginExtraction(key: MemoryKey, args: BeginExtractionArgs): Promise<BeginExtractionResult> {
    const state = await this.extractionState(key);
    const decision = decideExtraction(state, args);
    if (decision !== 'started') return decision;
    const res =
      state ?
        await this.sql.run(
          `UPDATE cm_extraction SET status = 'running', last_error = NULL, updated_at = ?
           WHERE user_id = ? AND agent_id = ? AND status = ? AND updated_at = ?`,
          [args.now, key.userId, key.agentId, state.status, state.updatedAt],
        )
      : await this.sql.run(
          `INSERT INTO cm_extraction (user_id, agent_id, status, updated_at) VALUES (?, ?, 'running', ?)
           ON CONFLICT (user_id, agent_id) DO NOTHING`,
          [key.userId, key.agentId, args.now],
        );
    return res.changes > 0 ? 'started' : 'busy';
  }
  async finishExtraction(key: MemoryKey, args: {turn: number; threadId?: string; now: number; error?: string}) {
    if (args.error) {
      await this.sql.run(
        `UPDATE cm_extraction SET status = 'error', last_error = ?, updated_at = ? WHERE user_id = ? AND agent_id = ?`,
        [args.error.slice(0, 240), args.now, key.userId, key.agentId],
      );
      return;
    }
    await this.sql.run(
      `UPDATE cm_extraction SET status = 'ok', last_turn = ?, last_extracted_at = ?, updated_at = ?,
         last_thread_id = COALESCE(?, last_thread_id), last_error = NULL
       WHERE user_id = ? AND agent_id = ?`,
      [args.turn, args.now, args.now, args.threadId ?? null, key.userId, key.agentId],
    );
  }

  async clear(key: MemoryKey) {
    for (const table of ['cm_story', 'cm_pins', 'cm_facts', 'cm_relationship', 'cm_extraction']) {
      await this.sql.run(`DELETE FROM ${table} WHERE user_id = ? AND agent_id = ?`, [key.userId, key.agentId]);
    }
  }
}
