import {runMigrations, splitStatements} from '../stores/migrations.js';
import type {SqlDriver} from '../stores/sql.js';
import {episodeLimit, type HomeStore, type MemberInput, type ObjectInput} from './store.js';
import type {
  Episode,
  EpisodeData,
  EpisodeKind,
  EpisodeQuery,
  HomeKey,
  Member,
  MemberRole,
  ObjectEntity,
  ObjectSighting,
  Place,
  PlaceKind,
  Provenance,
  SafetyTag,
} from './types.js';

/** SQLite dialect (SQLite with JSON1, libSQL/Turso, Cloudflare D1). */
export const HOME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cm_home_members (
  home_id TEXT NOT NULL, id TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL,
  aliases_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, id)
);
CREATE TABLE IF NOT EXISTS cm_home_places (
  home_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  parent_id TEXT, aliases_json TEXT NOT NULL, map_ref TEXT,
  PRIMARY KEY (home_id, id)
);
CREATE TABLE IF NOT EXISTS cm_home_objects (
  home_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, category TEXT,
  aliases_json TEXT NOT NULL, owner_id TEXT, safety_tags_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, id)
);
CREATE TABLE IF NOT EXISTS cm_home_sightings (
  id TEXT PRIMARY KEY, home_id TEXT NOT NULL, object_id TEXT NOT NULL, place_id TEXT NOT NULL,
  at INTEGER NOT NULL, prov_kind TEXT NOT NULL, prov_source TEXT, prov_sensor TEXT,
  prov_confidence REAL NOT NULL, prov_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_home_sightings_obj ON cm_home_sightings (home_id, object_id, at);
CREATE TABLE IF NOT EXISTS cm_home_episodes (
  id TEXT PRIMARY KEY, home_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
  summary TEXT NOT NULL, actor_ids TEXT NOT NULL, place_id TEXT, object_ids TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, importance REAL NOT NULL,
  prov_kind TEXT NOT NULL, prov_source TEXT, prov_sensor TEXT, prov_confidence REAL NOT NULL, prov_at INTEGER NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS cm_home_episodes_time ON cm_home_episodes (home_id, started_at);
CREATE INDEX IF NOT EXISTS cm_home_episodes_label ON cm_home_episodes (home_id, label, started_at);
`;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type ProvCols = {prov_kind: Provenance['kind']; prov_source: string | null; prov_sensor: string | null; prov_confidence: number; prov_at: number};

function toProvenance(r: ProvCols): Provenance {
  return {
    kind: r.prov_kind,
    confidence: Number(r.prov_confidence),
    at: Number(r.prov_at),
    ...(r.prov_source ? {sourceId: r.prov_source} : {}),
    ...(r.prov_sensor ? {sensor: r.prov_sensor} : {}),
  };
}

const provParams = (p: Provenance) => [p.kind, p.sourceId ?? null, p.sensor ?? null, p.confidence, p.at];

type EpisodeRow = ProvCols & {
  id: string;
  kind: EpisodeKind;
  label: string;
  summary: string;
  actor_ids: string;
  place_id: string | null;
  object_ids: string;
  started_at: number;
  ended_at: number | null;
  importance: number;
  data_json: string | null;
};

function toEpisode(r: EpisodeRow): Episode {
  const data = parseJson<EpisodeData | null>(r.data_json, null);
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    summary: r.summary,
    actorIds: parseJson<string[]>(r.actor_ids, []),
    objectIds: parseJson<string[]>(r.object_ids, []),
    startedAt: Number(r.started_at),
    importance: Number(r.importance),
    provenance: toProvenance(r),
    ...(r.place_id ? {placeId: r.place_id} : {}),
    ...(r.ended_at != null ? {endedAt: Number(r.ended_at)} : {}),
    ...(data ? {data} : {}),
  };
}

export class SqlHomeStore implements HomeStore {
  private readonly now: () => number;

  constructor(
    private readonly sql: SqlDriver,
    options: {now?: () => number} = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async migrate(): Promise<string[]> {
    return runMigrations(this.sql, [{name: 'home-001', statements: splitStatements(HOME_SCHEMA_SQL)}]);
  }

  async upsertMember(key: HomeKey, m: MemberInput): Promise<Member> {
    const now = this.now();
    await this.sql.run(
      `INSERT INTO cm_home_members (home_id, id, display_name, role, aliases_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (home_id, id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role,
         aliases_json = excluded.aliases_json, updated_at = excluded.updated_at`,
      [key.homeId, m.id, m.displayName, m.role, JSON.stringify(m.aliases), now, now],
    );
    const row = (await this.listMembers(key)).find(x => x.id === m.id);
    return row!;
  }
  async listMembers(key: HomeKey): Promise<Member[]> {
    const rows = await this.sql.all<{id: string; display_name: string; role: MemberRole; aliases_json: string; created_at: number; updated_at: number}>(
      'SELECT * FROM cm_home_members WHERE home_id = ? ORDER BY created_at, id',
      [key.homeId],
    );
    return rows.map(r => ({
      id: r.id,
      displayName: r.display_name,
      role: r.role,
      aliases: parseJson<string[]>(r.aliases_json, []),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  async upsertPlace(key: HomeKey, p: Place): Promise<Place> {
    await this.sql.run(
      `INSERT INTO cm_home_places (home_id, id, name, kind, parent_id, aliases_json, map_ref) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (home_id, id) DO UPDATE SET name = excluded.name, kind = excluded.kind, parent_id = excluded.parent_id,
         aliases_json = excluded.aliases_json, map_ref = excluded.map_ref`,
      [key.homeId, p.id, p.name, p.kind, p.parentId ?? null, JSON.stringify(p.aliases), p.mapRef ?? null],
    );
    return structuredClone(p);
  }
  async listPlaces(key: HomeKey): Promise<Place[]> {
    const rows = await this.sql.all<{id: string; name: string; kind: PlaceKind; parent_id: string | null; aliases_json: string; map_ref: string | null}>(
      'SELECT * FROM cm_home_places WHERE home_id = ? ORDER BY rowid',
      [key.homeId],
    );
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      aliases: parseJson<string[]>(r.aliases_json, []),
      ...(r.parent_id ? {parentId: r.parent_id} : {}),
      ...(r.map_ref ? {mapRef: r.map_ref} : {}),
    }));
  }
  async removePlace(key: HomeKey, placeId: string) {
    await this.sql.run('DELETE FROM cm_home_places WHERE home_id = ? AND id = ?', [key.homeId, placeId]);
    await this.sql.run('DELETE FROM cm_home_sightings WHERE home_id = ? AND place_id = ?', [key.homeId, placeId]);
    await this.sql.run('UPDATE cm_home_places SET parent_id = NULL WHERE home_id = ? AND parent_id = ?', [key.homeId, placeId]);
  }

  async upsertObject(key: HomeKey, o: ObjectInput): Promise<ObjectEntity> {
    const now = this.now();
    await this.sql.run(
      `INSERT INTO cm_home_objects (home_id, id, name, category, aliases_json, owner_id, safety_tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (home_id, id) DO UPDATE SET name = excluded.name, category = excluded.category,
         aliases_json = excluded.aliases_json, owner_id = excluded.owner_id,
         safety_tags_json = excluded.safety_tags_json, updated_at = excluded.updated_at`,
      [key.homeId, o.id, o.name, o.category ?? null, JSON.stringify(o.aliases), o.ownerId ?? null, JSON.stringify(o.safetyTags), now, now],
    );
    return (await this.listObjects(key)).find(x => x.id === o.id)!;
  }
  async listObjects(key: HomeKey): Promise<ObjectEntity[]> {
    const rows = await this.sql.all<{
      id: string;
      name: string;
      category: string | null;
      aliases_json: string;
      owner_id: string | null;
      safety_tags_json: string;
      created_at: number;
      updated_at: number;
    }>('SELECT * FROM cm_home_objects WHERE home_id = ? ORDER BY created_at, id', [key.homeId]);
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      aliases: parseJson<string[]>(r.aliases_json, []),
      safetyTags: parseJson<SafetyTag[]>(r.safety_tags_json, []),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      ...(r.category ? {category: r.category} : {}),
      ...(r.owner_id ? {ownerId: r.owner_id} : {}),
    }));
  }
  async removeObject(key: HomeKey, objectId: string) {
    await this.sql.run('DELETE FROM cm_home_objects WHERE home_id = ? AND id = ?', [key.homeId, objectId]);
    await this.sql.run('DELETE FROM cm_home_sightings WHERE home_id = ? AND object_id = ?', [key.homeId, objectId]);
    await this.sql.run(
      `UPDATE cm_home_episodes SET object_ids = (SELECT json_group_array(value) FROM json_each(cm_home_episodes.object_ids) WHERE value != ?)
       WHERE home_id = ? AND EXISTS (SELECT 1 FROM json_each(cm_home_episodes.object_ids) WHERE value = ?)`,
      [objectId, key.homeId, objectId],
    );
  }

  async addSighting(key: HomeKey, s: Omit<ObjectSighting, 'id'>): Promise<ObjectSighting> {
    const id = crypto.randomUUID();
    await this.sql.run(
      `INSERT INTO cm_home_sightings (id, home_id, object_id, place_id, at, prov_kind, prov_source, prov_sensor, prov_confidence, prov_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, key.homeId, s.objectId, s.placeId, s.at, ...provParams(s.provenance)],
    );
    return {id, ...structuredClone(s)};
  }
  async listSightings(key: HomeKey, objectId: string, options: {since?: number; limit?: number} = {}) {
    const rows = await this.sql.all<ProvCols & {id: string; object_id: string; place_id: string; at: number}>(
      `SELECT * FROM cm_home_sightings WHERE home_id = ? AND object_id = ? AND at >= ? ORDER BY at DESC, rowid DESC LIMIT ?`,
      [key.homeId, objectId, options.since ?? 0, options.limit ?? 200],
    );
    return rows.map(r => ({id: r.id, objectId: r.object_id, placeId: r.place_id, at: Number(r.at), provenance: toProvenance(r)}));
  }

  async addEpisode(key: HomeKey, e: Omit<Episode, 'id'>): Promise<Episode> {
    const id = crypto.randomUUID();
    await this.sql.run(
      `INSERT INTO cm_home_episodes (id, home_id, kind, label, summary, actor_ids, place_id, object_ids, started_at, ended_at,
         importance, prov_kind, prov_source, prov_sensor, prov_confidence, prov_at, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        key.homeId,
        e.kind,
        e.label,
        e.summary,
        JSON.stringify(e.actorIds),
        e.placeId ?? null,
        JSON.stringify(e.objectIds),
        e.startedAt,
        e.endedAt ?? null,
        e.importance,
        ...provParams(e.provenance),
        e.data ? JSON.stringify(e.data) : null,
      ],
    );
    return {id, ...structuredClone(e)};
  }
  async updateEpisode(key: HomeKey, episodeId: string, patch: Partial<Pick<Episode, 'endedAt' | 'summary' | 'importance' | 'data'>>) {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.endedAt !== undefined) sets.push('ended_at = ?'), params.push(patch.endedAt);
    if (patch.summary !== undefined) sets.push('summary = ?'), params.push(patch.summary);
    if (patch.importance !== undefined) sets.push('importance = ?'), params.push(patch.importance);
    if (patch.data !== undefined) sets.push('data_json = ?'), params.push(JSON.stringify(patch.data));
    if (!sets.length) return;
    params.push(key.homeId, episodeId);
    await this.sql.run(`UPDATE cm_home_episodes SET ${sets.join(', ')} WHERE home_id = ? AND id = ?`, params);
  }
  async queryEpisodes(key: HomeKey, q: EpisodeQuery): Promise<Episode[]> {
    const where = ['home_id = ?'];
    const params: unknown[] = [key.homeId];
    if (q.from != null) where.push('COALESCE(ended_at, started_at) >= ?'), params.push(q.from);
    if (q.to != null) where.push('started_at <= ?'), params.push(q.to);
    if (q.kinds?.length) where.push(`kind IN (${q.kinds.map(() => '?').join(', ')})`), params.push(...q.kinds);
    if (q.labels?.length) where.push(`label IN (${q.labels.map(() => '?').join(', ')})`), params.push(...q.labels);
    if (q.actorId) where.push('EXISTS (SELECT 1 FROM json_each(actor_ids) WHERE value = ?)'), params.push(q.actorId);
    if (q.placeId) where.push('place_id = ?'), params.push(q.placeId);
    if (q.objectId) where.push('EXISTS (SELECT 1 FROM json_each(object_ids) WHERE value = ?)'), params.push(q.objectId);
    if (q.text) where.push('instr(lower(summary), lower(?)) > 0'), params.push(q.text);
    const order = q.order === 'asc' ? 'ASC' : 'DESC';
    params.push(episodeLimit(q));
    const rows = await this.sql.all<EpisodeRow>(
      `SELECT * FROM cm_home_episodes WHERE ${where.join(' AND ')} ORDER BY started_at ${order}, rowid ${order} LIMIT ?`,
      params,
    );
    return rows.map(toEpisode);
  }

  async prune(key: HomeKey, options: {sightingsBefore?: number; episodesBefore?: number; keepImportanceAtLeast?: number}) {
    let sightings = 0;
    let episodes = 0;
    if (options.sightingsBefore != null) {
      sightings = (await this.sql.run('DELETE FROM cm_home_sightings WHERE home_id = ? AND at < ?', [key.homeId, options.sightingsBefore])).changes;
    }
    if (options.episodesBefore != null) {
      episodes = (
        await this.sql.run('DELETE FROM cm_home_episodes WHERE home_id = ? AND COALESCE(ended_at, started_at) < ? AND importance < ?', [
          key.homeId,
          options.episodesBefore,
          options.keepImportanceAtLeast ?? 1.01,
        ])
      ).changes;
    }
    return {sightings, episodes};
  }

  async forgetMember(key: HomeKey, memberId: string) {
    const h = key.homeId;
    await this.sql.run('DELETE FROM cm_home_members WHERE home_id = ? AND id = ?', [h, memberId]);
    await this.sql.run("DELETE FROM cm_home_sightings WHERE home_id = ? AND prov_kind = 'told' AND prov_source = ?", [h, memberId]);
    await this.sql.run(
      "DELETE FROM cm_home_episodes WHERE home_id = ? AND json_array_length(actor_ids) = 1 AND json_extract(actor_ids, '$[0]') = ?",
      [h, memberId],
    );
    await this.sql.run(
      `UPDATE cm_home_episodes SET actor_ids = (SELECT json_group_array(value) FROM json_each(cm_home_episodes.actor_ids) WHERE value != ?)
       WHERE home_id = ? AND EXISTS (SELECT 1 FROM json_each(cm_home_episodes.actor_ids) WHERE value = ?)`,
      [memberId, h, memberId],
    );
    await this.sql.run('UPDATE cm_home_episodes SET prov_source = NULL WHERE home_id = ? AND prov_source = ?', [h, memberId]);
    await this.sql.run('UPDATE cm_home_objects SET owner_id = NULL WHERE home_id = ? AND owner_id = ?', [h, memberId]);
  }

  async clearHome(key: HomeKey) {
    for (const table of ['cm_home_members', 'cm_home_places', 'cm_home_objects', 'cm_home_sightings', 'cm_home_episodes']) {
      await this.sql.run(`DELETE FROM ${table} WHERE home_id = ?`, [key.homeId]);
    }
  }
}
