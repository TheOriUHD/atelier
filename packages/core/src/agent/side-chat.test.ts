import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, defaultUserPrefs, type Message, type ModelInfo, type Settings } from '@atelier/protocol';
import { openDatabase, type Db } from '../store/db.ts';
import { BlobStore } from '../store/blobs.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { FileRepo } from '../files/file-repo.ts';
import { ProjectRepo } from '../projects/project-repo.ts';
import type { PermissionContext } from '../permissions/engine.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent } from '../providers/types.ts';
import type { Tool } from '../tools/types.ts';
import { ChatService, type ChatServiceDeps } from './chat-service.ts';
import { isSideChat, mainTranscript, SIDE_CHAT_EFFORT, sideChatTitle, sideChatTools } from './side-chat.ts';

const info: ModelInfo = {
  ref: 'fake/m',
  providerId: 'fake',
  modelId: 'm',
  displayName: 'Fake',
  contextLength: 100_000,
  maxOutput: 4000,
  capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'effort', caching: false },
  tier: 'full',
  source: 'default',
  hidden: false,
  favorite: false,
  order: 0,
};

const textOf = (req: ChatRequest) => req.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : []))).join('\n');
const isTitle = (req: ChatRequest) => req.system.some((b) => b.text.includes('short title'));
const isSide = (req: ChatRequest) => textOf(req).includes('This is a side chat');

let dir: string;
let db: Db;
let repo: SessionRepo;
let settings: Settings;

/**
 * Main requests answer "Working on it." (held until `releaseMain()` while `holdMain`), side requests answer from
 * `side(req, n)`, by default "It is a demo project.".
 */
function harness(opts: { holdMain?: boolean; side?: (req: ChatRequest, n: number) => StreamEvent[]; deps?: Partial<ChatServiceDeps> } = {}) {
  let releaseMain!: () => void;
  const held = new Promise<void>((r) => (releaseMain = r));
  const main: ChatRequest[] = [];
  const side: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    type: 'openai-compatible',
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
    async *stream(req): AsyncIterable<StreamEvent> {
      if (isTitle(req)) return yield { type: 'finish', reason: 'end' };
      if (isSide(req)) {
        side.push(req);
        const events = opts.side?.(req, side.length) ?? [
          { type: 'text', delta: 'It is a demo project.' },
          { type: 'finish', reason: 'end' },
        ];
        for (const e of events) yield e;
        return;
      }
      main.push(req);
      yield { type: 'text', delta: 'Working on it.' };
      if (opts.holdMain) await Promise.race([held, new Promise((r) => req.signal.addEventListener('abort', r))]);
      if (req.signal.aborted) return yield { type: 'finish', reason: 'aborted' };
      yield { type: 'finish', reason: 'end' };
    },
  };
  const blobs = new BlobStore(db, join(dir, 'blobs'));
  const chat = new ChatService({
    repo,
    artifacts: new ArtifactRepo(db),
    files: new FileRepo(db, blobs),
    projects: new ProjectRepo(db),
    blobs,
    settings: () => settings,
    models: { resolve: async () => ({ adapter, info }), firstAvailable: async () => 'fake/m' },
    promptOverrides: () => ({}),
    sessionEvent: () => {},
    sessionChanged: () => {},
    recordUsage: () => {},
    person: async () => ({ prefs: defaultUserPrefs(), name: 'Tester', safeguards: 'inherit' as const }),
    fetch: async () => new Response('offline', { status: 503 }),
    resolveRefs: async (v) => v,
    now: () => new Date('2026-10-13T12:00:00Z'),
    timeZone: 'UTC',
    ...opts.deps,
  });
  return { chat, main, side, releaseMain };
}

