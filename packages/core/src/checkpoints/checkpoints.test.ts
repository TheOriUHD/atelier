import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@atelier/protocol';
import { SessionRepo } from '../sessions/session-repo.ts';
import { BlobStore } from '../store/blobs.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import { hostRunnerBinary } from '../workspaces/runner-client.ts';
import type { Workspace } from '../workspaces/workspace.ts';
import { WorkspaceManager } from '../workspaces/workspace-manager.ts';
import { sessionDiff } from '../workspaces/workspace-view.ts';
import { Checkpoints } from './checkpoints.ts';

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));
const built = existsSync(binary);

let db: Db;
let dir: string;
let manager: WorkspaceManager;
let ws: Workspace;
let repo: SessionRepo;
let store: Checkpoints;

const file = (name: string) => join(dir, name);
const read = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : null);
const say = (sessionId: string, role: Message['role']) =>
  repo.insertMessage({ id: newId(), sessionId, parentId: null, role, parts: [{ type: 'text', text: role }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null });
/** Messages chained under the session's head. */
async function turn(sessionId: string, role: Message['role']): Promise<string> {
  const head = (await repo.getRow(sessionId))!.headMessageId;
  const m = await say(sessionId, role);
  await repo.reparent(m.id, head);
  return m.id;
}
/** What Write does: keep the old content, then change the file. */
async function write(sessionId: string, name: string, content: string) {
  await store.capture(ws, sessionId, name);
  writeFileSync(file(name), content);
}

beforeEach(async () => {
  if (!built) return;
  db = openDatabase(':memory:');
  await db.insert(users).values({ id: 'ada', username: 'ada', name: 'Ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-ckpt-')));
  manager = new WorkspaceManager({ db, runnerBinary: binary, logger: { info: () => {}, error: () => {} } });
  ws = await manager.open('ada', (await manager.addLocal('ada', dir)).id);
  repo = new SessionRepo(db);
  store = new Checkpoints({ db, blobs: new BlobStore(db, join(dir, '.blobs')), repo });
});
afterEach(async () => {
  if (!built) return;
  await manager.disposeAll();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!built)('checkpoints', () => {
  it('keeps the content before each turn and rewinds files to before a message', async () => {
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    writeFileSync(file('a.txt'), 'one');
    const first = await turn(s.id, 'user');
    await write(s.id, 'a.txt', 'two');
    await write(s.id, 'a.txt', 'three'); // the same turn keeps its first pre-image
    await write(s.id, 'new.txt', 'created');
    await turn(s.id, 'assistant');

    const second = await turn(s.id, 'user');
    await write(s.id, 'a.txt', 'four');
    // A sub-agent's edits belong to its parent's current turn.
    const child = await repo.create({ mode: 'code', userId: 'ada', parentSessionId: s.id });
    await turn(child.id, 'user');
    writeFileSync(file('b.txt'), 'b0');
    await write(child.id, 'b.txt', 'b1');

    // Kept by where they are, whatever path the tool was given.
    expect(await store.list(s.id)).toEqual([
      { messageId: first, paths: [file('a.txt'), file('new.txt')] },
      { messageId: second, paths: [file('a.txt'), file('b.txt')] },
    ]);

    const here = async () => ws;
    expect((await store.rewind(s.id, second, here)).sort()).toEqual([file('a.txt'), file('b.txt')]);
    expect([read('a.txt'), read('b.txt'), read('new.txt')]).toEqual(['three', 'b0', 'created']);

    expect((await store.rewind(s.id, first, here)).sort()).toEqual([file('a.txt'), file('b.txt'), file('new.txt')]);
    expect([read('a.txt'), read('new.txt')]).toEqual(['one', null]);
  });

  it('restores each file in its own folder after the session moved to another', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-ckpt-other-')));
    try {
      const there = await manager.open('ada', (await manager.addLocal('ada', other)).id);
      const s = await repo.create({ mode: 'code', userId: 'ada', workspaceId: ws.id });
      writeFileSync(file('a.txt'), 'first folder');
      writeFileSync(join(other, 'a.txt'), 'second folder');
      const before = await turn(s.id, 'user');
      await write(s.id, 'a.txt', 'changed in the first');
      await turn(s.id, 'assistant');
      // Moved: the same name in the other folder is another file.
      await repo.update(s.id, { workspaceId: there.id });
      await turn(s.id, 'user');
      await store.capture(there, s.id, 'a.txt');
      writeFileSync(join(other, 'a.txt'), 'changed in the second');

      expect((await store.firstVersions(s.id, there.id)).map((f) => f.path)).toEqual([join(other, 'a.txt')]);
      const opened: (string | null)[] = [];
      const restored = await store.rewind(s.id, before, async (id) => {
        opened.push(id);
        return id === there.id ? there : ws;
      });
      expect(restored.sort()).toEqual([file('a.txt'), join(other, 'a.txt')].sort());
      expect([read('a.txt'), readFileSync(join(other, 'a.txt'), 'utf8')]).toEqual(['first folder', 'second folder']);
      expect(opened.sort()).toEqual([there.id, ws.id].sort());
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('restores nothing when one of the folders can’t be reached', async () => {
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    writeFileSync(file('a.txt'), 'one');
    const first = await turn(s.id, 'user');
    await write(s.id, 'a.txt', 'two');
    await expect(
      store.rewind(s.id, first, async () => {
        throw new Error('The computer is offline.');
      }),
    ).rejects.toThrow('offline');
    expect(read('a.txt')).toBe('two');
  });

  it('restores a checkpoint from before folders were kept in the session’s folder', async () => {
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    writeFileSync(file('old.txt'), 'changed');
    const first = await turn(s.id, 'user');
    const blob = await new BlobStore(db, join(dir, '.blobs')).put(Buffer.from('before'), 'application/octet-stream');
    db.$client.prepare('INSERT INTO checkpoints (id, session_id, message_id, path, before_blob, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('c1', s.id, first, 'old.txt', blob.sha256, Date.now());
    const opened: (string | null)[] = [];
    expect(
      await store.rewind(s.id, first, async (id) => {
        opened.push(id);
        return ws;
      }),
    ).toEqual(['old.txt']);
    expect([read('old.txt'), opened]).toEqual(['before', [null]]);
    expect((await store.firstVersions(s.id, ws.id)).map((f) => f.path)).toEqual(['old.txt']);
  });

  it('diffs what the session changed since it began, files it created and removed included', async () => {
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    writeFileSync(file('a.txt'), 'one\ntwo\n');
    writeFileSync(file('gone.txt'), 'bye\n');
    writeFileSync(file('untouched.txt'), 'same\n');
    await turn(s.id, 'user');
    await write(s.id, 'a.txt', 'one\n2\n');
    // The tools pass the paths the model wrote, usually absolute.
    await store.capture(ws, s.id, file('new.txt'));
    writeFileSync(file('new.txt'), 'hello\n');
    await turn(s.id, 'assistant');
    await turn(s.id, 'user');
    await write(s.id, 'a.txt', 'one\n2\nthree\n');
    await store.capture(ws, s.id, 'gone.txt');
    rmSync(file('gone.txt'));

    const files = await store.firstVersions(s.id, ws.id);
    expect(files.map((f) => f.path)).toEqual([file('a.txt'), file('new.txt'), file('gone.txt')]);
    const { diff } = await sessionDiff(ws, files);
    expect(diff).toBe(
      [
        'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n one\n-two\n+2\n+three\n',
        'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n',
        'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n',
      ].join(''),
    );
    expect((await sessionDiff(ws, files, 'new.txt')).diff).toContain('+hello');
    expect((await sessionDiff(ws, files, 'new.txt')).diff).not.toContain('a.txt');
  });

  it('prunes old checkpoints', async () => {
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    await turn(s.id, 'user');
    await write(s.id, 'a.txt', 'x');
    await store.prune(1);
    expect(await store.list(s.id)).toHaveLength(1);
    db.$client.prepare('UPDATE checkpoints SET created_at = 0').run();
    await store.prune(1);
    expect(await store.list(s.id)).toEqual([]);
  });
});
