/** Per-person usage limits as the chat service enforces them (ARCHITECTURE §8): before a turn, before every request of a long one. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, defaultUserPrefs, type LimitsSettings, type ModelInfo, type RunEvent, type Settings, type UserLimits } from '@atelier/protocol';
import { openDatabase, type Db } from '../store/db.ts';
import { BlobStore } from '../store/blobs.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { FileRepo } from '../files/file-repo.ts';
import { ProjectRepo } from '../projects/project-repo.ts';
import { users } from '../store/schema.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent } from '../providers/types.ts';
import type { Tool } from '../tools/types.ts';
import type { Workspace } from '../workspaces/workspace.ts';
import { UsageLimits } from '../usage/limits.ts';
import { ChatService, type ChatServiceDeps, type ResolvedModel } from './chat-service.ts';

const info: ModelInfo = {
  ref: 'fake/m',
  providerId: 'fake',
  modelId: 'm',
  displayName: 'Fake',
  contextLength: 100_000,
  maxOutput: 4000,
  capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: false },
  tier: 'full',
  source: 'default',
  hidden: false,
  favorite: false,
  order: 0,
};

const quietPrefs = () => {
  const prefs = defaultUserPrefs();
  return { ...prefs, code: { ...prefs.code, suggestions: false } };
};

const noop: Tool = { name: 'mcp__t__noop', description: 'Does nothing.', inputSchema: { type: 'object' }, readOnly: true, run: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };

const isTitle = (req: ChatRequest) => req.system.some((b) => b.text.includes('short title'));
const isSuggestion = (req: ChatRequest) => req.system.some((b) => b.text.includes("person's next message"));
const isChild = (req: ChatRequest) => !req.tools?.some((t) => t.name === 'Agent');

let dir: string;
let db: Db;
let repo: SessionRepo;
let settings: Settings;
let events: { sessionId: string; event: RunEvent }[];
let counter: UsageLimits;
let overrides: Record<string, UserLimits>;
let requests: ChatRequest[];

const limit = (limits: LimitsSettings) => (settings = { ...settings, limits });

/** Every step calls the no-op tool again and uses `perRequest` tokens, until `steps` requests were made; then it says it is done. */
function worker(perRequest: number, steps = 50): ProviderAdapter {
  let n = 0;
  return {
    type: 'openai-compatible',
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
    async *stream(req): AsyncIterable<StreamEvent> {
      requests.push(req);
      if (isTitle(req)) return yield { type: 'finish', reason: 'end' };
      n++;
      yield { type: 'usage', usage: { input: perRequest, output: 0 } };
      if (n > steps) {
        yield { type: 'text', delta: 'Done.' };
        return yield { type: 'finish', reason: 'end' };
      }
      yield { type: 'tool_call_start', id: `c${n}`, name: noop.name };
      yield { type: 'tool_call_end', id: `c${n}`, input: { step: n } };
      yield { type: 'finish', reason: 'tool_use' };
    },
  };
}

function service(adapter: ProviderAdapter, extra: Partial<ChatServiceDeps> = {}, prefs = quietPrefs()) {
  const blobs = new BlobStore(db, join(dir, 'blobs'));
  return new ChatService({
    repo,
    artifacts: new ArtifactRepo(db),
    files: new FileRepo(db, blobs),
    projects: new ProjectRepo(db),
    blobs,
    settings: () => settings,
    models: { resolve: async () => ({ adapter, info }) satisfies ResolvedModel, firstAvailable: async () => 'fake/m' },
    promptOverrides: () => ({}),
    sessionEvent: (sessionId, _seq, event) => events.push({ sessionId, event }),
    sessionChanged: () => {},
    // What the backend does: the total is kept before the row is stored.
    recordUsage: ({ userId, usage }) => counter.record(userId, { tokens: usage.input + usage.output, costUsd: null }),
    person: async () => ({ prefs, name: 'Tester', safeguards: 'inherit' as const }),
    fetch: async () => new Response('offline', { status: 503 }),
    resolveRefs: async (v) => v,
    now: () => new Date('2026-10-13T12:00:00Z'),
    timeZone: 'UTC',
    mcpTools: async () => [noop],
    loopMinIntervalMs: 20,
    limits: { admit: (u) => counter.admit(u), check: (u) => counter.check(u), warnings: (u) => counter.warnings(u) },
    ...extra,
  });
}

