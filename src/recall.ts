import type {Fact, FactsByScope, Pin} from './types.js';

/** Appended to every memory block so the model does not invent history it was never given. */
export const MEMORY_RULES = `MEMORY RULES:
- Only treat Story, Pins, and Facts above as stored memory. Never claim you "remember" something unless it is written there.
- If asked about a person, pet, or detail not covered above, say briefly that you do not know. Do not invent past events or preferences.`;

/** Keep the `limit` most recently updated active facts, preserving scope grouping. */
export function selectFactsForRecall(facts: FactsByScope, limit?: number): FactsByScope {
  const active: Fact[] = [...facts.persona, ...facts.character, ...facts.side].filter(f => !f.disabled);
  active.sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = new Set(active.slice(0, limit ?? active.length).map(f => f.id));
  return {
    persona: facts.persona.filter(f => kept.has(f.id)),
    character: facts.character.filter(f => kept.has(f.id)),
    side: facts.side.filter(f => kept.has(f.id)),
  };
}

function formatFacts(title: string, facts: Fact[]): string {
  const active = facts.filter(f => !f.disabled);
  if (!active.length) return '';
  const lines = active.map(f => `- ${f.scope === 'side' && f.subjectName ? `${f.subjectName}: ` : ''}${f.content}`);
  return `${title}:\n${lines.join('\n')}`;
}

function truncate(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return maxChars <= 1 ? '' : `${t.slice(0, maxChars - 1)}…`;
}

export type RecallInput = {
  story: string;
  pins: Pin[];
  facts: FactsByScope;
  /** Max facts recalled (most recent first). Omit for all. */
  factLimit?: number;
};

function sections(input: RecallInput & {storyMaxChars?: number; maxPins?: number}): string[] {
  const out: string[] = [];
  const story = input.story.trim();
  if (story) {
    const body = input.storyMaxChars != null ? truncate(story, input.storyMaxChars) : story;
    out.push(`STORY MEMORY (user-authored, treat as canon):\n${body}`);
  }
  const pins = input.pins.slice(0, Math.max(0, input.maxPins ?? input.pins.length));
  if (pins.length) {
    const lines = pins.map(p => `- [${p.role === 'user' ? 'User' : 'Character'}] ${p.content}`);
    out.push(`PINNED MESSAGES (exact wording, canon):\n${lines.join('\n')}`);
  }
  const recalled = selectFactsForRecall(input.facts, input.factLimit);
  for (const block of [
    formatFacts('FACTS about the user', recalled.persona),
    formatFacts('FACTS about this character', recalled.character),
    formatFacts('FACTS about side characters', recalled.side),
  ]) {
    if (block) out.push(block);
  }
  return out;
}

/**
 * Render memory for the system prompt within `budgetChars`.
 * Degrades in order: fewer pins → fewer facts (user facts kept longest) → story only.
 */
export function buildMemoryPromptBlock(input: RecallInput & {budgetChars?: number}): string {
  const withRules = (body: string) => (body.trim() ? `${body.trim()}\n\n${MEMORY_RULES}` : MEMORY_RULES);
  const budget = input.budgetChars;
  if (!budget || budget <= 0) return withRules(sections(input).join('\n\n'));

  const contentBudget = Math.max(0, budget - MEMORY_RULES.length - 2);
  const storyLen = input.story.trim().length;
  let storyCap = Math.min(storyLen, Math.floor(contentBudget * 0.45));
  if (storyCap < 80 && storyLen) storyCap = Math.min(storyLen, contentBudget);
  const storyMaxChars = storyCap > 0 ? storyCap : undefined;

  for (let pins = input.pins.length; pins >= 0; pins--) {
    const block = sections({...input, storyMaxChars, maxPins: pins}).join('\n\n');
    if (block.length <= contentBudget) return withRules(block);
  }

  const r = selectFactsForRecall(input.facts, input.factLimit);
  const fallbacks: FactsByScope[] = [
    {persona: r.persona, character: r.character, side: []},
    {persona: r.persona, character: [], side: []},
    {persona: r.persona.slice(0, Math.max(1, Math.ceil(r.persona.length / 2))), character: [], side: []},
    {persona: r.persona.slice(0, 1), character: [], side: []},
    {persona: [], character: [], side: []},
  ];
  for (const facts of fallbacks) {
    const block = sections({
      story: input.story,
      pins: input.pins,
      facts,
      storyMaxChars: Math.min(storyCap || 200, 400),
      maxPins: 1,
    }).join('\n\n');
    if (block.length <= contentBudget) return withRules(block);
  }

  const storyOnly = sections({
    story: input.story,
    pins: [],
    facts: {persona: [], character: [], side: []},
    storyMaxChars: Math.max(0, Math.min(contentBudget - 40, 300)),
  }).join('\n\n');
  return withRules(storyOnly.slice(0, contentBudget));
}

/** Approximate characters the memory block will consume (for budget meters). */
export function estimateUsageChars(input: RecallInput): number {
  let n = input.story.length;
  for (const p of input.pins) n += p.content.length + 16;
  const recalled = selectFactsForRecall(input.facts, input.factLimit);
  for (const f of [...recalled.persona, ...recalled.character, ...recalled.side]) n += f.content.length + 24;
  return n;
}

export type UsageLevel = 'ok' | 'warning' | 'full';

export function getUsageLevel(usage: {usedChars: number; budgetChars: number}, warnRatio = 0.8): UsageLevel {
  if (usage.budgetChars <= 0) return 'ok';
  const ratio = usage.usedChars / usage.budgetChars;
  return ratio >= 1 ? 'full' : ratio >= warnRatio ? 'warning' : 'ok';
}
