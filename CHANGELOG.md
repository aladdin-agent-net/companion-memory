# Changelog

## 0.2.0

### Added
- Household / embodied memory via `createHomeMemory`:
  - speaker identification fusion (`identify`, `resolveSpeaker`) and access rules (`memoryAccessFor`);
  - place hierarchy, objects with safety tags, location belief with time decay, habitual locations (`whereIs`);
  - sensitive locations withheld from children, guests and unidentified speakers;
  - episodic timeline with local-time ranges and `lastTime`;
  - safety gate for actions that rely on memory (`checkAction`, `assessAction`);
  - observation ingest for vision, speech, presence and task events;
  - speaker-scoped prompt context (`buildContext`);
  - `forgetMember`, `prune`, `clearHome`.
- Stores: `InMemoryHomeStore`, `SqlHomeStore` (SQLite / D1).
- `MemoryError` with stable error codes; input validation on public APIs.
- Versioned migrations (`runMigrations`, `cm_schema_migrations` table).

### Changed
- `SqlStore.migrate()` now records applied migrations and returns their names. Databases created by 0.1.0 upgrade in place.

## 0.1.0

- Initial release: fact extraction, dedup, corrections, budgeted recall, relationship state, extraction gating, in-memory / SQLite / D1 stores.
