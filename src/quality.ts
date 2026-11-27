import type {ExtractedFact} from './extract.js';
import type {ChatTurn} from './types.js';

/** Short-lived chat noise that should never become a long-term fact. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /^\s*(lol|lmao|haha|ok|okay|k|yeah|yep|nope|sure|thanks|thank you|ty)\s*[.!?]*\s*$/i,
  /\bi(?:'m| am) (?:so )?(?:tired|sleepy|bored|hungry) today\b/i,
  /\bthat was (?:so )?(?:funny|hilarious|wild)\b/i,
  /\bi feel (?:a little |kind of )?(?:tired|sad|meh)\b/i,
  /\bjust (?:chilling|vibing|hanging out)\b/i,
];

/** High-confidence durable persona signals (English). */
const DURABLE_PERSONA_PATTERNS: RegExp[] = [
  /\bbirthday\b/i,
  /\b(?:name is|call me|nickname)\b/i,
  /\b(?:work|works|study|studies) (?:as|at)\b/i,
  /\b(?:is|am|'m) an? \w+/i,
  /\b(?:love|loves|like|likes|enjoy|enjoys|hate|hates|dislike|dislikes|prefer|prefers|can't stand)\b/i,
  /\b(?:dog|cat|pet|mom|dad|mother|father|sister|brother|wife|husband|partner|son|daughter)\b/i,
  /\b(?:lives? in|from)\b/i,
  /\bpromised?\b/i,
  /\b(?:school|university|college|occupation|job)\b/i,
  /\ballergic\b/i,
];

export function isTransientFactContent(content: string): boolean {
  const t = content.trim();
  if (t.length < 4) return true;
  return TRANSIENT_PATTERNS.some(re => re.test(t));
}

/**
 * Conservative check used when only durable persona facts are allowed (e.g. a free tier).
 * Non-Latin text is accepted as long as it is not transient, since the patterns are English-only.
 */
export function isDurablePersonaFactContent(content: string): boolean {
  const t = content.trim();
  if (t.length < 6 || isTransientFactContent(t)) return false;
  if (!/[a-z]/i.test(t)) return true;
  return DURABLE_PERSONA_PATTERNS.some(re => re.test(t));
}

type Rule = {pattern: RegExp; render: (value: string) => string};

const clean = (value: string) => value.trim().replace(/\s+/g, ' ').replace(/[,;:]+$/, '');

/** Deterministic English rules that back up the LLM for the most common persona facts. */
const RULES: Rule[] = [
  {
    pattern: /\b(?:my birthday is|i was born on)\s+([^.!?\n]{3,48})/i,
    render: v => `User's birthday is ${clean(v)}.`,
  },
  // Case-sensitive on the name itself so "call me maybe" does not become a name.
  {pattern: /\b(?:[Mm]y name is|[Cc]all me)\s+([A-Z][\w'-]{1,30})/, render: v => `User's name is ${clean(v)}.`},
  {pattern: /\bi hate\s+([^.!?\n]{3,80})/i, render: v => `User dislikes ${clean(v)}.`},
  {pattern: /\bi (?:love|really like)\s+([^.!?\n]{3,80})/i, render: v => `User likes ${clean(v)}.`},
  {pattern: /\bi prefer\s+([^.!?\n]{3,80})/i, render: v => `User prefers ${clean(v)}.`},
  {pattern: /\bi(?:'m| am) allergic to\s+([^.!?\n]{3,60})/i, render: v => `User is allergic to ${clean(v)}.`},
  {pattern: /\bi work as (?:an? )?([^.!?\n]{3,60})/i, render: v => `User works as ${clean(v)}.`},
  {pattern: /\bi live in\s+([^.!?\n]{2,60})/i, render: v => `User lives in ${clean(v)}.`},
  {
    pattern: /\bmy (dog|cat|pet)(?: is)? (?:called|named)\s+([A-Za-z][\w-]{0,24})/i,
    render: v => v,
  },
];

export function extractRuleBasedPersonaFacts(turns: ChatTurn[]): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  const seen = new Set<string>();
  const push = (content: string) => {
    const key = content.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({scope: 'persona', content});
  };

  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const text = turn.content.trim();
    if (!text) continue;
    for (const rule of RULES) {
      const match = text.match(rule.pattern);
      if (!match?.[1]) continue;
      if (match[2]) {
        push(`User's ${match[1].toLowerCase()} is named ${match[2]}.`);
      } else {
        push(rule.render(match[1]));
      }
    }
  }
  return out;
}
