import type {Fact, FactScope, NewFact, Pin, RelationshipState, Role} from './types.js';

/**
 * Memory is partitioned by (userId, agentId). `agentId` is whatever the user talks to:
 * a chat character, an assistant persona, or a physical robot.
 */
export type MemoryKey = {userId: string; agentId: string};

export type FactPatch = Partial<{content: string; disabled: boolean; scope: FactScope; subjectName: string | null}>;

export type BeginExtractionResult = 'started' | 'already_done' | 'busy' | 'rate_limited';

export type ExtractionState = {
  status: 'idle' | 'running' | 'ok' | 'error';
  lastTurn: number;
  lastThreadId: string | null;
  /** Unix seconds of the last successful extraction. */
  lastExtractedAt: number;
  /** Unix seconds of the last status change. */
  updatedAt: number;
};

export type BeginExtractionArgs = {
  turn: number;
  threadId?: string;
  now: number;
  minIntervalSec: number;
  /** A `running` lock older than this is treated as crashed and can be taken over. */
  staleAfterSec: number;
};

export interface MemoryStore {
  getStory(key: MemoryKey): Promise<string>;
  setStory(key: MemoryKey, body: string): Promise<void>;

  listPins(key: MemoryKey): Promise<Pin[]>;
  addPin(key: MemoryKey, pin: {role: Role; content: string}): Promise<Pin>;
  removePin(key: MemoryKey, pinId: string): Promise<void>;

  listFacts(key: MemoryKey): Promise<Fact[]>;
  addFact(key: MemoryKey, fact: NewFact): Promise<Fact>;
  updateFact(key: MemoryKey, factId: string, patch: FactPatch): Promise<void>;
  removeFact(key: MemoryKey, factId: string): Promise<void>;

  getRelationship(key: MemoryKey): Promise<RelationshipState | null>;
  saveRelationship(key: MemoryKey, state: RelationshipState): Promise<void>;

  /** Must be atomic: two concurrent callers for the same key cannot both get `started`. */
  beginExtraction(key: MemoryKey, args: BeginExtractionArgs): Promise<BeginExtractionResult>;
  finishExtraction(
    key: MemoryKey,
    args: {turn: number; threadId?: string; now: number; error?: string},
  ): Promise<void>;

  /** Delete story, pins, facts, relationship and extraction state for this key. */
  clear(key: MemoryKey): Promise<void>;
}

/**
 * Shared gate policy so every store behaves the same:
 * - same turn already extracted (in the same thread) → already_done
 * - a fresh `running` lock exists → busy
 * - last success was less than `minIntervalSec` ago (same thread) → rate_limited (errors may retry at once)
 */
export function decideExtraction(state: ExtractionState | null, args: BeginExtractionArgs): BeginExtractionResult {
  if (!state) return 'started';
  const sameThread = !args.threadId || state.lastThreadId === args.threadId;
  if (sameThread && state.status === 'ok' && state.lastTurn >= args.turn) return 'already_done';
  if (state.status === 'running' && state.updatedAt > args.now - args.staleAfterSec) return 'busy';
  if (sameThread && state.status === 'ok' && state.lastExtractedAt > args.now - args.minIntervalSec) {
    return 'rate_limited';
  }
  return 'started';
}
