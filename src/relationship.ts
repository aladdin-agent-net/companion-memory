import type {ChatTurn, RelationshipStage, RelationshipState} from './types.js';

export function familiarityToStage(familiarity: number, interactionCount: number): RelationshipStage {
  if (interactionCount <= 0 && familiarity <= 0) return 'first_conversations';
  if (familiarity >= 100) return 'long_term';
  if (familiarity >= 31) return 'close';
  if (familiarity >= 11) return 'familiar';
  return 'early';
}

export function describeStage(stage: RelationshipStage): string {
  switch (stage) {
    case 'first_conversations':
      return 'first conversations (warm and curious, not distant)';
    case 'early':
      return 'early (getting to know each other)';
    case 'familiar':
      return 'familiar (you have talked before)';
    case 'close':
      return 'close (comfortable and familiar)';
    case 'long_term':
      return 'long-term (you know each other well; skip re-introductions)';
  }
}

export function clampAttr(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Warmth signal (0–100) derived from romance and attachment. */
export function computeAffection(state: Pick<RelationshipState, 'romance' | 'attachment'>): number {
  return Math.round(clampAttr(state.romance) * 0.6 + clampAttr(state.attachment) * 0.4);
}

export function initialRelationship(now: number): RelationshipState {
  return {
    familiarity: 0,
    interactionCount: 0,
    trust: 0,
    attachment: 0,
    romance: 0,
    stage: 'first_conversations',
    notes: [],
    lastInteractionAt: now,
  };
}

/**
 * Count one user turn. Idempotent per fingerprint, so a client retry of the same turn is not counted twice.
 * Familiarity grows 4 points per interaction and never decreases.
 */
export function applyUserTurn(state: RelationshipState, fingerprint: string, now: number): RelationshipState {
  if (state.lastUserTurnFingerprint === fingerprint) return state;
  const interactionCount = state.interactionCount + 1;
  const familiarity = Math.min(100, Math.max(state.familiarity, interactionCount * 4));
  return {
    ...state,
    interactionCount,
    familiarity,
    stage: familiarityToStage(familiarity, interactionCount),
    lastInteractionAt: now,
    lastUserTurnFingerprint: fingerprint,
  };
}

/** Raise trust / attachment / romance (e.g. from a story beat). Values only ratchet up. */
export function applyBond(
  state: RelationshipState,
  bond: Partial<Pick<RelationshipState, 'trust' | 'attachment' | 'romance'>>,
): RelationshipState {
  return {
    ...state,
    trust: Math.max(state.trust, clampAttr(bond.trust ?? 0)),
    attachment: Math.max(state.attachment, clampAttr(bond.attachment ?? 0)),
    romance: Math.max(state.romance, clampAttr(bond.romance ?? 0)),
  };
}

export function addRelationshipNote(state: RelationshipState, note: string, maxNotes = 4): RelationshipState {
  const t = note.trim().slice(0, 200);
  if (!t || state.notes.some(n => n.toLowerCase() === t.toLowerCase())) return state;
  return {...state, notes: [...state.notes, t].slice(-maxNotes)};
}

/** Whether the prompt should include a first-meeting / greeting block. */
export function isFirstConversation(state: RelationshipState | null, userTurnsInThread: number): boolean {
  if (userTurnsInThread > 2) return false;
  return state ? state.interactionCount === 0 : true;
}

export function renderRelationshipPrompt(state: RelationshipState): string {
  const lines = [`RELATIONSHIP: ${describeStage(state.stage)}; ${state.interactionCount} interactions so far.`];
  const affection = computeAffection(state);
  if (state.trust || affection) lines.push(`Trust ${state.trust}/100, affection ${affection}/100.`);
  for (const note of state.notes) lines.push(`- ${note}`);
  return lines.join('\n');
}

/** Stable hash of (user turn count, last user message) for idempotent turn counting. */
export async function userTurnFingerprint(turns: ChatTurn[]): Promise<string | null> {
  const users = turns.filter(t => t.role === 'user');
  const last = users.at(-1);
  if (!last) return null;
  const payload = `${users.length}:${last.content.trim()}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
