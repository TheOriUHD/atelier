import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { FileRepo } from '../files/file-repo.ts';
import { ProjectRepo } from '../projects/project-repo.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { BlobStore } from '../store/blobs.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { blobs as blobTable, messages, users } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import { collectUnusedBlobs, conversationIds, deleteConversations, exportAll } from './privacy.ts';

let dir: string;
let db: Db;
let repo: SessionRepo;
let blobs: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-privacy-'));
  db = openDatabase(':memory:');
  for (const id of ['ada', 'bob']) await db.insert(users).values({ id, username: id, name: id, role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  repo = new SessionRepo(db);
  blobs = new BlobStore(db, join(dir, 'blobs'));
});
afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const say = (sessionId: string, role: 'user' | 'assistant', text: string, parentId: string | null, extra: object[] = []) =>
  repo.insertMessage({ id: newId(), sessionId, parentId, role, parts: [{ type: 'text', text }, ...(extra as never[])], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null });

describe('privacy', () => {
  it('picks old unpinned conversations and deletes them with everything they hold', async () => {
    const now = Date.now();
    const old = await repo.create({ mode: 'chat', userId: 'ada' });
    const pinned = await repo.create({ mode: 'chat', userId: 'ada' });
    const recent = await repo.create({ mode: 'chat', userId: 'ada' });
    const child = await repo.create({ mode: 'code', userId: 'ada', parentSessionId: old.id });
    await repo.update(pinned.id, { pinnedAt: now });
    await say(old.id, 'user', 'hello', null);
    await new ArtifactRepo(db).create({ sessionId: old.id, identifier: 'page', type: 'html', title: 'Page', language: null, content: '<p>x</p>', messageId: null });
    db.$client.prepare('UPDATE sessions SET updated_at = ? WHERE id IN (?, ?)').run(now - 40 * 86_400_000, old.id, pinned.id);

    expect(await conversationIds(db, 'ada', 30, now)).toEqual([old.id]);
    expect((await conversationIds(db, 'ada')).sort()).toEqual([old.id, pinned.id, recent.id].sort());
    await deleteConversations(db, [old.id]);
    expect(await repo.getRow(child.id)).toBeUndefined();
    expect(await db.select().from(messages).all()).toEqual([]);
    expect(await new ArtifactRepo(db).list(old.id)).toEqual([]);
  });

  it('removes only blobs nothing refers to, after a grace period', async () => {
    const s = await repo.create({ mode: 'chat', userId: 'ada' });
    const image = await blobs.put(new Uint8Array([1, 2, 3]), 'image/png');
    const unused = await blobs.put(new Uint8Array([4, 5]), 'application/octet-stream');
    const fresh = await blobs.put(new Uint8Array([6]), 'application/octet-stream');
    await say(s.id, 'user', 'look', null, [{ type: 'image', mime: 'image/png', blob: image.sha256 }]);
    const hourAgo = Date.now() - 2 * 3600_000;
    db.$client.prepare('UPDATE blobs SET created_at = ? WHERE sha256 IN (?, ?)').run(hourAgo, image.sha256, unused.sha256);
    expect(await collectUnusedBlobs(db, blobs)).toBe(1);
    expect((await db.select().from(blobTable).all()).map((b) => b.sha256).sort()).toEqual([image.sha256, fresh.sha256].sort());
  });

  it('exports conversations, artifacts, projects and files as a zip', async () => {
    const s = await repo.create({ mode: 'chat', userId: 'ada', title: 'Trip plans' });
    const q = await say(s.id, 'user', 'Where to?', null);
    await say(s.id, 'assistant', 'Lisbon.', q.id);
    await new ArtifactRepo(db).create({ sessionId: s.id, identifier: 'itinerary', type: 'markdown', title: 'Itinerary', language: null, content: '# Day 1', messageId: null });
    await new ProjectRepo(db).create({ name: 'Travel', description: 'Trips', userId: 'ada' });
    await new FileRepo(db, blobs).upload({ name: 'tickets.txt', mime: 'text/plain', bytes: new TextEncoder().encode('ABC123'), kind: 'upload', sessionId: s.id, userId: 'ada' });
    await say((await repo.create({ mode: 'chat', userId: 'bob', title: 'Bob’s' })).id, 'user', 'secret', null);

    const zip = unzipSync(await exportAll(db, blobs, 'ada'));
    const names = Object.keys(zip).sort();
    expect(names.some((n) => /^conversations\/Trip plans-\w{8}\.md$/.test(n))).toBe(true);
    expect(names.some((n) => /^artifacts\/Itinerary-\w{8}-v1\.md$/.test(n))).toBe(true);
    expect(names.some((n) => n.endsWith('-tickets.txt'))).toBe(true);
    const md = strFromU8(zip[names.find((n) => n.startsWith('conversations/'))!]!);
    expect(md).toBe('# Trip plans\n\n## You\n\nWhere to?\n\n## Assistant\n\nLisbon.\n');
    const conversations = JSON.parse(strFromU8(zip['conversations.json']!)) as { title: string }[];
    expect(conversations.map((c) => c.title)).toEqual(['Trip plans']);
    expect(JSON.parse(strFromU8(zip['projects.json']!))).toEqual([expect.objectContaining({ name: 'Travel' })]);
  });
});
