import {FACT_SCOPES, type ChatTurn, type FactScope, type LlmMessage} from './types.js';

export type ExtractedFact = {
  scope: FactScope;
  content: string;
  subjectName?: string;
};

export const MAX_FACT_CHARS = 400;

/** Keep the most recent turns that fit within `charBudget`. */
export function trimTurnsForExtract(turns: ChatTurn[], charBudget = 12_000): ChatTurn[] {
  const nonEmpty = turns.filter(t => t.content.trim());
  let total = 0;
  const out: ChatTurn[] = [];
  for (let i = nonEmpty.length - 1; i >= 0; i--) {
    const turn = nonEmpty[i]!;
    if (total + turn.content.length > charBudget) break;
    total += turn.content.length;
    out.unshift(turn);
  }
  return out;
}

export function buildFactExtractionMessages(input: {
  characterName: string;
  userName?: string;
  existingFacts: string[];
  turns: ChatTurn[];
  maxNewFacts: number;
}): LlmMessage[] {
  const userLabel = input.userName?.trim() || 'User';
  const transcript = input.turns
    .map(t => `${t.role === 'user' ? userLabel : input.characterName}: ${t.content.trim()}`)
    .join('\n');
  const existing = input.existingFacts.length ? input.existingFacts.map(f => `- ${f}`).join('\n') : 'None.';

  const system = `You extract durable Facts for long-term roleplay memory.
Output ONLY JSON (no markdown fences):
{"facts":[{"scope":"persona"|"character"|"side","content":string,"subjectName":string?}]}

Scopes:
- persona: facts about ${userLabel} (name, job, preferences, feelings they shared).
- character: new facts about ${input.characterName} established in chat (not generic persona fluff).
- side: named side characters who appeared; set subjectName to their name.

Priority (persist these when clearly stated):
- Name / nickname, birthday, location, occupation, school, hobbies, likes/dislikes, family/pets, important preferences, explicit promises, other stable personal facts.
- Relationship shifts: when the user clearly states new trust, closeness, or bond with ${input.characterName}, store as persona (user's stance toward the character).
- Corrections: if the user says something changed ("I no longer ..."), output the new state.

Never extract:
- Filler ("lol", "ok"), momentary mood ("I'm tired today"), reactions ("that was funny"), vague small talk.

Rules:
- Use only information clearly stated in the NEW transcript.
- Skip anything already in EXISTING FACTS unless it changed.
- Each content is one short sentence, third person, max 30 words.
- Return at most ${input.maxNewFacts} facts; use [] if nothing durable.
- Match the language the user writes in.`;

  return [
    {role: 'system', content: system},
    {role: 'user', content: `EXISTING FACTS:\n${existing}\n\nNEW TRANSCRIPT:\n${transcript}`},
  ];
}

function asScope(value: unknown): FactScope | null {
  return typeof value === 'string' && (FACT_SCOPES as readonly string[]).includes(value) ?
      (value as FactScope)
    : null;
}

/** Tolerant parser: accepts surrounding prose or code fences, drops malformed items. */
export function parseFactExtractionOutput(raw: string, maxFacts = 10): ExtractedFact[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const facts = (parsed as {facts?: unknown} | null)?.facts;
  if (!Array.isArray(facts)) return [];

  const out: ExtractedFact[] = [];
  for (const item of facts) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const scope = asScope(record.scope);
    const content = typeof record.content === 'string' ? record.content.replace(/\s+/g, ' ').trim() : '';
    if (!scope || !content || content.length > MAX_FACT_CHARS) continue;
    const subjectName =
      typeof record.subjectName === 'string' ? record.subjectName.trim().slice(0, 80) : undefined;
    out.push({scope, content, ...(subjectName ? {subjectName} : {})});
    if (out.length >= maxFacts) break;
  }
  return out;
}

export function normalizeFactContent(content: string): string {
  return content.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
