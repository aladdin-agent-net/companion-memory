export type Role = 'user' | 'assistant';

export type ChatTurn = {role: Role; content: string};

/** LLM message shape (OpenAI-compatible). */
export type LlmMessage = {role: 'system' | 'user' | 'assistant'; content: string};

export const FACT_SCOPES = ['persona', 'character', 'side'] as const;
/**
 * - persona: facts about the user
 * - character: facts about the AI character established during chat
 * - side: facts about named side characters (`subjectName` holds the name)
 */
export type FactScope = (typeof FACT_SCOPES)[number];

export type Fact = {
  id: string;
  scope: FactScope;
  subjectName?: string;
  content: string;
  /** `auto` = extracted from chat, `manual` = written by the user. Manual facts are never auto-disabled. */
  source: 'auto' | 'manual';
  disabled: boolean;
  /** Unix seconds. */
  updatedAt: number;
};

export type NewFact = {
  scope: FactScope;
  content: string;
  subjectName?: string;
  source: 'auto' | 'manual';
};

/** A chat message the user pinned verbatim. */
export type Pin = {
  id: string;
  role: Role;
  content: string;
  /** Unix seconds. */
  createdAt: number;
};

export type FactsByScope = Record<FactScope, Fact[]>;

export type MemorySnapshot = {
  /** User-authored long-form memory ("story so far"). */
  story: string;
  pins: Pin[];
  facts: FactsByScope;
  usage: {usedChars: number; budgetChars: number};
};

export type RelationshipStage = 'first_conversations' | 'early' | 'familiar' | 'close' | 'long_term';

export type RelationshipState = {
  /** 0–100, grows with interactions. */
  familiarity: number;
  interactionCount: number;
  /** 0–100 each. */
  trust: number;
  attachment: number;
  romance: number;
  stage: RelationshipStage;
  notes: string[];
  /** Unix seconds. */
  lastInteractionAt: number;
  /** Fingerprint of the last counted user turn, so retries do not double count. */
  lastUserTurnFingerprint?: string;
};

export function emptyFacts(): FactsByScope {
  return {persona: [], character: [], side: []};
}
