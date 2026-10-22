import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@atelier/protocol';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { SessionRepo } from './session-repo.ts';
import { isTemporary, mayUseChatSearch, memoryAccess, temporaryMode, usesPersonalContext } from './temporary.ts';

let db: Db;
let repo: SessionRepo;
beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new SessionRepo(db);
});
afterEach(() => db.$client.close());

let clock = 1_000;
function msg(sessionId: string, id: string, parentId: string | null, role: Message['role'], text: string, extra: Partial<Message> = {}) {
  return repo.insertMessage({
    id,
    sessionId,
    parentId,
    role,
    parts: [{ type: 'text', text }],
    model: null,
    usage: null,
    stopReason: null,
    error: null,
    kind: 'normal',
    summarizesThroughId: null,
    createdAt: clock++,
    ...extra,
  });
}

describe('forking, archiving and groups', () => {
  it('forks the active branch as a new session in the same folder, with its own message ids', async () => {
    const s = await repo.create({ mode: 'code', workspaceId: 'w1', model: 'fake/m', title: 'Fix it' });
    await msg(s.id, 'u1', null, 'user', 'hi');
    await msg(s.id, 'a1', 'u1', 'assistant', 'hello');
    await msg(s.id, 'u2', 'a1', 'user', 'old question');
    await msg(s.id, 'u3', 'a1', 'user', 'edited question');
    const copy = await repo.fork(s.id);
    expect(copy).toMatchObject({ mode: 'code', workspaceId: 'w1', model: 'fake/m', title: 'Fork of Fix it', status: 'idle' });
    expect(copy.id).not.toBe(s.id);
    const { messages } = await repo.branch(copy.id);
    expect(messages.map((m) => m.parts[0])).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'edited question' },
    ]);
    expect(messages.every((m) => m.sessionId === copy.id && !['u1', 'a1', 'u3'].includes(m.id))).toBe(true);
    expect(messages[1]!.parentId).toBe(messages[0]!.id);
    // The original keeps both branches.
    expect(await repo.messageCount(s.id)).toBe(4);
  });

  it('continues a chat in another mode: same title and sandbox folder, a system prompt of its own', async () => {
    const s = await repo.create({ mode: 'chat', workspaceId: 'sandbox-1', model: 'fake/m', title: 'Look at acme/app' });
    await msg(s.id, 'u1', null, 'user', 'clone acme/app');
    await msg(s.id, 'a1', 'u1', 'assistant', 'It is a todo app.');
    await repo.update(s.id, { systemSnapshot: 'chat-snapshot' });
    const task = await repo.fork(s.id, 'work');
    expect(task).toMatchObject({ mode: 'work', workspaceId: 'sandbox-1', title: 'Look at acme/app' });
    expect((await repo.getRow(task.id))?.systemSnapshot).toBeNull();
    expect((await repo.branch(task.id)).messages.map((m) => m.parts[0])).toEqual([
      { type: 'text', text: 'clone acme/app' },
      { type: 'text', text: 'It is a todo app.' },
    ]);
  });

  it('leaves archived sessions out of the lists until asked, and files sessions under groups', async () => {
    const a = await repo.create({ mode: 'code', userId: null });
    const b = await repo.create({ mode: 'code' });
    await repo.patchQuietly(a.id, { archivedAt: 5 });
    expect((await repo.list({ limit: 10 })).map((s) => s.id)).toEqual([b.id]);
    expect((await repo.list({ archived: 'archived', limit: 10 })).map((s) => s.id)).toEqual([a.id]);
    expect((await repo.list({ archived: 'all', limit: 10 })).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect((await repo.get(a.id))?.archivedAt).toBe(5);
  });
});

