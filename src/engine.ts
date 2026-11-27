import {findSupersededFacts} from './correction.js';
import {isDuplicateOfAny} from './dedup.js';
import {
  buildFactExtractionMessages,
  MAX_FACT_CHARS,
  normalizeFactContent,
  parseFactExtractionOutput,
  trimTurnsForExtract,
  type ExtractedFact,
} from './extract.js';
import type {LlmClient} from './llm.js';
import {extractRuleBasedPersonaFacts, isDurablePersonaFactContent, isTransientFactContent} from './quality.js';
import {buildMemoryPromptBlock, estimateUsageChars, getUsageLevel} from './recall.js';
import {
  addRelationshipNote,
  applyBond,
  applyUserTurn,
  initialRelationship,
  renderRelationshipPrompt,
  userTurnFingerprint,
} from './relationship.js';
import type {BeginExtractionResult, FactPatch, MemoryKey, MemoryStore} from './store.js';
import {emptyFacts, type ChatTurn, type Fact, type FactScope, type MemorySnapshot, type RelationshipState, type Role} from './types.js';

export type MemoryLimits = {
  /** Max stored facts per (user, agent). */
  maxFacts: number;
  maxPins: number;
  maxStoryChars: number;
  /** Prompt budget for the rendered memory block. */
  budgetChars: number;
  /** Max facts injected into the prompt (most recent first). Omit for all. */
  recallFactLimit?: number;
  maxNewFactsPerExtract: number;
  minExtractIntervalSec: number;
  extractInputChars: number;
  /** When true, only durable persona facts are saved (useful for a cheaper tier). */
  durablePersonaOnly: boolean;
  /** Which scopes extraction may write. */
  allowedScopes: FactScope[];
};

export const DEFAULT_LIMITS: MemoryLimits = {
  maxFacts: 80,
  maxPins: 10,
  maxStoryChars: 6_000,
  budgetChars: 32_000,
  maxNewFactsPerExtract: 6,
  minExtractIntervalSec: 20,
  extractInputChars: 12_000,
  durablePersonaOnly: false,
  allowedScopes: ['persona', 'character', 'side'],
};

export type ExtractResult =
  | {
      ok: true;
      added: Fact[];
      disabledIds: string[];
      skipped?: 'already_done' | 'no_candidates' | 'duplicate_only' | 'budget_full' | 'fact_limit';
    }
  | {ok: false; reason: Exclude<BeginExtractionResult, 'started' | 'already_done'> | 'nothing_to_extract' | 'error'; error?: string};

export type MemoryEngineOptions = {
  store: MemoryStore;
  /** Optional: without an LLM only the deterministic English rules run. */
  llm?: LlmClient;
  limits?: Partial<MemoryLimits>;
  /**
   * Persona facts saved under this agentId are shared with every agent of the same user
   * (e.g. "user is vegetarian" known by all characters, or all robots in one home).
   */
  sharedAgentId?: string;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
};

