import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite/driver';
import { migrations } from './migrations.gen.ts';

export type Db = NodeSQLiteDatabase & { $client: DatabaseSync };

/** Opens (or creates) the database, applies pending migrations and returns a Drizzle handle. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const client = new DatabaseSync(path);
  client.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(client);
  return drizzle({ client }) as Db;
}

function migrate(client: DatabaseSync): void {
  client.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    (client.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    client.exec('BEGIN');
    try {
      for (const statement of m.statements) client.exec(statement);
      client.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(m.name, Date.now());
      client.exec('COMMIT');
    } catch (error) {
      client.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${(error as Error).message}`, { cause: error });
    }
  }
}
