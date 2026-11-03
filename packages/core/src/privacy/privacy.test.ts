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
import { collectUnusedBlobs, conversationIds, deleteConversations, exportAll, exportStream } from './privacy.ts';

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
  it('includes every picture and document its conversations refer to, also those that exist only inside messages', async () => {
    const s = await repo.create({ mode: 'chat', userId: 'ada', title: 'Trip plans' });
    const pasted = await blobs.put(new Uint8Array([1, 1, 1]), 'image/png');
    const doc = await blobs.put(new TextEncoder().encode('the contract'), 'text/plain');
    const fromTool = await blobs.put(new Uint8Array([2, 2]), 'image/jpeg');
    const made = await blobs.put(new Uint8Array([3]), 'image/webp');
    const saved = await blobs.put(new Uint8Array([4]), 'image/png');
    const gone = await blobs.put(new Uint8Array([5]), 'image/png');
    db.$client.prepare('DELETE FROM blobs WHERE sha256 = ?').run(gone.sha256);
    const q = await say(s.id, 'user', 'look', null, [
      { type: 'image', mime: 'image/png', blob: pasted.sha256 },
      { type: 'document', mime: 'text/plain', blob: doc.sha256, name: 'contract: final?.txt' },
      { type: 'image', mime: 'image/png', blob: gone.sha256 },
    ]);
    await repo.insertMessage({
      id: newId(),
      sessionId: s.id,
      parentId: q.id,
      role: 'tool',
      parts: [
        {
          type: 'tool_result',
          callId: 'c',
          content: [{ type: 'image', mime: 'image/jpeg', blob: fromTool.sha256 }, { type: 'image', mime: 'image/png', blob: pasted.sha256 }],
          generated: [{ id: 'img_1', blob: made.sha256, mime: 'image/webp', width: 1, height: 1, prompt: 'p', ref: 'x/y', modelName: 'Y', durationMs: 1 }],
          saved: { blob: saved.sha256, mime: 'image/png' },
        } as never,
      ],
      model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null,
    });
    // Someone else's conversation, and a file of Ada's that is also attached in a message.
    await say((await repo.create({ mode: 'chat', userId: 'bob', title: 'Bob’s' })).id, 'user', 'x', null, [{ type: 'image', mime: 'image/png', blob: (await blobs.put(new Uint8Array([9]), 'image/png')).sha256 }]);
    const uploaded = await new FileRepo(db, blobs).upload({ name: 'shot.png', mime: 'image/png', bytes: new Uint8Array([7, 7]), kind: 'upload', sessionId: s.id, userId: 'ada' });
    await say(s.id, 'user', 'again', q.id, [{ type: 'image', mime: 'image/png', blob: uploaded.blob }]);

    const zip = unzipSync(await exportAll(db, blobs, 'ada'));
    const names = Object.keys(zip).filter((n) => n.startsWith('attachments/')).sort();
    const stem = Object.keys(zip).find((n) => n.startsWith('conversations/'))!.replace(/^conversations\/|\.md$/g, '');
    const sha8 = (b: { sha256: string }) => b.sha256.slice(0, 8);
    expect(names).toEqual(
      [
        `attachments/${stem}/001-${sha8(pasted)}.png`,
        `attachments/${stem}/001-contract_ final_.txt`,
        `attachments/${stem}/002-${sha8(fromTool)}.jpg`,
        `attachments/${stem}/002-${sha8(made)}.webp`,
        `attachments/${stem}/002-${sha8(saved)}.png`,
      ].sort(),
    );
    expect([...zip[`attachments/${stem}/001-${sha8(pasted)}.png`]!]).toEqual([1, 1, 1]);
    expect(strFromU8(zip[`attachments/${stem}/001-contract_ final_.txt`]!)).toBe('the contract');
    // Stored once whoever refers to it: the second use and the upload point at the first place.
    const manifest = JSON.parse(strFromU8(zip['attachments.json']!)) as { sha256: string; file: string | null; omitted?: string; kind: string }[];
    expect(manifest.filter((m) => m.sha256 === pasted.sha256).map((m) => m.file)).toEqual([`attachments/${stem}/001-${sha8(pasted)}.png`, `attachments/${stem}/001-${sha8(pasted)}.png`]);
    expect(manifest.find((m) => m.sha256 === gone.sha256)).toMatchObject({ file: null, omitted: 'no longer stored' });
    expect(manifest.find((m) => m.sha256 === uploaded.blob)?.file).toMatch(/^files\/.*-shot\.png$/);
    expect(Object.keys(zip).filter((n) => n.startsWith('files/'))).toHaveLength(1);
    // Nothing of Bob's.
    expect(manifest.every((m) => m.file === null || Object.hasOwn(zip, m.file))).toBe(true);
    expect(names.some((n) => n.includes('Bob'))).toBe(false);
  });

  it('lists what no longer fits instead of breaking the archive, and writes the archive in pieces', async () => {
    const s = await repo.create({ mode: 'chat', userId: 'ada', title: 'Big' });
    const parts = [] as object[];
    for (let i = 0; i < 4; i++) parts.push({ type: 'image', mime: 'image/png', blob: (await blobs.put(new Uint8Array(1000).fill(i + 1), 'image/png')).sha256 });
    await say(s.id, 'user', 'pictures', null, parts);

    const chunks: Uint8Array[] = [];
    for await (const chunk of exportStream(db, blobs, 'ada', { entries: 60_000, bytes: 2500 })) chunks.push(chunk);
    // Many chunks, none the size of the archive: nothing was built in one piece.
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(chunks.length).toBeGreaterThan(5);
    expect(Math.max(...chunks.map((c) => c.byteLength))).toBeLessThan(total);
    const zip = unzipSync(Buffer.concat(chunks));
    const manifest = JSON.parse(strFromU8(zip['attachments.json']!)) as { file: string | null; omitted?: string }[];
    expect(manifest.filter((m) => m.file).length).toBe(2);
    expect(manifest.filter((m) => m.omitted === 'the archive is full').length).toBe(2);
    expect(Object.keys(zip).filter((n) => n.startsWith('attachments/'))).toHaveLength(2);
  });

  it('is stored as a blob without being held in memory, and an empty account exports valid files', async () => {
    const stored = await blobs.putStream(exportStream(db, blobs, 'ada'), 'application/zip');
    const zip = unzipSync(await blobs.read(stored.sha256));
    expect(JSON.parse(strFromU8(zip['conversations.json']!))).toEqual([]);
    expect(JSON.parse(strFromU8(zip['attachments.json']!))).toEqual([]);
    expect((await blobs.info(stored.sha256))?.mime).toBe('application/zip');
  });
});
