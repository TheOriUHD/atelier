import { describe, expect, it } from 'vitest';
import { defaultLimits, isLocalServer, RequestScheduler, type ServerLimits } from './scheduler.ts';
import type { ChatRequest, ProviderAdapter, QueuePriority, StreamEvent } from './types.ts';

/** An adapter whose streams stay open until the test finishes them, recording which models run at once. */
function gpu() {
  const open = new Map<string, () => void>();
  const log: string[] = [];
  let peak = 0;
  const adapter: ProviderAdapter = {
    type: 'ollama',
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
    async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
      const id = String(request.messages[0]?.id);
      log.push(`start ${id}`);
      peak = Math.max(peak, open.size + 1);
      await new Promise<void>((resolve) => {
        open.set(id, resolve);
        request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      open.delete(id);
      yield { type: 'finish', reason: request.signal.aborted ? 'aborted' : 'end' };
    },
  };
  return { adapter, log, open, finish: (id: string) => open.get(id)?.(), peak: () => peak };
}

function request(id: string, model: string, opts: { priority?: QueuePriority; signal?: AbortSignal; onWait?: (n: number | null) => void; timeoutMs?: number; owner?: string } = {}): ChatRequest {
  return {
    model,
    system: [],
    messages: [{ id, sessionId: 's', parentId: null, role: 'user', parts: [], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 }],
    maxOutputTokens: 10,
    signal: opts.signal ?? new AbortController().signal,
    queue: {
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.onWait ? { onWait: opts.onWait } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.owner ? { owner: opts.owner } : {}),
    },
  };
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RequestScheduler', () => {
  const oneByOne: ServerLimits = { parallel: 1, modelsAtOnce: 1 };

  it('passes the adapter’s events through, phase included', async () => {
    const adapter: ProviderAdapter = {
      type: 'ollama',
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'phase', phase: 'loading' };
        yield { type: 'text', delta: 'hi' };
        yield { type: 'finish', reason: 'end' };
      },
    };
    const wrapped = new RequestScheduler().wrap(adapter, 'gpu', () => oneByOne);
    expect((await drain(wrapped.stream(request('a', 'm')))).map((e) => e.type)).toEqual(['phase', 'text', 'finish']);
  });

  it('runs one request at a time on a one-slot server, oldest first, and says how many are ahead', async () => {
    const server = gpu();
    const wrapped = new RequestScheduler().wrap(server.adapter, 'gpu', () => oneByOne);
    const waits: (number | null)[] = [];
    const runs = ['a', 'b', 'c'].map((id) => drain(wrapped.stream(request(id, 'qwen', id === 'c' ? { onWait: (n) => waits.push(n) } : {}))));
    await tick();
    expect(server.log).toEqual(['start a']);
    expect(waits).toEqual([2]);
    server.finish('a');
    await tick();
    expect(server.log).toEqual(['start a', 'start b']);
    expect(waits).toEqual([2, 1]);
    server.finish('b');
    await tick();
    server.finish('c');
    await Promise.all(runs);
    expect(waits).toEqual([2, 1, null]);
    expect(server.peak()).toBe(1);
  });

  it('never counts a conversation’s own requests (its title) as ahead of its reply, only other conversations’', async () => {
    const server = gpu();
    const wrapped = new RequestScheduler().wrap(server.adapter, 'gpu', () => oneByOne);
    const waits: (number | null)[] = [];
    const title = drain(wrapped.stream(request('title', 'qwen', { priority: 'urgent', owner: 's1' })));
    const reply = drain(wrapped.stream(request('reply', 'qwen', { owner: 's1', onWait: (n) => waits.push(n) })));
    await tick();
    expect(server.log).toEqual(['start title']);
    expect(waits).toEqual([]);
    const other = drain(wrapped.stream(request('other', 'qwen', { owner: 's2', onWait: (n) => waits.push(n) })));
    await tick();
    // The other conversation waits behind both of s1's requests.
    expect(waits).toEqual([2]);
    server.finish('title');
    await tick();
    server.finish('reply');
    await tick();
    server.finish('other');
    await Promise.all([title, reply, other]);
    expect(waits).toEqual([2, 1, null]);
  });

  it('puts the person’s requests before sub-agents’ and background work that came a little earlier', async () => {
    const server = gpu();
    let now = 0;
    const wrapped = new RequestScheduler(() => now).wrap(server.adapter, 'gpu', () => oneByOne);
    const runs = [drain(wrapped.stream(request('busy', 'qwen')))];
    runs.push(drain(wrapped.stream(request('title', 'qwen', { priority: 'background' }))));
    now = 1_000;
    runs.push(drain(wrapped.stream(request('agent', 'qwen', { priority: 'subagent' }))));
    now = 2_000;
    runs.push(drain(wrapped.stream(request('person', 'qwen'))));
    for (const id of ['busy', 'person', 'agent', 'title']) {
      await tick();
      server.finish(id);
    }
    await Promise.all(runs);
    expect(server.log).toEqual(['start busy', 'start person', 'start agent', 'start title']);
  });

  it('never runs two models at once on a server that holds one, and lets the loaded model go first to save a swap', async () => {
    const server = gpu();
    let now = 0;
    const wrapped = new RequestScheduler(() => now).wrap(server.adapter, 'gpu', () => ({ parallel: 4, modelsAtOnce: 1 }));
    const runs = [drain(wrapped.stream(request('big-1', 'big')))];
    now = 1;
    runs.push(drain(wrapped.stream(request('small-1', 'small'))));
    now = 2;
    runs.push(drain(wrapped.stream(request('big-2', 'big'))));
    await tick();
    // The second request for the loaded model joins the first; the other model waits for the server to be free.
    expect(server.log).toEqual(['start big-1', 'start big-2']);
    server.finish('big-1');
    await tick();
    expect(server.log).toHaveLength(2);
    server.finish('big-2');
    await tick();
    expect(server.log.at(-1)).toBe('start small-1');
    server.finish('small-1');
    await Promise.all(runs);
  });

  it('lets a loaded model overtake only for a while, so the other model is not starved', async () => {
    const server = gpu();
    let now = 0;
    const wrapped = new RequestScheduler(() => now).wrap(server.adapter, 'gpu', () => oneByOne);
    const runs = [drain(wrapped.stream(request('big-1', 'big')))];
    runs.push(drain(wrapped.stream(request('small', 'small'))));
    now = 60_000;
    runs.push(drain(wrapped.stream(request('big-2', 'big'))));
    await tick();
    server.finish('big-1');
    await tick();
    expect(server.log.at(-1)).toBe('start small');
    server.finish('small');
    await tick();
    server.finish('big-2');
    await Promise.all(runs);
  });

  it('runs requests for any number of models side by side on a hosted API', async () => {
    const server = gpu();
    const wrapped = new RequestScheduler().wrap(server.adapter, 'api', () => defaultLimits('https://api.anthropic.com'));
    const runs = ['a', 'b', 'c'].map((id, i) => drain(wrapped.stream(request(id, `model-${i}`))));
    await tick();
    expect(server.log).toHaveLength(3);
    for (const id of ['a', 'b', 'c']) server.finish(id);
    await Promise.all(runs);
  });

  it('drops a request stopped while it waits, and frees the slot of one stopped while it runs', async () => {
    const server = gpu();
    const scheduler = new RequestScheduler();
    const wrapped = scheduler.wrap(server.adapter, 'gpu', () => oneByOne);
    const first = new AbortController();
    const second = new AbortController();
    const waits: (number | null)[] = [];
    const a = drain(wrapped.stream(request('a', 'qwen', { signal: first.signal })));
    const b = drain(wrapped.stream(request('b', 'qwen', { signal: second.signal, onWait: (n) => waits.push(n) })));
    const c = drain(wrapped.stream(request('c', 'qwen')));
    await tick();
    second.abort();
    expect(await b).toEqual([{ type: 'finish', reason: 'aborted' }]);
    expect(waits).toEqual([1, null]);
    first.abort();
    expect(await a).toEqual([{ type: 'finish', reason: 'aborted' }]);
    await tick();
    expect(server.log).toEqual(['start a', 'start c']);
    server.finish('c');
    await c;
    expect(scheduler.load('gpu')).toEqual({ running: 0, queued: 0, agents: 0 });
  });

  it('frees the slot when the reader stops early', async () => {
    const server = gpu();
    const scheduler = new RequestScheduler();
    const wrapped = scheduler.wrap(server.adapter, 'gpu', () => oneByOne);
    const iterator = wrapped.stream(request('a', 'qwen'))[Symbol.asyncIterator]();
    const next = iterator.next();
    await tick();
    server.finish('a');
    await next;
    await iterator.return?.();
    expect(scheduler.load('gpu')?.running).toBe(0);
  });

  it('counts the time limit from the start, not from the queue', async () => {
    const server = gpu();
    const wrapped = new RequestScheduler().wrap(server.adapter, 'gpu', () => oneByOne);
    const busy = drain(wrapped.stream(request('busy', 'qwen')));
    const title = drain(wrapped.stream(request('title', 'qwen', { priority: 'background', timeoutMs: 30 })));
    await new Promise((r) => setTimeout(r, 60));
    expect(server.log).toEqual(['start busy']);
    server.finish('busy');
    await busy;
    expect(await title).toEqual([{ type: 'finish', reason: 'aborted' }]);
    expect(server.log).toEqual(['start busy', 'start title']);
  });

  it('gives sub-agents turns: as many at once as the server answers requests', async () => {
    const scheduler = new RequestScheduler();
    const limits = () => ({ parallel: 2, modelsAtOnce: 1 });
    const waits: (number | null)[] = [];
    const first = await scheduler.agentTurn('gpu', limits, new AbortController().signal);
    const second = await scheduler.agentTurn('gpu', limits, new AbortController().signal);
    let thirdStarted = false;
    const third = scheduler.agentTurn('gpu', limits, new AbortController().signal, (n) => waits.push(n)).then((release) => {
      thirdStarted = true;
      return release;
    });
    await tick();
    expect(thirdStarted).toBe(false);
    expect(waits).toEqual([2]);
    first();
    first();
    const release = await third;
    expect(waits).toEqual([2, null]);
    expect(scheduler.load('gpu')?.agents).toBe(2);
    second();
    release();
    expect(scheduler.load('gpu')?.agents).toBe(0);
  });
});

describe('defaultLimits', () => {
  it('treats this computer and the local network as one GPU, and anything else as a hosted API', () => {
    for (const url of ['http://localhost:11434', 'http://127.0.0.1:8080', 'http://[::1]:1234', 'http://192.168.1.20:11434', 'http://10.0.0.5', 'http://100.101.1.2:11434', 'http://gpu-box:11434', 'http://gpu.local:8080', 'https://ollama.tail1234.ts.net'])
      expect(isLocalServer(url), url).toBe(true);
    for (const url of ['https://api.anthropic.com', 'https://api.openai.com/v1', 'https://openrouter.ai/api/v1', 'https://8.8.8.8'])
      expect(isLocalServer(url), url).toBe(false);
    expect(defaultLimits('http://localhost:11434')).toEqual({ parallel: 1, modelsAtOnce: 1 });
    expect(defaultLimits('https://api.anthropic.com')).toEqual({ parallel: 16, modelsAtOnce: Infinity });
  });
});