export function createMemoryEngine(options: MemoryEngineOptions) {
  const {store, llm} = options;
  const limits: MemoryLimits = {...DEFAULT_LIMITS, ...options.limits};
  const sharedAgentId = options.sharedAgentId ?? '__shared__';
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const logger = options.logger ?? console;

  async function snapshot(key: MemoryKey): Promise<MemorySnapshot> {
    const [story, pins, facts, shared] = await Promise.all([
      store.getStory(key),
      store.listPins(key),
      store.listFacts(key),
      key.agentId === sharedAgentId ? Promise.resolve([]) : store.listFacts({...key, agentId: sharedAgentId}),
    ]);
    const grouped = emptyFacts();
    const seen = new Set<string>();
    for (const fact of [...shared.filter(f => f.scope === 'persona'), ...facts]) {
      if (fact.disabled) continue;
      const norm = normalizeFactContent(fact.content);
      if (seen.has(norm)) continue;
      seen.add(norm);
      grouped[fact.scope].push(fact);
    }
    const usedChars = estimateUsageChars({story, pins, facts: grouped, factLimit: limits.recallFactLimit});
    return {story, pins, facts: grouped, usage: {usedChars, budgetChars: limits.budgetChars}};
  }

  /** Memory (and optionally relationship) block to put in the system prompt. */
  async function buildPrompt(key: MemoryKey, opts: {includeRelationship?: boolean} = {}): Promise<string> {
    const snap = await snapshot(key);
    const memory = buildMemoryPromptBlock({...snap, factLimit: limits.recallFactLimit, budgetChars: limits.budgetChars});
    if (!opts.includeRelationship) return memory;
    const rel = await store.getRelationship(key);
    return rel ? `${renderRelationshipPrompt(rel)}\n\n${memory}` : memory;
  }

  /**
   * Extract durable facts from recent turns and store them.
   * Call after an assistant reply (fire-and-forget is fine); duplicate calls for the same turn are no-ops.
   */
  async function extract(input: {
    key: MemoryKey;
    characterName: string;
    userName?: string;
    turns: ChatTurn[];
    /** Monotonic user-turn counter for this conversation. */
    userTurn: number;
    threadId?: string;
  }): Promise<ExtractResult> {
    const {key} = input;
    const turns = trimTurnsForExtract(input.turns, limits.extractInputChars);
    if (input.userTurn <= 0 || !turns.some(t => t.role === 'user')) return {ok: false, reason: 'nothing_to_extract'};

    const before = await snapshot(key);
    if (getUsageLevel(before.usage) === 'full') return {ok: true, added: [], disabledIds: [], skipped: 'budget_full'};

    const gate = await store.beginExtraction(key, {
      turn: input.userTurn,
      ...(input.threadId ? {threadId: input.threadId} : {}),
      now: now(),
      minIntervalSec: limits.minExtractIntervalSec,
      staleAfterSec: 300,
    });
    if (gate === 'already_done') return {ok: true, added: [], disabledIds: [], skipped: 'already_done'};
    if (gate !== 'started') return {ok: false, reason: gate};

    try {
      const stored = await store.listFacts(key);
      const active = stored.filter(f => !f.disabled).map(f => f.content);

      let llmFacts: ExtractedFact[] = [];
      if (llm) {
        try {
          const raw = await llm.complete(
            buildFactExtractionMessages({
              characterName: input.characterName,
              ...(input.userName ? {userName: input.userName} : {}),
              existingFacts: active,
              turns,
              maxNewFacts: limits.maxNewFactsPerExtract,
            }),
            {temperature: 0.2, maxTokens: 700},
          );
          llmFacts = parseFactExtractionOutput(raw, limits.maxNewFactsPerExtract);
        } catch (error) {
          logger.warn('[companion-memory] LLM extraction failed; using rules only', error);
        }
      }

      const candidates: ExtractedFact[] = [];
      for (const fact of [...extractRuleBasedPersonaFacts(turns), ...llmFacts]) {
        if (!limits.allowedScopes.includes(fact.scope)) continue;
        if (isTransientFactContent(fact.content) || fact.content.length > MAX_FACT_CHARS) continue;
        if (limits.durablePersonaOnly && (fact.scope !== 'persona' || !isDurablePersonaFactContent(fact.content))) continue;
        if (isDuplicateOfAny(fact.content, candidates.map(c => c.content))) continue;
        candidates.push(fact);
      }

      const added: Fact[] = [];
      let count = stored.length;
      let hitLimit = false;
      for (const fact of candidates) {
        if (isDuplicateOfAny(fact.content, active)) continue;
        if (count >= limits.maxFacts) {
          hitLimit = true;
          break;
        }
        const row = await store.addFact(key, {
          scope: fact.scope,
          content: fact.content,
          source: 'auto',
          ...(fact.subjectName ? {subjectName: fact.subjectName} : {}),
        });
        added.push(row);
        active.push(row.content);
        count += 1;
      }

      const disabledIds = findSupersededFacts(stored, turns, new Set(added.map(f => f.id)));
      for (const id of disabledIds) await store.updateFact(key, id, {disabled: true});

      await store.finishExtraction(key, {turn: input.userTurn, ...(input.threadId ? {threadId: input.threadId} : {}), now: now()});
      if (added.length) return {ok: true, added, disabledIds};
      return {
        ok: true,
        added,
        disabledIds,
        skipped: hitLimit ? 'fact_limit' : candidates.length ? 'duplicate_only' : 'no_candidates',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.finishExtraction(key, {turn: input.userTurn, now: now(), error: message});
      return {ok: false, reason: 'error', error: message};
    }
  }

  async function relationship(key: MemoryKey): Promise<RelationshipState> {
    return (await store.getRelationship(key)) ?? initialRelationship(now());
  }

  /** Count the latest user turn toward familiarity. Idempotent for retries of the same turn. */
  async function recordUserTurn(key: MemoryKey, turns: ChatTurn[]): Promise<RelationshipState> {
    const current = await relationship(key);
    const fp = await userTurnFingerprint(turns);
    if (!fp) return current;
    const next = applyUserTurn(current, fp, now());
    if (next !== current) await store.saveRelationship(key, next);
    return next;
  }

  async function raiseBond(
    key: MemoryKey,
    bond: Partial<Pick<RelationshipState, 'trust' | 'attachment' | 'romance'>>,
    note?: string,
  ): Promise<RelationshipState> {
    let next = applyBond(await relationship(key), bond);
    if (note) next = addRelationshipNote(next, note);
    await store.saveRelationship(key, next);
    return next;
  }

  async function setStory(key: MemoryKey, body: string): Promise<void> {
    await store.setStory(key, body.slice(0, limits.maxStoryChars));
  }

  async function pin(key: MemoryKey, message: {role: Role; content: string}) {
    const pins = await store.listPins(key);
    if (pins.length >= limits.maxPins) throw new Error(`Pin limit reached (${limits.maxPins})`);
    return store.addPin(key, {role: message.role, content: message.content.slice(0, 2_000)});
  }

  async function addFact(key: MemoryKey, fact: {scope: FactScope; content: string; subjectName?: string}) {
    const content = fact.content.replace(/\s+/g, ' ').trim();
    if (!content || content.length > MAX_FACT_CHARS) throw new Error(`Fact must be 1–${MAX_FACT_CHARS} characters`);
    const facts = await store.listFacts(key);
    if (facts.length >= limits.maxFacts) throw new Error(`Fact limit reached (${limits.maxFacts})`);
    return store.addFact(key, {...fact, content, source: 'manual'});
  }

  return {
    limits,
    snapshot,
    buildPrompt,
    extract,
    relationship,
    recordUserTurn,
    raiseBond,
    setStory,
    pin,
    unpin: (key: MemoryKey, pinId: string) => store.removePin(key, pinId),
    addFact,
    updateFact: (key: MemoryKey, factId: string, patch: FactPatch) => store.updateFact(key, factId, patch),
    removeFact: (key: MemoryKey, factId: string) => store.removeFact(key, factId),
    clear: (key: MemoryKey) => store.clear(key),
  };
}

export type MemoryEngine = ReturnType<typeof createMemoryEngine>;
