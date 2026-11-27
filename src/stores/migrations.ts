import type {SqlDriver} from './sql.js';

export type Migration = {name: string; statements: string[]};

/**
 * Apply named migrations once each, in order, recording them in `cm_schema_migrations`.
 * Statements must be idempotent-safe on their own (CREATE ... IF NOT EXISTS) because
 * SQLite/D1 do not give us cross-statement transactions through every driver.
 */
export async function runMigrations(sql: SqlDriver, migrations: Migration[]): Promise<string[]> {
  await sql.run(
    'CREATE TABLE IF NOT EXISTS cm_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    (await sql.all<{name: string}>('SELECT name FROM cm_schema_migrations')).map(r => r.name),
  );
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    for (const statement of migration.statements) await sql.run(statement);
    await sql.run('INSERT OR IGNORE INTO cm_schema_migrations (name, applied_at) VALUES (?, ?)', [
      migration.name,
      Math.floor(Date.now() / 1000),
    ]);
    ran.push(migration.name);
  }
  return ran;
}

export function splitStatements(schema: string): string[] {
  return schema
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}
