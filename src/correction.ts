import type {ChatTurn, Fact} from './types.js';

/** Phrases where the user revokes something previously true. Capture group = what was revoked. */
const REVOKE_PATTERNS: RegExp[] = [
  /\bno longer\s+([^.;!?\n]{2,80})/gi,
  /\b(?:don't|do not|doesn't|does not)\s+((?:drink|eat|smoke|use|play|like|work)\s+[^.;!?\n]{2,60})\s+any\s?more\b/gi,
  /\bi (?:quit|stopped|gave up)\s+([^.;!?\n]{2,60})/gi,
  /\bnot\s+([^.;!?\n]{2,60})\s+any\s?more\b/gi,
];

const KEYWORD_STOPWORDS = new Set(['anymore', 'any', 'more', 'really', 'very', 'that', 'this', 'with']);

function keywords(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !KEYWORD_STOPWORDS.has(w))
    .map(w => w.replace(/(?:ing|s)$/, ''));
}

export function collectRevocationPhrases(turns: ChatTurn[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    for (const pattern of REVOKE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of turn.content.matchAll(pattern)) {
        const phrase = match[1]?.trim();
        if (phrase) out.push(phrase);
      }
    }
  }
  return out;
}

/**
 * A fact is superseded when it contains the revoked phrase's keywords
 * (all of them for 1 keyword, at least 2 otherwise) and does not itself state the revocation.
 */
export function isFactRevokedBy(factContent: string, phrase: string): boolean {
  const hay = factContent.toLowerCase();
  if (/\b(?:no longer|quit|stopped|any\s?more)\b/.test(hay)) return false;
  const keys = keywords(phrase);
  if (!keys.length) return false;
  const hits = keys.filter(k => hay.includes(k)).length;
  return hits >= Math.min(2, keys.length);
}

/**
 * Returns ids of older auto-extracted facts that the user's latest turns explicitly revoked.
 * Manual facts and facts created in this batch are never returned.
 */
export function findSupersededFacts(facts: Fact[], turns: ChatTurn[], excludeIds: Set<string> = new Set()): string[] {
  const phrases = collectRevocationPhrases(turns);
  if (!phrases.length) return [];
  return facts
    .filter(f => !f.disabled && f.source === 'auto' && !excludeIds.has(f.id))
    .filter(f => phrases.some(p => isFactRevokedBy(f.content, p)))
    .map(f => f.id);
}
