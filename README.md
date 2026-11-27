# companion-memory

Long-term memory for AI characters, companions and assistants, in TypeScript with no runtime dependencies.

It answers one question well: **what should the model remember about this user, and how do I fit it into the prompt?**

- **Fact extraction**: an LLM pulls durable facts from recent turns (user / character / side characters), backed by deterministic rules for the most common facts. It still works when the LLM is down.
- **Noise filtering and dedup**: drops "lol" and "I'm tired today"; merges paraphrases (stemmed token overlap, CJK bigrams).
- **Self-corrections**: "I no longer drink coffee" disables the stale auto-extracted fact. Manual facts are never touched.
- **Budgeted recall**: renders story + pins + facts into a prompt block within a character budget, degrading gracefully (user facts survive longest), plus rules that stop the model from inventing memories.
- **Relationship state**: familiarity stages, trust / attachment / romance, idempotent turn counting (client retries do not double count).
- **Safe extraction gating**: per-turn idempotency, rate limiting and a compare-and-set lock, so concurrent requests do not extract twice.
- **Shared persona**: facts saved under a shared agent id (e.g. "user is vegetarian") are known by every agent of that user.
- **Pluggable storage and model**: in-memory, SQLite (`node:sqlite`, `better-sqlite3`), Cloudflare D1, or your own `MemoryStore`; any OpenAI-compatible endpoint (OpenAI, vLLM, Ollama, LM Studio, OpenRouter, LiteLLM).

Originally built for a production AI-character chat product, then extracted and cleaned up.

## Install

```bash
npm install companion-memory
```

Requires Node 20+ (uses Web Crypto). `SqlStore` with `node:sqlite` needs Node 22.5+.

## Quick start

```ts
import {DatabaseSync} from 'node:sqlite';
import {createMemoryEngine, SqlStore, fromNodeSqlite, openAICompatibleClient} from 'companion-memory';

const store = new SqlStore(fromNodeSqlite(new DatabaseSync('memory.db')));
await store.migrate();

const memory = createMemoryEngine({
  store,
  llm: openAICompatibleClient({baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b'}),
});

const key = {userId: 'user-42', agentId: 'aria'};

// 1) Before calling your chat model: put memory into the system prompt.
const memoryBlock = await memory.buildPrompt(key, {includeRelationship: true});
const system = `${characterCard}\n\n${memoryBlock}`;

// 2) After the reply: count the turn and extract facts (fire-and-forget is fine).
await memory.recordUserTurn(key, turns);
await memory.extract({key, characterName: 'Aria', userName: 'Sam', turns, userTurn});
```

Try it offline (a scripted fake model is used when `LLM_BASE_URL` is unset):

```bash
npm install && npm run example
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen2.5:7b npm run example
```

## Concepts

| Concept | Meaning |
|---|---|
| `MemoryKey` | `{userId, agentId}`. `agentId` is whatever the user talks to: a character, an assistant, a robot. |
| Fact | One short sentence with `scope` = `persona` (about the user) / `character` / `side` (named side character), `source` = `auto` or `manual`. |
| Pin | A message kept verbatim. |
| Story | Free-form user-written memory ("the story so far"). |
| Relationship | Familiarity stage plus trust / attachment / romance (0–100). |

## Engine API

| Method | Purpose |
|---|---|
| `buildPrompt(key, {includeRelationship?})` | Memory block for the system prompt, within `limits.budgetChars`. |
| `extract({key, characterName, userName?, turns, userTurn, threadId?})` | Extract + store facts; returns `added`, `disabledIds`, or why it skipped. |
| `snapshot(key)` | Story, pins, facts (with shared persona) and budget usage, e.g. for a "memory" UI panel. |
| `recordUserTurn(key, turns)` / `raiseBond(key, bond, note?)` / `relationship(key)` | Relationship state. |
| `setStory`, `pin`, `unpin`, `addFact`, `updateFact`, `removeFact`, `clear` | User-editable memory. |

Limits (all optional) are in `DEFAULT_LIMITS`: `maxFacts`, `maxPins`, `maxStoryChars`, `budgetChars`, `recallFactLimit`, `maxNewFactsPerExtract`, `minExtractIntervalSec`, `durablePersonaOnly`, `allowedScopes`. Two engines with different limits make an easy free / paid split.

Every building block (`parseFactExtractionOutput`, `isNearDuplicateFactContent`, `findSupersededFacts`, `buildMemoryPromptBlock`, `applyUserTurn`, ...) is exported as a pure function if you only want parts.

## Storage

```ts
import {InMemoryStore, SqlStore, fromNodeSqlite, fromD1, SCHEMA_SQL} from 'companion-memory';

new InMemoryStore();                              // tests, demos
new SqlStore(fromNodeSqlite(new DatabaseSync('m.db'))); // node:sqlite or better-sqlite3
new SqlStore(fromD1(env.DB));                     // Cloudflare D1 (run SCHEMA_SQL as a migration)
```

Implement `MemoryStore` for anything else (Postgres, Redis, ...). `beginExtraction` must be atomic; `decideExtraction` gives you the shared policy.

## Limitations (honest list)

- Recall is **recency-based**, not semantic. With hundreds of facts per user, you will want embeddings or a reranker; the `factLimit` / budget hooks are where to plug that in.
- The deterministic rules and correction patterns are **English**. Other languages rely on the LLM (dedup does handle CJK).
- Corrections are pattern-based ("no longer", "quit", "stopped", "... anymore"); subtle contradictions are left to the LLM's "skip unless changed" instruction.
- Extraction quality depends on your model. 7B+ instruction models work; tiny models produce more junk (filtered, but not perfectly).

## Roadmap

- **Now:** memory for chat characters, companions and assistants.
- **Next:** embodied and home-robot use cases. The same per-user, per-agent memory as a personality and memory layer for household robots, adding:
  - episodic memory on a timeline ("what happened when"), with time-based retrieval;
  - multiple household members behind one robot (speaker-aware memory);
  - safety gating, so remembered facts never drive physical actions without re-confirmation;
  - non-text sources (speech, vision, observed behavior) feeding facts.
- **Later:** pluggable semantic retrieval (embeddings / reranker) for large memories.

Feedback on these directions is welcome in issues.

## Development

```bash
npm test          # vitest (runs every engine test against InMemoryStore and SqlStore)
npm run typecheck
npm run build
```

## License

MIT
