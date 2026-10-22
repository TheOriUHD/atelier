import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDatabase, type Db } from './db.ts';
import { migrations } from './migrations.gen.ts';
import { BlobStore } from './blobs.ts';
import { messages, sessions } from './schema.ts';

let dir: string;
let db: Db;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-db-'));
  db = openDatabase(join(dir, 'atelier.db'));
});
afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe('store', () => {
  it('migrates idempotently', () => {
    db.$client.close();
    db = openDatabase(join(dir, 'atelier.db'));
    const rows = db.$client.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(migrations.map((m) => m.name));
  });

  it('leaves the codespace folders of an earlier version untrusted when it adds the trust column, and the others trusted', () => {
    const client = new DatabaseSync(':memory:');
    const step = migrations.findIndex((m) => m.name.endsWith('_workspace_trust'));
    expect(step).toBeGreaterThan(0);
    for (const m of migrations.slice(0, step)) for (const statement of m.statements) client.exec(statement);
    // No users to own the folders.
    client.exec('PRAGMA foreign_keys = OFF');
    const folder = client.prepare('INSERT INTO workspaces (id, user_id, kind, name, root, host, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)');
    folder.run('a', 'u', 'local', 'app', '/work/app', null);
    folder.run('b', 'u', 'ssh', 'api', '/srv/api', 'devbox');
    folder.run('c', 'u', 'codespace', 'site', '/workspaces/site', 'site-abc');
    for (const statement of migrations[step]!.statements) client.exec(statement);
    expect(client.prepare('SELECT id, trusted FROM workspaces ORDER BY id').all()).toEqual([
      { id: 'a', trusted: 1 },
      { id: 'b', trusted: 1 },
      { id: 'c', trusted: 0 },
    ]);
    client.close();
  });

  it('dedupes blobs by content', async () => {
    const blobs = new BlobStore(db, join(dir, 'blobs'));
    const a = await blobs.putText('hello');
    const b = await blobs.putText('hello');
    expect(a.sha256).toBe(b.sha256);
    expect(await blobs.readText(a.sha256)).toBe('hello');
    expect(await blobs.collectGarbage(new Set())).toBe(1);
  });

  it('stores the same content written many times at once', async () => {
    const blobs = new BlobStore(db, join(dir, 'blobs'));
    const all = await Promise.all(Array.from({ length: 20 }, () => blobs.putText('the same system prompt')));
    expect(new Set(all.map((b) => b.sha256)).size).toBe(1);
    expect(await blobs.readText(all[0]!.sha256)).toBe('the same system prompt');
  });

  it('indexes message text for full-text search', async () => {
    const now = Date.now();
    await db.insert(sessions).values({ id: 's1', mode: 'chat', createdAt: now, updatedAt: now });
    await db.insert(messages).values({ id: 'm1', sessionId: 's1', role: 'user', parts: [], searchText: 'quicksort versus mergesort', createdAt: now });
    const hits = db.$client.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'mergesort'").all();
    expect(hits).toHaveLength(1);
    await db.delete(messages).where(sql`id = 'm1'`);
    expect(db.$client.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'mergesort'").all()).toHaveLength(0);
  });
});
