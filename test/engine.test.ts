import {DatabaseSync} from 'node:sqlite';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  createMemoryEngine,
  fromNodeSqlite,
  InMemoryStore,
  SqlStore,
  type LlmClient,
  type MemoryStore,
} from '../src/index.js';

/** Fake LLM that returns a queued JSON response per call. */
function fakeLlm(responses: string[]): LlmClient & {calls: number} {
  const client = {
    calls: 0,
    async complete() {
      client.calls += 1;
      return responses.shift() ?? '{"facts":[]}';
    },
  };
  return client;
}

const facts = (...items: Array<[string, string, string?]>) =>
  JSON.stringify({facts: items.map(([scope, content, subjectName]) => ({scope, content, subjectName}))});

const key = {userId: 'u1', agentId: 'aria'};

const stores: Array<[string, (now: () => number) => Promise<MemoryStore>]> = [
  ['InMemoryStore', async now => new InMemoryStore({now})],
  [
    'SqlStore(node:sqlite)',
    async now => {
      const store = new SqlStore(fromNodeSqlite(new DatabaseSync(':memory:')), {now});
      await store.migrate();
      return store;
    },
  ],
];

describe.each(stores)('engine with %s', (_name, makeStore) => {
  let clock = 1_000;
  const now = () => clock;
  let store: MemoryStore;

  beforeEach(async () => {
    clock = 1_000;
    store = await makeStore(now);
  });

  it('extracts, dedups against existing memory and renders a prompt', async () => {
    const llm = fakeLlm([
      facts(['persona', 'User works as a nurse in Lyon.'], ['side', 'Max is the user’s old beagle.', 'Max']),
      facts(['persona', 'User works as a nurse in Lyon.'], ['character', 'Aria promised to teach the user chess.']),
    ]);
    const engine = createMemoryEngine({store, llm, now});
    const turns = [{role: 'user' as const, content: 'I work as a nurse in Lyon. My dog Max is old.'}];

    const first = await engine.extract({key, characterName: 'Aria', turns, userTurn: 1});
    expect(first.ok && first.added.map(f => f.content)).toEqual([
      'User works as nurse in Lyon.',
      'Max is the user’s old beagle.',
    ]);

    clock += 60;
    const second = await engine.extract({key, characterName: 'Aria', turns, userTurn: 2});
    expect(second.ok && second.added.map(f => f.content)).toEqual(['Aria promised to teach the user chess.']);

    const prompt = await engine.buildPrompt(key);
    expect(prompt).toContain('FACTS about the user');
    expect(prompt).toContain('- Max: Max is the user’s old beagle.');
    expect(prompt).toContain('Aria promised to teach the user chess.');
  });

  it('gates repeated and too-frequent extraction', async () => {
    const llm = fakeLlm([]);
    const engine = createMemoryEngine({store, llm, now});
    const turns = [{role: 'user' as const, content: 'hello there'}];

    expect(await engine.extract({key, characterName: 'Aria', turns, userTurn: 1})).toMatchObject({ok: true, skipped: 'no_candidates'});
    expect(await engine.extract({key, characterName: 'Aria', turns, userTurn: 1})).toMatchObject({skipped: 'already_done'});
    expect(await engine.extract({key, characterName: 'Aria', turns, userTurn: 2})).toEqual({ok: false, reason: 'rate_limited'});
    clock += 30;
    expect(await engine.extract({key, characterName: 'Aria', turns, userTurn: 2})).toMatchObject({ok: true});
    expect(llm.calls).toBe(2);
  });

  it('lets only one concurrent extraction run', async () => {
    const engine = createMemoryEngine({store, llm: fakeLlm([]), now});
    const turns = [{role: 'user' as const, content: 'hello there'}];
    const results = await Promise.all([
      engine.extract({key, characterName: 'Aria', turns, userTurn: 1}),
      engine.extract({key, characterName: 'Aria', turns, userTurn: 1}),
    ]);
    expect(results.filter(r => r.ok && !r.skipped?.startsWith('already')).length).toBe(1);
  });

  it('disables superseded auto facts when the user corrects themselves', async () => {
    const llm = fakeLlm([facts(['persona', 'User drinks black coffee every morning.'])]);
    const engine = createMemoryEngine({store, llm, now});
    await engine.extract({key, characterName: 'Aria', turns: [{role: 'user', content: 'I drink black coffee every morning.'}], userTurn: 1});

    clock += 60;
    const res = await engine.extract({
      key,
      characterName: 'Aria',
      turns: [{role: 'user', content: 'Update: I no longer drink coffee, doctor said so.'}],
      userTurn: 2,
    });
    expect(res.ok && res.disabledIds).toHaveLength(1);
    const prompt = await engine.buildPrompt(key);
    expect(prompt).not.toContain('black coffee');
  });

  it('works without an LLM using rules only, and respects durablePersonaOnly', async () => {
    const engine = createMemoryEngine({store, now, limits: {durablePersonaOnly: true}});
    const res = await engine.extract({
      key,
      characterName: 'Aria',
      turns: [{role: 'user', content: "My birthday is June 5. I'm so tired today."}],
      userTurn: 1,
    });
    expect(res.ok && res.added.map(f => f.content)).toEqual(["User's birthday is June 5."]);
  });

  it('stops at the fact limit', async () => {
    const llm = fakeLlm([facts(['persona', 'User likes tennis.'], ['persona', 'User lives in Oslo.'], ['persona', 'User has two sisters.'])]);
    const engine = createMemoryEngine({store, llm, now, limits: {maxFacts: 2}});
    const res = await engine.extract({key, characterName: 'Aria', turns: [{role: 'user', content: 'stuff'}], userTurn: 1});
    expect(res.ok && res.added).toHaveLength(2);
  });

  it('shares persona facts across agents via the shared agent id', async () => {
    const engine = createMemoryEngine({store, now});
    await engine.addFact({userId: 'u1', agentId: '__shared__'}, {scope: 'persona', content: 'User is vegetarian.'});
    await engine.addFact(key, {scope: 'persona', content: 'User calls Aria "A".'});
    const other = await engine.snapshot({userId: 'u1', agentId: 'kitchen-robot'});
    expect(other.facts.persona.map(f => f.content)).toEqual(['User is vegetarian.']);
    const mine = await engine.snapshot(key);
    expect(mine.facts.persona).toHaveLength(2);
  });

  it('tracks relationship turns idempotently and persists bonds', async () => {
    const engine = createMemoryEngine({store, now});
    const turns = [{role: 'user' as const, content: 'hi'}];
    await engine.recordUserTurn(key, turns);
    await engine.recordUserTurn(key, turns);
    const rel = await engine.recordUserTurn(key, [...turns, {role: 'assistant', content: 'hey'}, {role: 'user', content: 'how are you'}]);
    expect(rel.interactionCount).toBe(2);
    await engine.raiseBond(key, {trust: 40}, 'User shared a secret about their family.');
    expect(await engine.buildPrompt(key, {includeRelationship: true})).toContain('Trust 40/100');
  });

  it('manages story, pins and manual facts with limits', async () => {
    const engine = createMemoryEngine({store, now, limits: {maxPins: 1, maxStoryChars: 5}});
    await engine.setStory(key, 'abcdefgh');
    const pin = await engine.pin(key, {role: 'assistant', content: 'I will always remember the lake.'});
    await expect(engine.pin(key, {role: 'user', content: 'second'})).rejects.toThrow('Pin limit');
    const snap = await engine.snapshot(key);
    expect(snap.story).toBe('abcde');
    expect(snap.pins).toHaveLength(1);
    await engine.unpin(key, pin.id);
    const f = await engine.addFact(key, {scope: 'persona', content: '  User   is left-handed. '});
    expect(f.content).toBe('User is left-handed.');
    await engine.updateFact(key, f.id, {disabled: true});
    expect((await engine.snapshot(key)).facts.persona).toHaveLength(0);
    await engine.clear(key);
    expect((await engine.snapshot(key)).story).toBe('');
  });

  it('records an error state and allows an immediate retry after LLM-independent failure', async () => {
    const failing: MemoryStore = Object.create(store);
    let fail = true;
    failing.addFact = async (...args) => {
      if (fail) throw new Error('disk full');
      return store.addFact(...args);
    };
    const engine = createMemoryEngine({store: failing, now});
    const turns = [{role: 'user' as const, content: 'I live in Kyoto.'}];
    expect(await engine.extract({key, characterName: 'Aria', turns, userTurn: 1})).toEqual({ok: false, reason: 'error', error: 'disk full'});
    fail = false;
    const retry = await engine.extract({key, characterName: 'Aria', turns, userTurn: 1});
    expect(retry.ok && retry.added.map(f => f.content)).toEqual(['User lives in Kyoto.']);
  });
});