const words = (messages: Message[]) => messages.map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).join('\n');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-side-'));
  db = openDatabase(':memory:');
  repo = new SessionRepo(db);
  settings = defaultSettings();
});
afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe('side chats', () => {
  it('answer from the main conversation, which never hears of them', async () => {
    const { chat, main, side } = harness();
    const s = await repo.create({ mode: 'code', title: 'Build the demo', model: 'fake/m' });
    await chat.send(s.id, [{ type: 'text', text: 'Set up the demo project with a README.' }]);
    await chat.settle(s.id);

    const btw = await chat.startSideChat(s.id, 'what is this project about?');
    await chat.settle(btw.id);
    expect(btw.title).toBe('what is this project about?');
    expect(side).toHaveLength(1);
    const asked = textOf(side[0]!);
    // The main transcript rides on the side chat's own question, as a note.
    expect(asked).toContain('This is a side chat: the person asked this beside their main session "Build the demo"');
    expect(asked).toContain('<transcript>\nUser: Set up the demo project with a README.\n\nAssistant: Working on it.\n</transcript>');
    expect(asked.indexOf('<transcript>')).toBeLessThan(asked.indexOf('what is this project about?'));
    expect(side[0]!.effort).toBe(SIDE_CHAT_EFFORT);

    // Stored: the question as the person sent it and the answer, without the note.
    const stored = (await repo.branch(btw.id)).messages;
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[0]!.parts).toEqual([{ type: 'text', text: 'what is this project about?' }]);
    expect(words(stored)).toContain('It is a demo project.');

    // The main session: none of it, in its messages or its next request.
    await chat.send(s.id, [{ type: 'text', text: 'Now add tests.' }]);
    await chat.settle(s.id);
    const mainWords = words((await repo.branch(s.id)).messages);
    expect(mainWords).not.toContain('what is this project about?');
    expect(mainWords).not.toContain('demo project.');
    expect(textOf(main.at(-1)!)).not.toContain('what is this project about?');
    expect((await chat.sideChats(s.id)).map((c) => c.id)).toEqual([btw.id]);
    // Hidden from the lists, like a sub-agent.
    expect((await repo.list({ limit: 50 })).map((r) => r.id)).toEqual([s.id]);
  });

  it('run while the main session runs, without stopping or waiting for it, and see its reply so far', async () => {
    const { chat, main, side, releaseMain } = harness({ holdMain: true });
    const s = await repo.create({ mode: 'code', model: 'fake/m' });
    await chat.send(s.id, [{ type: 'text', text: 'Refactor the parser.' }]);
    await expect.poll(() => main.length).toBe(1);

    const btw = await chat.startSideChat(s.id, 'which parser?');
    await chat.settle(btw.id);
    expect(chat.isRunning(s.id)).toBe(true);
    expect(textOf(side[0]!)).toContain('The main session is still working');
    expect(textOf(side[0]!)).toContain('Assistant: Working on it.');
    // Queued as a sub-agent's request, on the main session's model: a one-model server holds no second model for it.
    expect(side[0]!.queue).toMatchObject({ priority: 'subagent', owner: btw.id });
    expect(main[0]!.queue).toMatchObject({ priority: 'foreground' });

    // A follow-up gets a fresh snapshot of the main conversation, and only the newest message carries it.
    await chat.send(btw.id, [{ type: 'text', text: 'and why?' }]);
    await chat.settle(btw.id);
    expect(side).toHaveLength(2);
    expect(textOf(side[1]!).match(/This is a side chat/g)).toHaveLength(1);

    releaseMain();
    await chat.settle(s.id);
    expect((await repo.branch(s.id)).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('only read: no edits, commands, questions, sub-agents or plans, and connectors only when read-only', async () => {
    const tool = (name: string, readOnly: boolean): Tool => ({ name, description: name, inputSchema: { type: 'object' }, readOnly, run: async () => ({ content: [] }) });
    const { chat, side } = harness({ deps: { mcpTools: async () => [tool('mcp__docs__search', true), tool('mcp__docs__publish', false)] } });
    const s = await repo.create({ mode: 'code', model: 'fake/m' });
    const btw = await chat.startSideChat(s.id, 'anything?');
    await chat.settle(btw.id);
    expect(side[0]!.tools?.map((t) => t.name)).toEqual(['WebSearch', 'WebFetch', 'mcp__docs__search']);

    const code = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell', 'TodoWrite', 'AskUser', 'Agent', 'Skill', 'ExitPlanMode', 'WebSearch', 'WebFetch', 'artifact', 'inline_visual'].map((n) =>
      tool(n, ['Read', 'Glob', 'Grep', 'BashOutput', 'Agent', 'Skill', 'WebSearch', 'WebFetch', 'inline_visual'].includes(n)),
    );
    expect(sideChatTools('code', code).map((t) => t.name)).toEqual(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
    // A chat's Read is its own sandbox's.
    expect(sideChatTools('chat', code).map((t) => t.name)).toEqual(['Glob', 'Grep', 'WebSearch', 'WebFetch']);
  });

  it("follow the main session's permission mode and ask in their own pane", async () => {
    const lookup: Tool = { name: 'mcp__docs__search', description: 'Searches.', inputSchema: { type: 'object' }, readOnly: true, run: async () => ({ content: [{ type: 'text', text: 'found' }] }) };
    const gate: PermissionContext = { mode: 'default', rules: { allow: [], ask: [], deny: [] }, cwd: '/w', home: '/h', projectRoot: '/w', roots: ['/w'], isReadOnly: () => true };
    const modes: (string | null)[] = [];
    const { chat } = harness({
      side: (_req, n) =>
        n === 1
          ? [
              { type: 'tool_call_start', id: 'c1', name: lookup.name },
              { type: 'tool_call_end', id: 'c1', input: {} },
              { type: 'finish', reason: 'tool_use' },
            ]
          : [
              { type: 'text', delta: 'Done.' },
              { type: 'finish', reason: 'end' },
            ],
      deps: {
        mcpTools: async () => [lookup],
        permissionContext: async (row) => {
          modes.push(row.permissionMode);
          return { ...gate, mode: (row.permissionMode as PermissionContext['mode'] | null) ?? 'default' };
        },
      },
    });
    const s = await repo.create({ mode: 'code', model: 'fake/m', permissionMode: 'default' });
    const btw = await chat.startSideChat(s.id, 'search the docs');
    await repo.update(s.id, { permissionMode: 'plan' });
    await expect.poll(async () => (await repo.getRow(btw.id))?.pending?.kind).toBe('permission');
    expect((await repo.getRow(s.id))?.pending).toBeNull();
    expect(modes.at(-1)).toBe('plan');
    const pending = (await repo.getRow(btw.id))!.pending!;
    expect(chat.respond(btw.id, pending.id, { behavior: 'allow' })).toBe(true);
    await chat.settle(btw.id);
    expect(words((await repo.branch(btw.id)).messages)).toContain('Done.');
  });

  it('use the main session’s model as it is now, at a modest effort', async () => {
    const { chat } = harness();
    const s = await repo.create({ mode: 'code', model: 'fake/m', effort: 'max' });
    const btw = await chat.startSideChat(s.id);
    const row = (await repo.getRow(btw.id))!;
    expect(isSideChat(row)).toBe(true);
    expect(row).toMatchObject({ effort: SIDE_CHAT_EFFORT, model: 'fake/m', title: '', parentSessionId: s.id });
    expect((await repo.branch(btw.id)).messages).toEqual([]);
    await expect(chat.startSideChat(btw.id, 'nested?')).rejects.toThrow('main session');
  });

  it('are stopped and deleted with their main session', async () => {
    let started = false;
    const { chat } = harness({
      side: () => {
        started = true;
        return [{ type: 'text', delta: 'Thinking' }];
      },
    });
    const s = await repo.create({ mode: 'code', model: 'fake/m' });
    const btw = await chat.startSideChat(s.id, 'a long question');
    await expect.poll(() => started).toBe(true);
    await chat.discard(s.id);
    expect(chat.isRunning(btw.id)).toBe(false);
    await repo.delete(s.id);
    expect(await repo.getRow(btw.id)).toBeUndefined();
  });
});

describe('mainTranscript', () => {
  const message = (role: Message['role'], text: string, i: number): Message => ({
    id: `m${i}`,
    sessionId: 's',
    parentId: null,
    role,
    parts: [{ type: 'text', text }],
    model: null,
    usage: null,
    stopReason: null,
    error: null,
    kind: 'normal',
    summarizesThroughId: null,
    createdAt: i,
  });

  it('keeps the start and as much of the newest part as fits, saying what it left out', () => {
    const messages = Array.from({ length: 40 }, (_, i) => message(i % 2 ? 'assistant' : 'user', `message ${i} ${'x'.repeat(80)}`, i));
    const text = mainTranscript(messages, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.startsWith('User: message 0 ')).toBe(true);
    expect(text).toMatch(/\[… \d+ earlier messages left out …\]/);
    expect(text.endsWith(`Assistant: message 39 ${'x'.repeat(80)}`)).toBe(true);
    expect(mainTranscript(messages.slice(0, 2), 10_000)).toBe(`User: message 0 ${'x'.repeat(80)}\n\nAssistant: message 1 ${'x'.repeat(80)}`);
    expect(mainTranscript([], 1000)).toBe('');
  });

  it('titles a side chat with its question on one line', () => {
    expect(sideChatTitle('  what is\n this?  ')).toBe('what is this?');
    expect(sideChatTitle('q'.repeat(200))).toHaveLength(80);
  });
});
