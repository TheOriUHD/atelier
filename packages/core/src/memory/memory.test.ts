import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, defaultUserPrefs, describeImportChanges, memoryLines, parseChatHits, parseMemoryHits, type ModelInfo, type Settings, type UserPrefs } from '@atelier/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatService, ModelUnavailableError, type ModelResolver } from '../agent/chat-service.ts';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { FileRepo } from '../files/file-repo.ts';
import { ProjectRepo } from '../projects/project-repo.ts';
import { BlobStore } from '../store/blobs.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent } from '../providers/types.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import type { Tool, ToolContext } from '../tools/types.ts';
import { memoryFor, NO_MEMORY } from './access.ts';
import { CHAT_READ_MESSAGE_CHARS, ftsQuery, readChat, searchChats, SNIPPET_CHARS } from './chat-search.ts';
import { MemoryRepo } from './memory-repo.ts';
import { MemoryEditingOffError, memoryDigest, MemoryNotFoundError, MemoryService, ModelChoiceError, parseOps } from './memory-service.ts';

const info: ModelInfo = {
  ref: 'fake/m',
  providerId: 'fake',
  modelId: 'm',
  displayName: 'Fake',
  contextLength: 100_000,
  maxOutput: 8000,
  capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: false },
  tier: 'full',
  source: 'default',
  hidden: false,
  favorite: false,
  order: 0,
};

let db: Db;
let sessions: SessionRepo;
let prefs: Record<string, UserPrefs>;
let replies: (string | ((req: ChatRequest) => string))[];
let requests: ChatRequest[];
let changed: string[];

const adapter: ProviderAdapter = {
  type: 'openai-compatible',
  listModels: async () => [],
  health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
  async *stream(req): AsyncIterable<StreamEvent> {
    requests.push(req);
    const next = replies.shift() ?? '{"ops":[]}';
    yield { type: 'text', delta: typeof next === 'function' ? next(req) : next };
    yield { type: 'finish', reason: 'end' };
  },
};

function service(extra: { idleMs?: number; models?: ModelResolver; settings?: () => Settings } = {}) {
  return new MemoryService({
    db,
    sessions,
    prefs: async (userId) => prefs[userId] ?? defaultUserPrefs(),
    name: async (userId) => (userId === 'u1' ? 'Ada' : 'Bo'),
    models: { resolve: async () => ({ adapter, info }), firstAvailable: async () => info.ref },
    settings: () => defaultSettings(),
    promptOverrides: () => ({}),
    changed: (userId) => changed.push(userId),
    ...extra,
  });
}

const ctx = (sessionId: string): ToolContext => ({ sessionId, messageId: 'm', callId: 'c', signal: new AbortController().signal, emit: () => {} });
const run = async (tools: Tool[], name: string, input: unknown, sessionId: string) => {
  const out = await tools.find((t) => t.name === name)!.run(input, ctx(sessionId));
  return { text: out.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!out.isError };
};

