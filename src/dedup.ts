import {normalizeFactContent} from './extract.js';

const STOPWORDS = new Set([
  'user', 'the', 'and', 'with', 'about', 'this', 'that', 'from', 'they', 'their',
  'have', 'has', 'only', 'very', 'really', 'enjoys', 'likes', 'loves',
]);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Significant tokens for near-duplicate detection.
 * Latin/Cyrillic etc.: words longer than 3 chars minus stopwords.
 * CJK runs: character bigrams (there are no spaces to split on).
 */
export function significantFactTokens(content: string): Set<string> {
  const norm = normalizeFactContent(content).replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = new Set<string>();
  for (const word of norm.split(/\s+/)) {
    if (!word) continue;
    if (CJK.test(word)) {
      const chars = [...word];
      if (chars.length === 1) tokens.add(word);
      for (let i = 0; i < chars.length - 1; i++) tokens.add(chars[i]! + chars[i + 1]!);
      continue;
    }
    if (word.length > 3 && !STOPWORDS.has(word)) tokens.add(word);
  }
  return tokens;
}

/** Light stemming so "collects" and "collecting" overlap. */
function stem(token: string): string {
  return token.replace(/(?:ing|ed|es|s)$/, '');
}

/**
 * True when two facts are equal after normalization, or share almost all significant tokens.
 * The threshold is conservative to avoid merging genuinely different facts.
 */
export function isNearDuplicateFactContent(a: string, b: string, threshold = 0.85): boolean {
  const na = normalizeFactContent(a);
  const nb = normalizeFactContent(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ta = new Set([...significantFactTokens(a)].map(stem));
  const tb = new Set([...significantFactTokens(b)].map(stem));
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / Math.min(ta.size, tb.size) >= threshold;
}

export function isDuplicateOfAny(content: string, existing: string[]): boolean {
  return existing.some(e => isNearDuplicateFactContent(content, e));
}