const lastAssistant = async (sessionId: string) => (await repo.branch(sessionId)).messages.findLast((m) => m.role === 'assistant')!;
const mainRequests = () => requests.filter((r) => !isTitle(r));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-limits-'));
  db = openDatabase(':memory:');
  repo = new SessionRepo(db);
  events = [];
  requests = [];
  overrides = {};
  settings = defaultSettings();
  for (const id of ['ada', 'bob']) await db.insert(users).values({ id, username: id, name: id === 'ada' ? 'Ada' : 'Bob', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  counter = new UsageLimits({ db, settings: () => settings, person: async (id) => overrides[id] ?? null, admins: async () => ['Grace'] });
});
afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a turn that starts over a limit', () => {
  it('sends nothing: the reply is an error that names the limit, when it resets and who to ask, and it is not retryable', async () => {
    limit({ tokensPerDay: 500 });
    counter.record('ada', { tokens: 500, costUsd: null });
    const chat = service(worker(10, 0));
    const s = await repo.create({ mode: 'chat', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Hello' }]);
    await chat.settle(s.id);
    expect(requests).toEqual([]);
    const reply = await lastAssistant(s.id);
    expect(reply).toMatchObject({ stopReason: 'error', parts: [], error: { code: 'limit_reached', retryable: false } });
    // Within the last hour before midnight UTC the reset is minutes away, not hours.
    expect(reply.error?.message).toMatch(/^You’ve reached your limit of 500 tokens \(tokens per day\)\. It lets requests through again at 00:00 UTC \(in (?:about \d+ hours?|\d+ minutes?)\)\. Ask an admin \(Grace\) if you need more before then\.$/);
    expect((await repo.get(s.id))?.status).toBe('error');
  });

  it('leaves other people, and a person with no limit set, alone', async () => {
    limit({ tokensPerDay: 500 });
    counter.record('ada', { tokens: 500, costUsd: null });
    const chat = service(worker(10, 0));
    const other = await repo.create({ mode: 'chat', userId: 'bob' });
    await chat.send(other.id, [{ type: 'text', text: 'Hello' }]);
    await chat.settle(other.id);
    expect((await lastAssistant(other.id)).error).toBeNull();
    // No limits set at all: nothing is checked, however much was used.
    limit({});
    const mine = await repo.create({ mode: 'chat', userId: 'ada' });
    await chat.send(mine.id, [{ type: 'text', text: 'Hello' }]);
    await chat.settle(mine.id);
    expect((await lastAssistant(mine.id)).error).toBeNull();
  });

  it('runs for a person an admin made exempt', async () => {
    limit({ tokensPerDay: 500 });
    overrides.ada = { exempt: true };
    counter.record('ada', { tokens: 5000, costUsd: null });
    const chat = service(worker(10, 0));
    const s = await repo.create({ mode: 'chat', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Hello' }]);
    await chat.settle(s.id);
    expect(mainRequests()).toHaveLength(1);
    expect((await lastAssistant(s.id)).error).toBeNull();
  });

  it('works without any limits wired in (a backend from before them, tests)', async () => {
    const chat = service(worker(10, 0), { limits: undefined });
    const s = await repo.create({ mode: 'chat', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Hello' }]);
    await chat.settle(s.id);
    expect((await lastAssistant(s.id)).error).toBeNull();
  });
});

describe('a long agent turn', () => {
  it('stops before the first request that would start over the limit, with the error on its last reply, so it passes by at most one request', async () => {
    limit({ tokensPerDay: 250 });
    const chat = service(worker(100));
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Work' }]);
    await chat.settle(s.id);
    // 100 and 200 are under 250, the third request starts at 200 and ends at 300, the fourth is refused.
    expect(mainRequests()).toHaveLength(3);
    const last = await lastAssistant(s.id);
    expect(last).toMatchObject({ stopReason: 'error', parts: [], error: { code: 'limit_reached', retryable: false } });
    expect(last.error?.message).toContain('250 tokens (tokens per day)');
    expect((await repo.get(s.id))?.status).toBe('error');
    // The tool results of the steps that ran are all there.
    expect((await repo.branch(s.id)).messages.filter((m) => m.role === 'tool')).toHaveLength(3);
    // And it is done: nothing starts again by itself.
    await new Promise((r) => setTimeout(r, 50));
    expect(mainRequests()).toHaveLength(3);
  });

  it('counts cost limits the same way and leaves requests without a price out', async () => {
    limit({ costUsdPerDay: 0.5 });
    let priced = 0;
    const chat = service(worker(100, 4), { recordUsage: ({ userId, usage }) => counter.record(userId, { tokens: usage.input, costUsd: priced++ < 2 ? 0.3 : null }) });
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Work' }]);
    await chat.settle(s.id);
    // Two priced requests ($0.60) reach it; the unpriced ones never would have.
    expect(mainRequests()).toHaveLength(2);
    expect((await lastAssistant(s.id)).error?.message).toContain('$0.50 (cost per day)');
  });

  it('counts runs together: two sessions of one person share the limit, and starting both at once gets nobody more than it allows', async () => {
    limit({ requestsPerHour: 4 });
    const adaRequests: ChatRequest[] = [];
    const bobRequests: ChatRequest[] = [];
    // Each person's model keeps working until it is stopped; the requests of both of Ada's sessions land in one list.
    const workerFor = (into: ChatRequest[], steps: number): ProviderAdapter => {
      const inner = worker(1, steps);
      return {
        ...inner,
        async *stream(req) {
          if (!isTitle(req)) into.push(req);
          yield* inner.stream(req);
        },
      };
    };
    const ada = workerFor(adaRequests, 100);
    const bob = workerFor(bobRequests, 2);
    const chat = service(ada, { models: { resolve: async (_ref, userId) => ({ adapter: userId === 'bob' ? bob : ada, info }), firstAvailable: async () => 'fake/m' } });
    const a = await repo.create({ mode: 'code', userId: 'ada' });
    const b = await repo.create({ mode: 'code', userId: 'ada' });
    const c = await repo.create({ mode: 'code', userId: 'bob' });
    await Promise.all([a.id, b.id, c.id].map((id) => chat.send(id, [{ type: 'text', text: 'Work' }])));
    await Promise.all([a.id, b.id, c.id].map((id) => chat.settle(id)));
    expect(adaRequests).toHaveLength(4);
    expect([(await lastAssistant(a.id)).error?.code, (await lastAssistant(b.id)).error?.code]).toEqual(['limit_reached', 'limit_reached']);
    // Bob's total is his own: three requests, under his limit of four, and his turn ends by itself.
    expect(bobRequests).toHaveLength(3);
    expect((await lastAssistant(c.id)).error).toBeNull();
  });

  it('stops a turn a Stop hook sent back to work, with the error on a reply of its own when the new turn has none', async () => {
    limit({ tokensPerDay: 100 });
    // The reply uses the whole limit and ends the turn; the Stop hook asks for more work, and that turn's first request is refused.
    const workspace = {
      id: 'w',
      deviceId: null,
      root: '/work/app',
      home: '/home/me',
      os: 'darwin',
      shell: '/bin/zsh',
      pathSep: '/',
      shellFor: async () => 'shell',
      runner: { call: async () => ({ exitCode: 2, stdout: '', stderr: 'run the tests first', timedOut: false, truncated: false }), on: () => () => {} },
    } as unknown as Workspace;
    const chat = service(worker(100, 0), { hooks: async () => ({ workspace, configs: [{ Stop: [{ hooks: [{ type: 'command', command: 'check' }] }] }] }) });
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Work' }]);
    await chat.settle(s.id);
    expect(mainRequests()).toHaveLength(1);
    const reply = await lastAssistant(s.id);
    expect(reply).toMatchObject({ stopReason: 'error', parts: [], error: { code: 'limit_reached' } });
    expect((await repo.get(s.id))?.status).toBe('error');
  });
});

describe('sub-agents and loops', () => {
  it('stops a sub-agent that reaches the limit, tells its parent plainly, and ends the parent’s turn at its next request', async () => {
    limit({ tokensPerDay: 250 });
    let parentSteps = 0;
    const adapter: ProviderAdapter = {
      ...worker(100),
      async *stream(req): AsyncIterable<StreamEvent> {
        requests.push(req);
        if (isTitle(req)) return yield { type: 'finish', reason: 'end' };
        if (!isChild(req)) {
          parentSteps++;
          yield { type: 'usage', usage: { input: 0, output: 0 } };
          if (parentSteps > 1) return yield* [{ type: 'text', delta: 'Done.' }, { type: 'finish', reason: 'end' }] as StreamEvent[];
          yield { type: 'tool_call_start', id: 'a1', name: 'Agent' };
          yield { type: 'tool_call_end', id: 'a1', input: { description: 'Dig', prompt: 'Dig.', subagent_type: 'general-purpose' } };
          return yield { type: 'finish', reason: 'tool_use' };
        }
        const n = requests.filter((r) => !isTitle(r) && isChild(r)).length;
        yield { type: 'usage', usage: { input: 100, output: 0 } };
        yield { type: 'tool_call_start', id: `k${n}`, name: noop.name };
        yield { type: 'tool_call_end', id: `k${n}`, input: { step: n } };
        yield { type: 'finish', reason: 'tool_use' };
      },
    };
    const chat = service(adapter);
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Delegate' }]);
    await chat.settle(s.id);
    expect(requests.filter((r) => !isTitle(r) && isChild(r))).toHaveLength(3);
    const messages = (await repo.branch(s.id)).messages;
    const result = messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result');
    expect(JSON.stringify(result)).toContain('The sub-agent failed: You’ve reached your limit of 250 tokens');
    // The parent made no second request: its turn ends with the same error.
    expect(parentSteps).toBe(1);
    expect(messages.at(-1)?.error?.code).toBe('limit_reached');
    const link = messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_call' && p.name === 'Agent');
    const childId = link?.type === 'tool_call' ? link.childSessionId : undefined;
    expect(childId).toBeDefined();
    expect((await lastAssistant(childId!)).error?.code).toBe('limit_reached');
  });

  it('ends a loop that finds its person over the limit, once, with a note that says so, and sends nothing', async () => {
    limit({ tokensPerDay: 100 });
    counter.record('ada', { tokens: 100, costUsd: null });
    const chat = service(worker(10, 0));
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    chat.startLoop(s.id, 'ping', 20, 'ada');
    await vi.waitFor(() => expect(chat.tasks.list(s.id)[0]).toMatchObject({ kind: 'loop', status: 'stopped' }));
    await new Promise((r) => setTimeout(r, 120));
    expect(requests).toEqual([]);
    const messages = (await repo.branch(s.id)).messages;
    // No prompt was sent, and only one error was written however many intervals went by.
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(0);
    const errors = messages.filter((m) => m.error);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toMatchObject({ code: 'limit_reached' });
    expect(errors[0]?.error?.message).toMatch(/The loop was stopped; start it again once the limit resets\.$/);
  });

  it('lets a turn for background sub-agents’ ends wait quietly when the person is over the limit', async () => {
    limit({ tokensPerDay: 100 });
    // The parent's first request uses the whole limit and starts a background sub-agent.
    let n = 0;
    const adapter: ProviderAdapter = {
      ...worker(100),
      async *stream(req): AsyncIterable<StreamEvent> {
        requests.push(req);
        if (isTitle(req)) return yield { type: 'finish', reason: 'end' };
        if (isChild(req)) return yield* [{ type: 'text', delta: 'Found it.' }, { type: 'finish', reason: 'end' }] as StreamEvent[];
        n++;
        yield { type: 'usage', usage: { input: 100, output: 0 } };
        yield { type: 'tool_call_start', id: 'a1', name: 'Agent' };
        yield { type: 'tool_call_end', id: 'a1', input: { description: 'Dig', prompt: 'Dig.', subagent_type: 'general-purpose', run_in_background: true } };
        yield { type: 'finish', reason: 'tool_use' };
      },
    };
    const chat = service(adapter);
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Delegate' }]);
    await chat.settle(s.id);
    await vi.waitFor(() => expect(chat.tasks.list(s.id)[0]?.status).not.toBe('running'));
    await new Promise((r) => setTimeout(r, 100));
    await chat.settle(s.id);
    expect(n).toBe(1);
    const errors = (await repo.branch(s.id)).messages.filter((m) => m.error);
    // The one error is the turn's own; the sub-agent's end did not start a turn that fails again.
    expect(errors).toHaveLength(1);
  });
});

describe('requests nobody asked for', () => {
  it('skip the suggestion of a next message when the person is over a limit, without a word and without failing the turn', async () => {
    limit({ tokensPerDay: 100 });
    const prefs = defaultUserPrefs();
    const chat = service(worker(100, 0), {}, { ...prefs, code: { ...prefs.code, suggestions: true } });
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Work' }]);
    await chat.settle(s.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(requests.filter(isSuggestion)).toEqual([]);
    expect(events.some((e) => e.sessionId === s.id && e.event.type === 'suggestion' && e.event.text)).toBe(false);
    const reply = await lastAssistant(s.id);
    expect(reply).toMatchObject({ stopReason: 'end', error: null });
    expect((await repo.get(s.id))?.status).toBe('idle');
  });

  it('write the title from the first words when the person is over a limit, without asking a model', async () => {
    limit({ tokensPerDay: 100 });
    counter.record('ada', { tokens: 100, costUsd: null });
    const chat = service(worker(10, 0));
    const s = await repo.create({ mode: 'chat', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Plan a trip to Lisbon in spring' }]);
    await chat.settle(s.id);
    // The turn itself was refused before a title was thought of; ask for one the way a later turn would.
    const model = await (chat as unknown as { deps: ChatServiceDeps }).deps.models.resolve('fake/m', 'ada');
    await (chat as unknown as { generateTitle(id: string, m: ResolvedModel): Promise<void> }).generateTitle(s.id, model);
    expect(requests).toEqual([]);
    expect((await repo.get(s.id))?.title).toBe('Plan a trip to Lisbon in');
  });

  it('count toward the limits once they are made', async () => {
    limit({ tokensPerDay: 1000 });
    const adapter: ProviderAdapter = {
      ...worker(0),
      async *stream(req): AsyncIterable<StreamEvent> {
        yield { type: 'usage', usage: { input: 30, output: 12 } };
        if (isTitle(req)) yield { type: 'text', delta: 'A title' };
        else yield { type: 'text', delta: 'Hi.' };
        yield { type: 'finish', reason: 'end' };
      },
    };
    const chat = service(adapter, {
      recordUsage: ({ userId, usage }) => counter.record(userId, { tokens: usage.input + usage.output, costUsd: null }),
    });
    const s = await repo.create({ mode: 'chat', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'Hello' }]);
    await chat.settle(s.id);
    await vi.waitFor(async () => expect((await repo.get(s.id))?.title).toBe('A title'));
    // The reply and the title, 42 tokens each.
    expect((await counter.status('ada')).rows[0]?.used).toBe(84);
  });

  it('refuse a /compact the person asked for, in plain words', async () => {
    limit({ tokensPerDay: 100 });
    counter.record('ada', { tokens: 100, costUsd: null });
    const chat = service(worker(10, 0));
    const s = await repo.create({ mode: 'code', userId: 'ada' });
    await expect(chat.compact(s.id)).rejects.toThrow(/^You’ve reached your limit of 100 tokens/);
    expect(requests).toEqual([]);
  });
});

describe('the warning at 80%', () => {
  it('is sent once to the session that passed it, kept for a reload, and taken back when the next turn starts', async () => {
    limit({ tokensPerDay: 1000 });
    counter.record('ada', { tokens: 790, costUsd: null });
    const chat = service(worker(20, 0));
    const s = await repo.create({ mode: 'chat', userId: 'ada' });
    const warnings = () => events.flatMap((e) => (e.sessionId === s.id && e.event.type === 'limit_warning' ? [e.event.warning] : []));
    await chat.send(s.id, [{ type: 'text', text: 'One' }]);
    await chat.settle(s.id);
    await vi.waitFor(async () => expect((await chat.snapshot(s.id)).limitWarning).toMatchObject({ key: 'tokensPerDay', used: 810, max: 1000 }));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toMatch(/^You’ve used 81% of your limit of 1,000 tokens \(tokens per day\)\. It resets at 00:00 UTC/);
    // The next turn takes it back, and does not warn again for the same limit and day.
    await chat.send(s.id, [{ type: 'text', text: 'Two' }]);
    await chat.settle(s.id);
    expect(warnings()).toEqual([expect.objectContaining({ key: 'tokensPerDay' }), null]);
    expect((await chat.snapshot(s.id)).limitWarning).toBeNull();
  });

  it('is not sent for a limit that is only reached: the next request says so', async () => {
    limit({ tokensPerDay: 100 });
    const chat = service(worker(100, 0));
    const s = await repo.create({ mode: 'chat', userId: 'ada' });
    await chat.send(s.id, [{ type: 'text', text: 'One' }]);
    await chat.settle(s.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(events.filter((e) => e.event.type === 'limit_warning')).toEqual([]);
  });
});
