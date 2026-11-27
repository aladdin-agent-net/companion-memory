import {DatabaseSync} from 'node:sqlite';
import {describe, expect, it} from 'vitest';
import {fromNodeSqlite, SCHEMA_SQL, SqlHomeStore, SqlStore} from '../src/index.js';

describe('migrations', () => {
  it('apply once, are idempotent, and upgrade a v0.1 database created without the migrations table', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL); // what SqlStore.migrate() produced in v0.1.0
    db.prepare("INSERT INTO cm_story (user_id, agent_id, body, updated_at) VALUES ('u', 'a', 'kept', 1)").run();

    const driver = fromNodeSqlite(db);
    const core = new SqlStore(driver);
    const home = new SqlHomeStore(driver);
    expect(await core.migrate()).toEqual(['core-001']);
    expect(await home.migrate()).toEqual(['home-001']);
    expect(await core.migrate()).toEqual([]);
    expect(await home.migrate()).toEqual([]);
    expect(await core.getStory({userId: 'u', agentId: 'a'})).toBe('kept');
  });
});
