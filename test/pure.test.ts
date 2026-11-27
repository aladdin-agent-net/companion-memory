import {describe, expect, it} from 'vitest';
import {
  buildMemoryPromptBlock,
  collectRevocationPhrases,
  emptyFacts,
  extractRuleBasedPersonaFacts,
  findSupersededFacts,
  getUsageLevel,
  isDurablePersonaFactContent,
  isNearDuplicateFactContent,
  isTransientFactContent,
  MEMORY_RULES,
  parseFactExtractionOutput,
  selectFactsForRecall,
  trimTurnsForExtract,
  type Fact,
} from '../src/index.js';

const fact = (over: Partial<Fact> & Pick<Fact, 'content'>): Fact => ({
  id: over.id ?? over.content,
  scope: 'persona',
  source: 'auto',
  disabled: false,
  updatedAt: 1,
  ...over,
});

describe('parseFactExtractionOutput', () => {
  it('parses JSON wrapped in prose or code fences', () => {
    const raw = 'Sure!\n```json\n{"facts":[{"scope":"persona","content":"User is a nurse."},{"scope":"side","content":"Max is a dog.","subjectName":"Max"}]}\n```';
    expect(parseFactExtractionOutput(raw)).toEqual([
      {scope: 'persona', content: 'User is a nurse.'},
      {scope: 'side', content: 'Max is a dog.', subjectName: 'Max'},
    ]);
  });

  it('drops invalid scopes, empty content and broken JSON', () => {
    expect(parseFactExtractionOutput('{"facts":[{"scope":"world","content":"x"},{"scope":"persona","content":"  "}]}')).toEqual([]);
    expect(parseFactExtractionOutput('{"facts": [')).toEqual([]);
    expect(parseFactExtractionOutput('no json')).toEqual([]);
  });

  it('caps the number of facts', () => {
    const facts = Array.from({length: 10}, (_, i) => ({scope: 'persona', content: `Fact number ${i}.`}));
    expect(parseFactExtractionOutput(JSON.stringify({facts}), 3)).toHaveLength(3);
  });
});

describe('trimTurnsForExtract', () => {
  it('keeps the most recent turns within budget', () => {
    const turns = [
      {role: 'user' as const, content: 'a'.repeat(50)},
      {role: 'assistant' as const, content: 'b'.repeat(50)},
      {role: 'user' as const, content: 'c'.repeat(50)},
    ];
    expect(trimTurnsForExtract(turns, 120).map(t => t.content[0])).toEqual(['b', 'c']);
  });
});

describe('fact quality', () => {
  it('flags chat noise as transient', () => {
    expect(isTransientFactContent('lol')).toBe(true);
    expect(isTransientFactContent("I'm so tired today")).toBe(true);
    expect(isTransientFactContent('User works as a nurse in Lyon.')).toBe(false);
  });

  it('recognizes durable persona facts, including non-Latin text', () => {
    expect(isDurablePersonaFactContent('User is allergic to peanuts.')).toBe(true);
    expect(isDurablePersonaFactContent('User mentioned the weather.')).toBe(false);
    expect(isDurablePersonaFactContent('用户对花生过敏。')).toBe(true);
  });

  it('extracts common persona facts with deterministic rules', () => {
    const facts = extractRuleBasedPersonaFacts([
      {role: 'user', content: 'My birthday is March 3. I work as a nurse. My cat is named Miso.'},
      {role: 'assistant', content: 'I love jazz too.'},
      {role: 'user', content: 'I hate cilantro!'},
    ]);
    expect(facts.map(f => f.content)).toEqual([
      "User's birthday is March 3.",
      'User works as nurse.',
      "User's cat is named Miso.",
      'User dislikes cilantro.',
    ]);
  });

  it('extracts names at sentence start but not lowercase phrases', () => {
    const facts = extractRuleBasedPersonaFacts([{role: 'user', content: 'My name is Sam. Just call me maybe.'}]);
    expect(facts.map(f => f.content)).toEqual(["User's name is Sam."]);
  });
});