async function say(sessionId: string, role: 'user' | 'assistant', text: string, createdAt?: number) {
  const row = (await sessions.getRow(sessionId))!;
  return sessions.insertMessage({ id: crypto.randomUUID(), sessionId, parentId: row.headMessageId, role, parts: [{ type: 'text', text }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, ...(createdAt ? { createdAt } : {}) });
}

const row = async (id: string) => (await sessions.getRow(id))!;

beforeEach(async () => {
  db = openDatabase(':memory:');
  sessions = new SessionRepo(db);
  prefs = {};
  replies = [];
  requests = [];
  changed = [];
  for (const [id, name] of [['u1', 'Ada'], ['u2', 'Bo']] as const) await db.insert(users).values({ id, username: id, name, role: 'user', passwordHash: '', createdAt: 0, updatedAt: 0 });
});

afterEach(() => db.$client.close());

describe('memory entries', () => {
  it('belong to one person: another can neither list, read, change nor delete them', async () => {
    const repo = new MemoryRepo(db);
    const mine = await repo.create('u1', { section: 'topic', title: 'Beans', summary: 'The dog', details: '- A beagle', source: 'settings' });
    expect((await repo.list('u1')).map((e) => e.id)).toEqual([mine.id]);
    expect(await repo.list('u2')).toEqual([]);
    expect(await repo.get('u2', mine.id)).toBeUndefined();
    expect(await repo.update('u2', mine.id, { details: 'stolen', source: 'chat' })).toBeUndefined();
    expect(await repo.delete('u2', mine.id)).toBe(false);
    expect(await repo.search('u2', 'beans', { limit: 8, sensitive: true })).toEqual([]);
    expect((await repo.get('u1', mine.id))?.details).toBe('- A beagle');
    expect(await repo.delete('u1', mine.id)).toBe(true);
    expect(await repo.list('u1')).toEqual([]);
  });

  it('list by section, then by title as people read numbers and case', async () => {
    const repo = new MemoryRepo(db);
    for (const title of ['Entry 12', 'entry 3', 'Aperture', 'Entry 1']) await repo.create('u1', { section: 'topic', title, summary: '', details: '- x', source: 'settings' });
    await repo.create('u1', { section: 'person', title: 'Alma', summary: '', details: '- x', source: 'settings' });
    expect((await repo.list('u1')).map((e) => e.title)).toEqual(['Aperture', 'Entry 1', 'entry 3', 'Entry 12', 'Alma']);
  });

  it('keep one Preferences and one Profile, with fixed titles, emptied rather than deleted', async () => {
    const repo = new MemoryRepo(db);
    const a = await repo.create('u1', { section: 'preferences', title: 'whatever', summary: '', details: '- Short answers', source: 'settings' });
    const b = await repo.create('u1', { section: 'preferences', title: 'again', summary: '', details: '- Metric units', source: 'chat' });
    expect(b.id).toBe(a.id);
    expect(b.title).toBe('Preferences');
    expect((await repo.list('u1')).filter((e) => e.section === 'preferences')).toHaveLength(1);
    await repo.delete('u1', a.id);
    expect((await repo.get('u1', a.id))?.details).toBe('');
  });

  it('rank search hits by title, then summary, then details, and leave out sensitive ones unless allowed', async () => {
    const repo = new MemoryRepo(db);
    await repo.create('u1', { section: 'topic', title: 'Running', summary: 'Training for a marathon', details: '- Runs in Hyde Park', source: 'chat' });
    await repo.create('u1', { section: 'person', title: 'Sam', summary: 'Brother', details: '- Also likes running', source: 'chat' });
    await repo.create('u1', { section: 'topic', title: 'Running injury', summary: 'Knee', details: '- Physio', sensitive: true, source: 'chat' });
    expect((await repo.search('u1', 'running', { limit: 8, sensitive: false })).map((e) => e.title)).toEqual(['Running', 'Sam']);
    expect((await repo.search('u1', 'running', { limit: 8, sensitive: true })).map((e) => e.title)).toContain('Running injury');
  });
});

describe('memoryFor', () => {
  const base = { userId: 'u1', parentSessionId: null, overrides: {}, temporary: null } as const;
  const p = (memory: Partial<UserPrefs['memory']> = {}) => ({ memory: { searchChats: true, generate: true, sensitive: false, ...memory } });

  it('gives Chat and Cowork everything, Code, sub-agents and signed-out sessions nothing', () => {
    expect(memoryFor({ ...base, mode: 'chat' }, p())).toEqual({ read: true, write: 'free', searchChats: true, generate: true, sensitive: false });
    expect(memoryFor({ ...base, mode: 'work' }, p()).read).toBe(true);
    expect(memoryFor({ ...base, mode: 'code' }, p())).toEqual(NO_MEMORY);
    expect(memoryFor({ ...base, mode: 'work', parentSessionId: 'parent' }, p())).toEqual(NO_MEMORY);
    expect(memoryFor({ ...base, mode: 'chat', userId: null }, p())).toEqual(NO_MEMORY);
  });

  it('lets a temporary chat read memory but not write it, and a "start fresh" one do neither', () => {
    expect(memoryFor({ ...base, mode: 'chat', temporary: 'private' }, p())).toEqual({ read: true, write: null, searchChats: true, generate: false, sensitive: false });
    expect(memoryFor({ ...base, mode: 'chat', temporary: 'fresh' }, p())).toEqual(NO_MEMORY);
  });

  it('lets side chats read and search but never write, and follows the toggles', () => {
    expect(memoryFor({ ...base, mode: 'chat', parentSessionId: 'main', overrides: { sideChat: true } }, p())).toEqual({ read: true, write: null, searchChats: true, generate: false, sensitive: false });
    expect(memoryFor({ ...base, mode: 'chat' }, p({ generate: false })).write).toBe('explicit');
    expect(memoryFor({ ...base, mode: 'chat' }, p({ generate: false })).generate).toBe(false);
    expect(memoryFor({ ...base, mode: 'chat' }, p({ searchChats: false })).searchChats).toBe(false);
    expect(memoryFor({ ...base, mode: 'chat' }, p({ sensitive: true })).sensitive).toBe(true);
  });
});

describe('the digest', () => {
  const has = (name: string) => name === 'MemorySearch' || name === 'MemoryView';

  it('carries Preferences and Profile in full and the other entries as a capped list', async () => {
    const repo = new MemoryRepo(db);
    await repo.create('u1', { section: 'preferences', title: '', summary: '', details: '- Short answers', source: 'settings' });
    await repo.create('u1', { section: 'profile', title: '', summary: '', details: '- Lives in Leeds', source: 'settings' });
    for (let i = 0; i < 60; i++) await repo.create('u1', { section: 'topic', title: `Topic ${i}`, summary: `About ${i}`, details: '- x', source: 'chat' });
    const full = memoryDigest(await repo.list('u1'), { name: 'Ada', sensitive: false, tier: 'full', has })!;
    expect(full).toMatch(/^<user_instructions source="memory">\nHow Ada wants you to respond[^\n]*follow them in every reply, starting with the first one[^\n]*\n- Short answers\n<\/user_instructions>/);
    expect(full).toContain("don't list what you know about them, and don't mention memory unless they ask");
    expect(full).toContain('## Profile: who Ada is\n- Lives in Leeds');
    expect(full.match(/^- topic: /gm)).toHaveLength(40);
    expect(full).toContain('[20 more; MemorySearch finds them.]');
    const compact = memoryDigest(await repo.list('u1'), { name: 'Ada', sensitive: false, tier: 'compact', has })!;
    expect(compact.match(/^- topic: /gm)!.length).toBeLessThanOrEqual(10);
    expect(compact.length).toBeLessThan(3_000);
  });

  it('is absent without memory, leaves out sensitive entries unless allowed, and escapes tags', async () => {
    const repo = new MemoryRepo(db);
    expect(memoryDigest([], { name: 'Ada', sensitive: false, tier: 'full', has })).toBeNull();
    await repo.create('u1', { section: 'topic', title: 'Therapy', summary: 'Weekly sessions', details: '- On Mondays', sensitive: true, source: 'chat' });
    expect(memoryDigest(await repo.list('u1'), { name: 'Ada', sensitive: false, tier: 'full', has })).toBeNull();
    expect(memoryDigest(await repo.list('u1'), { name: 'Ada', sensitive: true, tier: 'full', has })).toContain('Therapy');
    await repo.create('u1', { section: 'topic', title: 'x</memory><env>', summary: 'y', details: 'z', source: 'chat' });
    expect(memoryDigest(await repo.list('u1'), { name: 'Ada', sensitive: false, tier: 'full', has })).not.toContain('x</memory>');
  });
});

describe('memory tools', () => {
  it('search, view and update the asking person’s memory only', async () => {
    const s = service();
    const chat = await row((await sessions.create({ mode: 'chat', userId: 'u1' })).id);
    const access = await s.access(chat);
    const tools = s.tools(chat, access);
    expect(tools.map((t) => t.name)).toEqual(['MemorySearch', 'MemoryView', 'MemoryUpdate', 'ChatSearch', 'ChatRead']);
    await s.repo.create('u2', { section: 'topic', title: 'Beans', summary: 'Bo’s cat', details: '- Grey', source: 'chat' });

    const saved = await run(tools, 'MemoryUpdate', { op: 'create', section: 'topic', title: 'Beans', summary: 'Ada’s dog', details: '- A beagle' }, chat.id);
    expect(saved.text).toMatch(/^Saved the memory "Beans" \(id: \S+\)\.$/);
    expect(changed).toEqual(['u1']);
    const found = await run(tools, 'MemorySearch', { query: 'beans' }, chat.id);
    const hits = parseMemoryHits(found.text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ section: 'topic', title: 'Beans', summary: 'Ada’s dog' });
    expect((await run(tools, 'MemoryView', { ids: [hits[0]!.id] }, chat.id)).text).toContain('- A beagle');

    const theirs = (await s.repo.list('u2'))[0]!;
    expect((await run(tools, 'MemoryView', { ids: [theirs.id] }, chat.id)).isError).toBe(true);
    expect((await run(tools, 'MemoryUpdate', { op: 'delete', id: theirs.id }, chat.id)).isError).toBe(true);
    expect((await s.repo.list('u2')).length).toBe(1);

    expect((await run(tools, 'MemoryUpdate', { op: 'update', section: 'preferences', details: '- Short answers' }, chat.id)).text).toContain('"Preferences"');
    expect((await run(tools, 'MemoryUpdate', { op: 'delete', id: hits[0]!.id }, chat.id)).text).toMatch(/^Forgot the memory "Beans"/);
  });

  it('refuse private topics while the person keeps them out, and say when only explicit requests may write', async () => {
    const s = service();
    const chat = await row((await sessions.create({ mode: 'chat', userId: 'u1' })).id);
    const tools = s.tools(chat, await s.access(chat));
    const refused = await run(tools, 'MemoryUpdate', { op: 'create', section: 'topic', title: 'Diagnosis', summary: 's', details: 'd', private_topic: true }, chat.id);
    expect(refused.isError).toBe(true);
    expect(await s.repo.list('u1')).toEqual([]);

    prefs.u1 = { ...defaultUserPrefs(), memory: { searchChats: false, generate: false, sensitive: false } };
    const explicit = s.tools(chat, await s.access(chat));
    expect(explicit.map((t) => t.name)).toEqual(['MemorySearch', 'MemoryView', 'MemoryUpdate']);
    const update = explicit.find((t) => t.name === 'MemoryUpdate')!;
    expect(typeof update.description === 'function' && update.description({ tier: 'full', mode: 'chat', has: () => true })).toContain('only when they explicitly ask');
  });

  it('give Code sessions and sub-agents none', async () => {
    const s = service();
    const code = await row((await sessions.create({ mode: 'code', userId: 'u1' })).id);
    expect(s.tools(code, await s.access(code))).toEqual([]);
    const parent = await sessions.create({ mode: 'work', userId: 'u1' });
    const sub = await row((await sessions.create({ mode: 'work', userId: 'u1', parentSessionId: parent.id })).id);
    expect(s.tools(sub, await s.access(sub))).toEqual([]);
  });
});

