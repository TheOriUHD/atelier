import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobAccess } from './blob-access.ts';
import { openDatabase, type Db } from './db.ts';
import { checkpoints, files, generatedImages, messages, projects, sessions, users } from './schema.ts';

const sha = (n: number) => n.toString(16).padStart(64, '0');
let db: Db;
let clock: number;
let access: BlobAccess;

beforeEach(async () => {
  db = openDatabase(':memory:');
  clock = 1_000_000;
  access = new BlobAccess(db, () => clock);
  for (const id of ['ada', 'bob']) await db.insert(users).values({ id, username: id, role: 'user', passwordHash: 'x', createdAt: 1, updatedAt: 1 });
  for (const id of ['a1', 'b1']) await db.insert(sessions).values({ id, userId: id === 'a1' ? 'ada' : 'bob', mode: 'chat', createdAt: 1, updatedAt: 1 });
});
afterEach(() => db.$client.close());

describe('BlobAccess', () => {
  it('reads every place a blob hash lives, for the account whose data it is', async () => {
    await db.insert(files).values({ id: 'f', userId: 'ada', blob: sha(1), name: 'a', mime: 'image/png', size: 1, kind: 'upload', createdAt: 1 });
    // A file row with no owner of its own belongs to its conversation's, and a project file to the project's.
    await db.insert(files).values({ id: 'g', sessionId: 'a1', blob: sha(2), name: 'a', mime: 'image/png', size: 1, kind: 'generated', createdAt: 1 });
    await db.insert(projects).values({ id: 'p', userId: 'ada', name: 'P', createdAt: 1, updatedAt: 1 });
    await db.insert(files).values({ id: 'h', projectId: 'p', blob: sha(3), name: 'a', mime: 'text/plain', size: 1, kind: 'project', createdAt: 1 });
    await db.insert(generatedImages).values({ id: 'i', userId: 'ada', sessionId: 'a1', blob: sha(4), mime: 'image/png', size: 1, width: 1, height: 1, prompt: 'p', providerId: 'x', modelId: 'y', modelName: 'z', params: {}, createdAt: 1 });
    await db.insert(checkpoints).values({ id: 'c', sessionId: 'a1', messageId: 'm', path: 'a', beforeBlob: sha(5), createdAt: 1 });
    await db.$client.prepare(`UPDATE sessions SET system_snapshot = ?, tools_snapshot = ? WHERE id = 'a1'`).run(sha(6), sha(7));
    await db.insert(messages).values({
      id: 'm1',
      sessionId: 'a1',
      role: 'tool',
      parts: [{ type: 'tool_result', callId: 'c', content: [{ type: 'image', mime: 'image/png', blob: sha(8) }], saved: { blob: sha(9), mime: 'image/png' } }],
      createdAt: 1,
    });
    for (let n = 1; n <= 9; n++) {
      expect(await access.canRead('ada', sha(n)), `ada reads ${n}`).toBe(true);
      expect(await access.canRead('bob', sha(n)), `bob reads ${n}`).toBe(false);
    }
  });

  it('does not take a hash written into text for a reference', async () => {
    await db.insert(messages).values({ id: 'm', sessionId: 'a1', role: 'user', parts: [{ type: 'text', text: `"blob":"${sha(1)}" ${sha(1)}` }], createdAt: 1 });
    expect(await access.canRead('ada', sha(1))).toBe(false);
  });

  it('shows avatars to everyone and refuses anything that is not a hash', async () => {
    await db.$client.prepare(`UPDATE users SET avatar_blob = ? WHERE id = 'ada'`).run(sha(1));
    expect(await access.canRead('bob', sha(1))).toBe(true);
    expect(await access.canRead('bob', 'not a hash')).toBe(false);
    expect(await access.canRead('bob', `${sha(1)}%`)).toBe(false);
  });

  it('keeps an answer for a while so a page of images costs one lookup each, and a refusal only briefly', async () => {
    expect(await access.canRead('ada', sha(1))).toBe(false);
    await db.insert(files).values({ id: 'f', userId: 'ada', blob: sha(1), name: 'a', mime: 'image/png', size: 1, kind: 'upload', createdAt: 1 });
    expect(await access.canRead('ada', sha(1))).toBe(false);
    clock += 6_000;
    expect(await access.canRead('ada', sha(1))).toBe(true);
    await db.$client.prepare(`DELETE FROM files`).run();
    clock += 30_000;
    expect(await access.canRead('ada', sha(1))).toBe(true);
    clock += 31_000;
    expect(await access.canRead('ada', sha(1))).toBe(false);
  });

  it('lets an account read a blob it was just given, for an hour, and only that account', async () => {
    expect(await access.canRead('ada', sha(1))).toBe(false);
    access.grant('ada', sha(1));
    expect(await access.canRead('ada', sha(1))).toBe(true);
    expect(await access.canRead('bob', sha(1))).toBe(false);
    clock += 61 * 60_000;
    expect(await access.canRead('ada', sha(1))).toBe(false);
  });
});
