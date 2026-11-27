/**
 * Run: npm run example
 * With a real model (any OpenAI-compatible server):
 *   LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen2.5:7b npm run example
 *   LLM_BASE_URL=https://api.openai.com/v1 LLM_MODEL=gpt-4o-mini LLM_API_KEY=... npm run example
 * Without LLM_BASE_URL a scripted fake model is used, so the example runs offline.
 */
import {DatabaseSync} from 'node:sqlite';
import {createMemoryEngine, fromNodeSqlite, openAICompatibleClient, SqlStore, type LlmClient} from '../src/index.js';

const scripted: LlmClient = {
  async complete(messages) {
    const transcript = messages.at(-1)?.content ?? '';
    if (transcript.includes('no longer')) return '{"facts":[{"scope":"persona","content":"User no longer drinks coffee."}]}';
    return JSON.stringify({
      facts: [
        {scope: 'persona', content: 'User drinks black coffee every morning.'},
        {scope: 'side', content: 'Old beagle who sleeps by the heater.', subjectName: 'Max'},
      ],
    });
  },
};

const llm =
  process.env.LLM_BASE_URL ?
    openAICompatibleClient({
      baseURL: process.env.LLM_BASE_URL,
      model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
      ...(process.env.LLM_API_KEY ? {apiKey: process.env.LLM_API_KEY} : {}),
    })
  : scripted;

const store = new SqlStore(fromNodeSqlite(new DatabaseSync(process.env.DB_PATH ?? ':memory:')));
await store.migrate();

let clock = Math.floor(Date.now() / 1000);
const memory = createMemoryEngine({store, llm, now: () => clock});
const key = {userId: 'demo-user', agentId: 'aria'};

const turns1 = [
  {role: 'user' as const, content: 'Hi Aria! My name is Sam. I drink black coffee every morning, and my dog Max sleeps by the heater.'},
  {role: 'assistant' as const, content: 'Nice to meet you, Sam! Max sounds cozy.'},
];
await memory.recordUserTurn(key, turns1);
console.log('extract #1 →', summarize(await memory.extract({key, characterName: 'Aria', turns: turns1, userTurn: 1})));

clock += 60;
const turns2 = [{role: 'user' as const, content: 'Small update: I no longer drink coffee, switched to green tea.'}];
await memory.recordUserTurn(key, [...turns1, ...turns2]);
console.log('extract #2 →', summarize(await memory.extract({key, characterName: 'Aria', turns: turns2, userTurn: 2})));

console.log('\n--- system prompt memory block ---\n');
console.log(await memory.buildPrompt(key, {includeRelationship: true}));

function summarize(r: Awaited<ReturnType<typeof memory.extract>>) {
  return r.ok ? {added: r.added.map(f => f.content), disabled: r.disabledIds.length, skipped: r.skipped} : r;
}