describe('past chat search', () => {
  it('returns short snippets of the person’s own top-level chats, best first', async () => {
    const old = await sessions.create({ mode: 'chat', userId: 'u1', title: 'Kurzfilm planning' });
    await say(old.id, 'user', `Let us plan the short film about the harbour. ${'Lots of detail about the shots and the light. '.repeat(40)}`);
    await say(old.id, 'assistant', 'Here is a shot list for the harbour film.');
    const other = await sessions.create({ mode: 'work', userId: 'u1', title: 'Taxes' });
    await say(other.id, 'user', 'The harbour office sent the tax forms.');
    const theirs = await sessions.create({ mode: 'chat', userId: 'u2', title: 'Harbour film' });
    await say(theirs.id, 'user', 'My harbour film is secret.');
    const child = await sessions.create({ mode: 'work', userId: 'u1', parentSessionId: other.id, title: 'harbour sub-agent' });
    await say(child.id, 'user', 'harbour film research');
    const temp = await sessions.create({ mode: 'chat', userId: 'u1', title: 'Temp', temporary: 'private' });
    await say(temp.id, 'user', 'harbour film in a temporary chat');
    const current = await sessions.create({ mode: 'chat', userId: 'u1' });
    await say(current.id, 'user', 'What did we say about the harbour film?');

    const hits = searchChats(db, { userId: 'u1', excludeSessionId: current.id, query: 'harbour film' });
    expect(hits.map((h) => h.sessionId)).toEqual([old.id, other.id]);
    expect(hits[0]!.messageId).toBeTruthy();
    for (const h of hits) expect(h.snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS);
    expect(searchChats(db, { userId: 'u1', excludeSessionId: current.id, query: 'kurzfilm' }).map((h) => h.sessionId)).toEqual([old.id]);
    expect(searchChats(db, { userId: 'u1', excludeSessionId: current.id, query: 'the of and' })).toEqual([]);
    expect(searchChats(db, { userId: 'u1', excludeSessionId: current.id, query: 'harbour', limit: 50 }).length).toBeLessThanOrEqual(8);
    expect(ftsQuery('Harbour "film"*')).toBe('"harbour"* OR "film"*');
  });

  it('reads a bounded window around a message, cutting long messages, and only the person’s own chats', async () => {
    const chat = await sessions.create({ mode: 'chat', userId: 'u1', title: 'Long chat' });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await say(chat.id, i % 2 ? 'assistant' : 'user', i === 6 ? 'x'.repeat(10_000) : `message ${i}`, 1_000 + i)).id);
    const current = await sessions.create({ mode: 'chat', userId: 'u1' });

    const around = await readChat(sessions, { userId: 'u1', excludeSessionId: current.id, sessionId: chat.id, around: ids[6]! });
    expect(around.text).toContain('messages 5–10 of 12');
    expect(around.text.match(/^### /gm)).toHaveLength(6);
    expect(around.text).toContain(`[… ${10_000 - CHAT_READ_MESSAGE_CHARS} more characters left out]`);
    expect(around.text).toContain('2 later messages');
    const start = await readChat(sessions, { userId: 'u1', excludeSessionId: current.id, sessionId: chat.id, after: 2 });
    expect(start.text).toContain('messages 1–2 of 12');
    const wide = await readChat(sessions, { userId: 'u1', excludeSessionId: current.id, sessionId: chat.id, around: ids[6]!, before: 5, after: 6 });
    expect(wide.text.match(/^### /gm)!.length).toBeLessThanOrEqual(6);

    expect((await readChat(sessions, { userId: 'u2', excludeSessionId: 'x', sessionId: chat.id })).isError).toBe(true);
    expect((await readChat(sessions, { userId: 'u1', excludeSessionId: chat.id, sessionId: chat.id })).isError).toBe(true);
  });

  it('goes through the ChatSearch tool with the format the transcript reads', async () => {
    const s = service();
    const old = await sessions.create({ mode: 'chat', userId: 'u1', title: 'Garden' });
    await say(old.id, 'user', 'Tomatoes need more sun.');
    const chat = await row((await sessions.create({ mode: 'chat', userId: 'u1' })).id);
    const result = await run(s.tools(chat, await s.access(chat)), 'ChatSearch', { query: 'tomatoes' }, chat.id);
    expect(parseChatHits(result.text)).toEqual([expect.objectContaining({ sessionId: old.id, mode: 'chat', title: 'Garden', snippet: 'Tomatoes need more sun.' })]);
  });
});

describe('changes from a model', () => {
  it('parse the JSON object out of whatever surrounds it', () => {
    expect(parseOps('Sure!\n```json\n{"ops":[{"op":"delete","id":"a"},{"op":"bogus"}]}\n```')).toEqual([{ op: 'delete', id: 'a' }]);
    expect(parseOps('no json here')).toEqual([]);
  });

  it('import every fact of a long export in parts, Instructions and Preferences into Preferences, Identity and Career into Profile', async () => {
    const s = service();
    const career = Array.from({ length: 90 }, (_, i) => `[2020-01-${String((i % 28) + 1).padStart(2, '0')}] - Career fact number ${i + 1}: led the migration of billing service ${i + 1} to the new platform`);
    const exported = [
      '```',
      '## Instructions',
      '[2026-03-01] - Never use emoji',
      '[unknown] - Answer in German when I write in German',
      '## Identity',
      '[unknown] - Name is Ada Lovelace',
      '[2025-05-02] - Lives in Leeds with her partner Sam',
      '## Career',
      ...career,
      '## Projects',
      '[2026-07-24] - Building a self-hosted NVR app for her cameras',
      '## Preferences',
      '[unknown] - Likes dark roast coffee',
      '```',
    ].join('\n');
    // Like a model doing its job: every line of the part becomes a detail of the section its heading maps to.
    const sectionFor: Record<string, { section: string; title?: string }> = {
      Instructions: { section: 'preferences' },
      Preferences: { section: 'preferences' },
      Identity: { section: 'profile' },
      Career: { section: 'profile' },
      Projects: { section: 'area', title: 'NVR app' },
    };
    const fake = (req: ChatRequest) => {
      const text = req.messages[0]!.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
      const doc = text.slice(text.indexOf('<document name="pasted export">'));
      const ops: unknown[] = [];
      let heading = '';
      for (const line of doc.split('\n').slice(1)) {
        const h = /^## (\w+)/.exec(line);
        if (h) heading = h[1]!;
        else if (line.startsWith('[')) {
          const { section, title } = sectionFor[heading]!;
          const fact = line.replace(/^\[unknown\] - /, '').replace(/^\[(\S+)\] - (.*)$/, '$2 ($1)');
          ops.push(title ? { op: 'create', section, title, summary: 'Her camera recorder', details: [fact] } : { op: 'update', section, add: [fact] });
        }
      }
      return JSON.stringify({ ops });
    };
    const parts: number[] = [];
    for (let i = 0; i < 10; i++) replies.push(fake);
    const changes = await s.import('u1', exported, { onProgress: (done, total) => parts.push(done, total) });
    expect(requests.length).toBeGreaterThan(1);
    expect(parts.at(-1)).toBe(requests.length);
    const entries = await s.repo.list('u1');
    const all = entries.map((e) => e.details).join('\n');
    for (const n of [1, 45, 90]) expect(all).toContain(`Career fact number ${n}:`);
    expect(entries.find((e) => e.section === 'profile')!.details.split('\n')).toHaveLength(92);
    expect(entries.find((e) => e.section === 'profile')!.details).toContain('- Name is Ada Lovelace');
    expect(entries.find((e) => e.section === 'preferences')!.details).toBe('- Never use emoji (2026-03-01)\n- Answer in German when I write in German\n- Likes dark roast coffee');
    expect(entries.find((e) => e.section === 'area')).toMatchObject({ title: 'NVR app', details: '- Building a self-hosted NVR app for her cameras (2026-07-24)' });
    expect(describeImportChanges(changes)).toBe('Added 3 entries');
  });

  it('merge by appending lines: an update keeps what it doesn’t mention, replaces only superseded lines, and an import never deletes', async () => {
    const s = service();
    const printer = await s.repo.create('u1', { section: 'topic', title: '3D printing', summary: 'Her printers', details: '- Ordered a printer June 2, 2026\n- Prints in PETG', source: 'chat' });
    replies.push(
      JSON.stringify({
        ops: [
          { op: 'update', id: printer.id, add: ['Printer delivered July 24, 2026', 'Prints in PETG'], replace: [{ old: 'Prints in PETG', new: 'Prints in PETG and ASA' }] },
          { op: 'update', section: 'profile', details: '- Lives in Leeds' },
          { op: 'delete', id: printer.id },
        ],
      }),
    );
    const changes = await s.import('u1', 'Hobbies:\n[2026-07-24] - Printer delivered');
    expect(describeImportChanges(changes)).toBe('Added 1 entry, updated 3D printing');
    expect((await s.repo.get('u1', printer.id))!.details).toBe('- Ordered a printer June 2, 2026\n- Prints in PETG and ASA\n- Printer delivered July 24, 2026');
    // A model's whole new details on an update only add the lines that are new.
    replies.push(JSON.stringify({ ops: [{ op: 'update', id: printer.id, details: '- Uses a 0.4 mm nozzle' }] }));
    await s.import('u1', 'More:\nnozzle');
    expect(memoryLines((await s.repo.get('u1', printer.id))!.details)).toEqual(['Ordered a printer June 2, 2026', 'Prints in PETG and ASA', 'Printer delivered July 24, 2026', 'Uses a 0.4 mm nozzle']);
  });

  it('keep an instruction about one entry to that entry', async () => {
    const s = service();
    const a = await s.repo.create('u1', { section: 'topic', title: 'Beans', summary: 'Dog', details: '- Beagle', source: 'chat' });
    const b = await s.repo.create('u1', { section: 'topic', title: 'Tea', summary: 'Drink', details: '- Earl Grey', source: 'chat' });
    replies.push(JSON.stringify({ ops: [{ op: 'update', id: a.id, details: '- Beagle, 4 years old' }, { op: 'delete', id: b.id }, { op: 'create', section: 'topic', title: 'New', summary: 'x', details: 'y' }] }));
    const changes = await s.instruct('u1', 'Beans is 4', { entryId: a.id });
    expect(changes).toEqual([{ op: 'updated', id: a.id, title: 'Beans', section: 'topic' }]);
    expect((await s.repo.list('u1')).map((e) => e.title)).toEqual(['Beans', 'Tea']);
    await expect(s.instruct('u2', 'x', { entryId: a.id })).rejects.toThrow('no longer exists');
    replies.push(JSON.stringify({ ops: [{ op: 'update', section: 'preferences', details: '- Short answers' }, { op: 'delete', id: a.id }] }));
    expect((await s.instruct('u1', 'Keep it short', { section: 'preferences' })).map((c) => `${c.op} ${c.title}`)).toEqual(['created Preferences']);
    expect(await s.repo.get('u1', a.id)).toBeDefined();
  });
});

describe('project memory', () => {
  it('is read and written only inside its project; outside it, chats see the general memory alone', async () => {
    const s = service();
    const projects = new ProjectRepo(db);
    const garden = await projects.create({ name: 'Garden club', description: '', userId: 'u1' });
    const theirs = await projects.create({ name: 'Bo’s', description: '', userId: 'u2' });
    await s.repo.create('u1', { section: 'preferences', title: '', summary: '', details: '- Short answers', source: 'settings' });
    const minutes = await s.repo.create('u1', { section: 'project', title: 'Meeting minutes', summary: 'How the club keeps minutes', details: '- Minutes go out on Fridays', projectId: garden.id, source: 'chat' });
    // Never someone else's project, and never a project entry without a project.
    expect((await s.repo.create('u1', { section: 'project', title: 'Stray', summary: 's', details: '- x', projectId: theirs.id, source: 'chat' })).section).toBe('area');
    expect(minutes).toMatchObject({ section: 'project', projectId: garden.id });

    const inside = await row((await sessions.create({ mode: 'chat', userId: 'u1', projectId: garden.id })).id);
    const outside = await row((await sessions.create({ mode: 'chat', userId: 'u1' })).id);
    const opts = { tier: 'full' as const, has: () => true };
    const inDigest = (await s.digest(inside, await s.access(inside), opts))!;
    expect(inDigest).toContain('## This project, Garden club');
    expect(inDigest).toContain('- Minutes go out on Fridays');
    expect(inDigest).toContain('- Short answers');
    const outDigest = (await s.digest(outside, await s.access(outside), opts))!;
    expect(outDigest).not.toContain('Minutes');
    expect(outDigest).toContain('- Short answers');

    const outTools = s.tools(outside, await s.access(outside));
    expect((await run(outTools, 'MemorySearch', { query: 'minutes' }, outside.id)).text).toMatch(/^No memories match/);
    expect((await run(outTools, 'MemoryView', { ids: [minutes.id] }, outside.id)).isError).toBe(true);
    expect((await run(outTools, 'MemoryUpdate', { op: 'delete', id: minutes.id }, outside.id)).isError).toBe(true);
    const inTools = s.tools(inside, await s.access(inside));
    expect(parseMemoryHits((await run(inTools, 'MemorySearch', { query: 'minutes' }, inside.id)).text)).toHaveLength(1);

    // What a project chat saves for the project belongs to that project, whatever id the model names.
    await run(inTools, 'MemoryUpdate', { op: 'create', section: 'project', title: 'Plot list', summary: 'Who has which plot', details: '- Plot 4 is Sam’s' }, inside.id);
    expect((await s.repo.list('u1')).find((e) => e.title === 'Plot list')).toMatchObject({ section: 'project', projectId: garden.id });
    await run(outTools, 'MemoryUpdate', { op: 'create', section: 'project', title: 'Loose', summary: 'x', details: '- y' }, outside.id);
    expect((await s.repo.list('u1')).find((e) => e.title === 'Loose')).toMatchObject({ section: 'area', projectId: null });

    // A deleted project's entries stay, as areas.
    await projects.delete(garden.id);
    expect((await s.repo.get('u1', minutes.id))).toMatchObject({ section: 'area', projectId: null });
  });
});

describe('editing by hand', () => {
  it('works only while the administrator allows it, and keeps one fact per line', async () => {
    const settings = defaultSettings();
    const s = service({ settings: () => settings });
    const entry = await s.repo.create('u1', { section: 'topic', title: 'Beans', summary: 'Dog', details: '- Beagle', source: 'chat' });
    await expect(s.edit('u1', { id: entry.id }, { title: 'Beans the dog' })).rejects.toBeInstanceOf(MemoryEditingOffError);
    expect((await s.repo.get('u1', entry.id))!.title).toBe('Beans');

    settings.memory.manualEditing = true;
    const saved = await s.edit('u1', { id: entry.id }, { title: 'Beans the dog', summary: 'Ada’s beagle', details: 'Beagle\n\n- Four years old\n' });
    expect(saved).toMatchObject({ title: 'Beans the dog', summary: 'Ada’s beagle', details: '- Beagle\n- Four years old', source: 'settings' });
    expect(changed).toContain('u1');
    // Preferences not written yet is created; another person's entry isn't reachable.
    expect((await s.edit('u1', { section: 'preferences' }, { details: 'Short answers' })).details).toBe('- Short answers');
    await expect(s.edit('u2', { id: entry.id }, { title: 'x' })).rejects.toBeInstanceOf(MemoryNotFoundError);
    await expect(s.edit('u1', { id: entry.id }, { title: '  ' })).rejects.toThrow('needs a title');
  });
});

describe('the model for memory work', () => {
  /** Like the provider registry: `ollama` was removed, `off` is disabled, `local/hidden` is hidden. */
  const resolver = (listed: string[]): ModelResolver => {
    const model = (ref: string): ModelInfo => ({ ...info, ref, providerId: ref.split('/')[0]!, modelId: ref.split('/')[1]!, hidden: ref === 'local/hidden' });
    return {
      resolve: async (ref) => {
        if (ref.startsWith('ollama/')) throw new ModelUnavailableError(`The provider for ${ref} is not configured.`);
        if (ref.startsWith('off/')) throw new ModelUnavailableError('Off is disabled.');
        return { adapter, info: model(ref) };
      },
      listModels: async () => listed.map(model),
      firstAvailable: async () => listed.find((r) => r !== 'local/hidden'),
    };
  };
  const withDefaults = (defaults: Settings['models']['defaults']) => () => {
    const s = defaultSettings();
    return { ...s, models: { ...s.models, defaults } };
  };
  const usedModel = () => requests.at(-1)!.model;

  it('passes over defaults that no longer resolve, then falls back in order', async () => {
    const listed = ['local/first', 'local/chat', 'local/server', 'local/hidden'];
    prefs.u1 = { ...defaultUserPrefs(), models: { ...defaultUserPrefs().models, chat: 'local/chat' } };
    const s = service({ models: resolver(listed), settings: withDefaults({ small: 'ollama/gemma-4-12b:q4_0', chat: 'local/server' }) });
    await s.import('u1', 'Lives in Leeds');
    expect(usedModel()).toBe('chat');

    prefs.u1 = { ...defaultUserPrefs(), models: { ...defaultUserPrefs().models, chat: 'local/gone' } };
    await s.import('u1', 'Lives in Leeds');
    expect(usedModel()).toBe('server');

    const t = service({ models: resolver(listed), settings: withDefaults({ small: 'local/hidden', chat: 'off/x' }) });
    await t.instruct('u1', 'Keep it short');
    expect(usedModel()).toBe('first');
  });

  it('uses a small model that works, and errors only when no model is available', async () => {
    const s = service({ models: resolver(['local/small', 'local/first']), settings: withDefaults({ small: 'local/small', chat: 'ollama/x' }) });
    await s.import('u1', 'Lives in Leeds');
    expect(usedModel()).toBe('small');
    const none = service({ models: resolver([]), settings: withDefaults({ small: 'ollama/x', chat: 'off/y' }) });
    await expect(none.import('u1', 'Lives in Leeds')).rejects.toThrow('No model is available');
  });

  it('runs on the model chosen for the request, when the person can use it', async () => {
    const s = service({ models: resolver(['local/small', 'local/big', 'local/hidden']), settings: withDefaults({ small: 'local/small' }) });
    await s.import('u1', 'Lives in Leeds', { model: 'local/big' });
    expect(usedModel()).toBe('big');
    await s.instruct('u1', 'Keep it short', {}, { model: 'local/big' });
    expect(usedModel()).toBe('big');
    for (const model of ['local/hidden', 'local/unknown', 'ollama/gemma', 'off/x']) await expect(s.import('u1', 'x', { model })).rejects.toBeInstanceOf(ModelChoiceError);
    expect(requests).toHaveLength(2);
  });
});

describe('the background update', () => {
  it('reads what is new once the conversation is idle, drops private topics while they are off, and remembers how far it read', async () => {
    const s = service({ idleMs: 10 });
    const chat = await sessions.create({ mode: 'chat', userId: 'u1' });
    await say(chat.id, 'user', 'My dog Beans turned four. Also, I had surgery last week.');
    await say(chat.id, 'assistant', 'Happy birthday to Beans!');
    replies.push(JSON.stringify({ ops: [{ op: 'create', section: 'topic', title: 'Beans', summary: 'Ada’s dog', details: '- Turned four' }, { op: 'create', section: 'topic', title: 'Surgery', summary: 's', details: 'd', personal: true }] }));
    s.turnEnded(await row(chat.id));
    await new Promise((r) => setTimeout(r, 40));
    await s.settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.system[0]!.text).toContain("Don't keep health");
    expect((await s.repo.list('u1')).map((e) => e.title)).toEqual(['Beans']);
    expect((await s.repo.list('u1'))[0]!.source).toBe('background');

    // Nothing new: no model call.
    expect(await s.generate(chat.id)).toEqual([]);
    expect(requests).toHaveLength(1);
    // Only the new part is read.
    await say(chat.id, 'user', 'I moved to Leeds.');
    replies.push('{"ops":[]}');
    await s.generate(chat.id);
    const text = requests[1]!.messages[0]!.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(text).toContain('I moved to Leeds.');
    expect(text).not.toContain('Beans turned four');
  });

  it("doesn't run for people who turned it off, for Code, sub-agents or temporary chats", async () => {
    const s = service({ idleMs: 5 });
    prefs.u2 = { ...defaultUserPrefs(), memory: { searchChats: true, generate: false, sensitive: false } };
    const off = await sessions.create({ mode: 'chat', userId: 'u2' });
    const code = await sessions.create({ mode: 'code', userId: 'u1' });
    const temp = await sessions.create({ mode: 'chat', userId: 'u1', temporary: 'private' });
    for (const sessionRow of [off, code, temp]) {
      await say(sessionRow.id, 'user', 'Remember that I like tea.');
      s.turnEnded(await row(sessionRow.id));
      expect(await s.generate(sessionRow.id)).toEqual([]);
    }
    await new Promise((r) => setTimeout(r, 30));
    await s.settle();
    expect(requests).toHaveLength(0);
  });

  it('reads waiting conversations at once when the person starts a new one', async () => {
    const s = service({ idleMs: 60_000 });
    const chat = await sessions.create({ mode: 'chat', userId: 'u1' });
    await say(chat.id, 'user', 'I am vegetarian.');
    s.turnEnded(await row(chat.id));
    await new Promise((r) => setTimeout(r, 10));
    s.sessionStarted('u2');
    await s.settle();
    expect(requests).toHaveLength(0);
    s.sessionStarted('u1');
    await s.settle();
    expect(requests).toHaveLength(1);
    s.dispose();
  });
});

describe('in a conversation', () => {
  it('carries the digest in the system prompt and rebuilds it at the next turn after memory changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atelier-memory-'));
    try {
      const s = service();
      const blobs = new BlobStore(db, join(dir, 'blobs'));
      const chat = new ChatService({
        repo: sessions,
        artifacts: new ArtifactRepo(db),
        files: new FileRepo(db, blobs),
        projects: new ProjectRepo(db),
        blobs,
        settings: () => defaultSettings(),
        models: { resolve: async () => ({ adapter, info }), firstAvailable: async () => info.ref },
        promptOverrides: () => ({}),
        sessionEvent: () => {},
        sessionChanged: () => {},
        recordUsage: () => {},
        person: async () => ({ prefs: defaultUserPrefs(), name: 'Ada', safeguards: 'inherit' }),
        fetch: async () => new Response('offline', { status: 503 }),
        resolveRefs: async (v) => v,
        memory: s,
      });
      await s.repo.create('u1', { section: 'preferences', title: '', summary: '', details: '- Short answers', source: 'settings' });
      const session = await sessions.create({ mode: 'chat', userId: 'u1', model: info.ref, title: 'Hi' });
      const system = (req: ChatRequest | undefined) => req!.system.map((b) => b.text).join('\n');
      const turn = async (text: string) => {
        await chat.send(session.id, [{ type: 'text', text }]);
        await chat.settle(session.id);
        return requests.findLast((r) => r.tools?.some((t) => t.name === 'MemorySearch'));
      };
      const first = await turn('Hello');
      expect(system(first)).toMatch(/<user_instructions source="memory">\nHow Ada wants you to respond[^\n]*\n- Short answers/);
      expect(first!.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(['MemorySearch', 'MemoryView', 'MemoryUpdate', 'ChatSearch', 'ChatRead']));
      await s.repo.create('u1', { section: 'person', title: 'Sam', summary: 'Ada’s brother', details: '- Lives in York', source: 'chat' });
      expect(system(await turn('Again'))).toContain('person: Sam: Ada’s brother');
      s.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