describe('dedup', () => {
  it('treats paraphrases as duplicates and keeps distinct facts', () => {
    expect(isNearDuplicateFactContent('User collects vinyl records.', 'User enjoys collecting vinyl records.')).toBe(true);
    expect(isNearDuplicateFactContent('User collects vinyl records.', 'User works as a marine biologist.')).toBe(false);
  });

  it('handles CJK text with bigrams', () => {
    expect(isNearDuplicateFactContent('用户喜欢喝乌龙茶', '用户喜欢喝乌龙茶。')).toBe(true);
    expect(isNearDuplicateFactContent('用户喜欢喝乌龙茶', '用户在上海做护士')).toBe(false);
  });
});

describe('corrections', () => {
  const turns = [{role: 'user' as const, content: "Heads up: I no longer drink coffee. I quit smoking too."}];

  it('collects revocation phrases', () => {
    expect(collectRevocationPhrases(turns)).toEqual(['drink coffee', 'smoking too']);
  });

  it('disables only superseded auto facts', () => {
    const facts = [
      fact({id: 'a', content: 'User drinks black coffee every morning.'}),
      fact({id: 'b', content: 'User drinks coffee daily.', source: 'manual'}),
      fact({id: 'c', content: 'User enjoys hiking.'}),
      fact({id: 'd', content: 'User no longer drinks coffee.'}),
      fact({id: 'e', content: 'User smokes after dinner.'}),
    ];
    expect(findSupersededFacts(facts, turns)).toEqual(['a', 'e']);
  });
});

describe('recall', () => {
  it('keeps the most recent facts when limited', () => {
    const facts = emptyFacts();
    facts.persona = [fact({content: 'old', updatedAt: 1}), fact({content: 'new', updatedAt: 3})];
    facts.side = [fact({content: 'mid', scope: 'side', updatedAt: 2})];
    const r = selectFactsForRecall(facts, 2);
    expect(r.persona.map(f => f.content)).toEqual(['new']);
    expect(r.side.map(f => f.content)).toEqual(['mid']);
  });

  it('renders sections and always appends the anti-hallucination rules', () => {
    const facts = emptyFacts();
    facts.persona = [fact({content: 'User is a nurse.'})];
    facts.side = [fact({content: 'A loyal dog.', scope: 'side', subjectName: 'Max'})];
    const block = buildMemoryPromptBlock({story: 'We met in Paris.', pins: [], facts});
    expect(block).toContain('STORY MEMORY');
    expect(block).toContain('- User is a nurse.');
    expect(block).toContain('- Max: A loyal dog.');
    expect(block.endsWith(MEMORY_RULES)).toBe(true);
    expect(buildMemoryPromptBlock({story: '', pins: [], facts: emptyFacts()})).toBe(MEMORY_RULES);
  });

  it('stays within budget and keeps user facts longest', () => {
    const facts = emptyFacts();
    facts.persona = [fact({content: 'User is allergic to peanuts.', updatedAt: 5})];
    facts.character = Array.from({length: 30}, (_, i) =>
      fact({id: `c${i}`, scope: 'character', content: `Character detail number ${i} that is fairly long.`}),
    );
    const pins = Array.from({length: 5}, (_, i) => ({id: `p${i}`, role: 'user' as const, content: 'x'.repeat(200), createdAt: 1}));
    const block = buildMemoryPromptBlock({story: 's'.repeat(2000), pins, facts, budgetChars: 1200});
    expect(block.length).toBeLessThanOrEqual(1200);
    expect(block).toContain('allergic to peanuts');
  });

  it('reports usage level', () => {
    expect(getUsageLevel({usedChars: 10, budgetChars: 100})).toBe('ok');
    expect(getUsageLevel({usedChars: 85, budgetChars: 100})).toBe('warning');
    expect(getUsageLevel({usedChars: 100, budgetChars: 100})).toBe('full');
  });
});