describe('SessionRepo', () => {
  it('tracks the active branch and siblings across edits', async () => {
    const s = await repo.create({ mode: 'chat' });
    await msg(s.id, 'u1', null, 'user', 'hi');
    await msg(s.id, 'a1', 'u1', 'assistant', 'hello');
    await msg(s.id, 'u2', 'a1', 'user', 'first question');
    await msg(s.id, 'a2', 'u2', 'assistant', 'answer one');
    // edit u2 → sibling u2b
    await msg(s.id, 'u2b', 'a1', 'user', 'edited question');
    await msg(s.id, 'a2b', 'u2b', 'assistant', 'answer two');
    let b = await repo.branch(s.id);
    expect(b.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2b', 'a2b']);
    expect(b.siblings['u2b']).toEqual(['u2', 'u2b']);
    await repo.switchBranch(s.id, 'u2');
    b = await repo.branch(s.id);
    expect(b.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('starts model history at the nearest compaction summary without deleting anything', async () => {
    const s = await repo.create({ mode: 'chat' });
    await msg(s.id, 'u1', null, 'user', 'old');
    await msg(s.id, 'a1', 'u1', 'assistant', 'old reply');
    await msg(s.id, 'sum', 'a1', 'user', 'summary', { kind: 'compaction_summary', summarizesThroughId: 'a1' });
    await msg(s.id, 'u2', 'sum', 'user', 'new');
    expect((await repo.history(s.id)).map((m) => m.id)).toEqual(['sum', 'u2']);
    expect((await repo.branch(s.id)).messages).toHaveLength(4);
  });

  it('lists pinned first, hides subagent sessions and searches message text', async () => {
    const a = await repo.create({ mode: 'chat' });
    const b = await repo.create({ mode: 'chat' });
    await repo.create({ mode: 'chat', parentSessionId: a.id });
    await repo.update(a.id, { pinnedAt: Date.now(), title: 'Sorting' });
    await msg(b.id, 'x1', null, 'user', 'mergesort is stable');
    const all = await repo.list({ limit: 50 });
    expect(all.map((s) => s.id)).toEqual([a.id, b.id]);
    expect((await repo.list({ query: 'merges', limit: 50 })).map((s) => s.id)).toEqual([b.id]);
    expect((await repo.list({ query: 'sorting', limit: 50 })).map((s) => s.id)).toEqual([a.id]);
  });

  it('says which sessions produced something: an artifact, or files a Cowork task wrote or edited', async () => {
    const chat = await repo.create({ mode: 'chat' });
    const withArtifact = await repo.create({ mode: 'chat' });
    const task = await repo.create({ mode: 'work' });
    const reading = await repo.create({ mode: 'work' });
    await new ArtifactRepo(db).create({ sessionId: withArtifact.id, identifier: 'page', type: 'html', title: 'Page', language: null, content: '<p/>', messageId: null });
    const toolCall = (name: string) => ({ parts: [{ type: 'tool_call' as const, id: name, name, input: { file_path: 'report.md' } }] });
    await msg(task.id, 't1', null, 'user', 'Write the report');
    await msg(task.id, 't2', 't1', 'assistant', '', toolCall('Write'));
    await msg(reading.id, 'r1', null, 'user', 'Write nothing, just read');
    await msg(reading.id, 'r2', 'r1', 'assistant', '', toolCall('Read'));
    const produced = Object.fromEntries((await repo.list({ limit: 50 })).map((s) => [s.id, s.produced]));
    expect(produced).toEqual({ [chat.id]: false, [withArtifact.id]: true, [task.id]: true, [reading.id]: false });
  });

  it('marks running sessions interrupted on startup', async () => {
    const s = await repo.create({ mode: 'chat' });
    await repo.patchQuietly(s.id, { status: 'running' });
    expect(await repo.markRunningAsInterrupted()).toEqual([s.id]);
    expect((await repo.get(s.id))?.status).toBe('interrupted');
  });
});

describe('temporary sessions', () => {
  it('pass their mode to sub-agents and forks, and say what they may do with memory', async () => {
    const fresh = await repo.create({ mode: 'chat', temporary: 'fresh' });
    const child = await repo.create({ mode: 'chat', parentSessionId: fresh.id });
    expect(child.temporary).toBe('fresh');
    expect((await repo.fork(fresh.id)).temporary).toBe('fresh');
    const row = (await repo.getRow(child.id))!;
    expect([isTemporary(row), temporaryMode(row), usesPersonalContext(row), memoryAccess(row), mayUseChatSearch(row)]).toEqual([true, 'fresh', false, { read: false, write: false }, false]);

    const priv = (await repo.getRow((await repo.create({ mode: 'chat', temporary: 'private' })).id))!;
    expect([isTemporary(priv), usesPersonalContext(priv), memoryAccess(priv), mayUseChatSearch(priv)]).toEqual([true, true, { read: true, write: false }, true]);
    const plain = (await repo.getRow((await repo.create({ mode: 'chat' })).id))!;
    expect([isTemporary(plain), temporaryMode(plain), memoryAccess(plain)]).toEqual([false, null, { read: true, write: true }]);
  });

  it('are found by the sweep once idle, top-level only', async () => {
    const t = await repo.create({ mode: 'chat', temporary: 'private' });
    await repo.create({ mode: 'chat', parentSessionId: t.id });
    await repo.create({ mode: 'chat' });
    expect(await repo.temporaryIdleSince(t.updatedAt)).toEqual([]);
    expect((await repo.temporaryIdleSince(t.updatedAt + 1)).map((r) => r.id)).toEqual([t.id]);
  });
});
