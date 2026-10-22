import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, Part, RunEvent } from '@atelier/protocol';
import { openDatabase, type Db } from '../store/db.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { createArtifactTool } from '../tools/artifact.ts';
import { describeTool } from '../tools/types.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent } from '../providers/types.ts';
import { withPromptedTools } from '../providers/prompted-tools.ts';
import { callWrittenAsText, NETWORK_RETRY_DELAYS_MS, runTurn } from './loop.ts';

const model: ModelInfo = {
  ref: 'fake/m',
  providerId: 'fake',
  modelId: 'm',
  displayName: 'Fake',
  contextLength: 8000,
  maxOutput: 1000,
  capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: false },
  tier: 'compact',
  source: 'default',
  hidden: false,
  favorite: false,
  order: 0,
};

function scripted(steps: StreamEvent[][], seen: ChatRequest[]): ProviderAdapter {
  let i = 0;
  return {
    type: 'openai-compatible',
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
    async *stream(req) {
      seen.push(req);
      const events = steps[i++] ?? [{ type: 'finish', reason: 'end' }];
      for (const e of events) {
        if (req.signal.aborted) {
          yield { type: 'finish', reason: 'aborted' };
          return;
        }
        await new Promise((r) => setTimeout(r, 1));
        yield e;
      }
    },
  };
}

let db: Db;
let repo: SessionRepo;
let sessionId: string;
beforeEach(async () => {
  db = openDatabase(':memory:');
  repo = new SessionRepo(db);
  sessionId = (await repo.create({ mode: 'chat' })).id;
  await repo.insertMessage({ id: 'u1', sessionId, parentId: null, role: 'user', parts: [{ type: 'text', text: 'make a page' }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null });
});
afterEach(() => db.$client.close());

/** Sends the stored history as is. */
const history = (maxOutputTokens: number) => async () => ({ messages: await repo.history(sessionId), maxOutputTokens });

describe('runTurn', () => {
  it('retries a failed request ten times with increasing visible waits before surfacing an error', async () => {
    vi.useFakeTimers();
    try {
      const seen: ChatRequest[] = [];
      const events: RunEvent[] = [];
      const failure: StreamEvent = { type: 'finish', reason: 'error', error: { code: 'provider_offline', message: 'DNS lookup failed', retryable: true } };
      const pending = runTurn({ sessionId, repo, adapter: scripted(Array.from({ length: 11 }, () => [failure]), seen), model, system: [], tools: [], effort: null, signal: new AbortController().signal, emit: (event) => events.push(event), prepare: history(500) });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(seen).toHaveLength(11);
      expect(result.error?.code).toBe('provider_offline');
      expect(events.filter((event) => event.type === 'phase' && event.phase === 'retrying')).toHaveLength(10);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(NETWORK_RETRY_DELAYS_MS.slice(0, 4)).toEqual([5000, 10000, 15000, 30000]);
    } finally { vi.useRealTimers(); }
  });

  it('says so after a minute without output from the model, and drops the notice with the next output', async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const quiet: ProviderAdapter = {
        type: 'openai-compatible',
        listModels: async () => [],
        health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
        async *stream() {
          yield { type: 'text', delta: 'Let me write that' };
          await gate;
          yield { type: 'text', delta: ' file.' };
          yield { type: 'finish', reason: 'end' };
        },
      };
      const events: RunEvent[] = [];
      const phases = () => events.flatMap((e) => (e.type === 'phase' ? [e.phase] : []));
      const pending = runTurn({ sessionId, repo, adapter: quiet, model, system: [], tools: [], effort: null, signal: new AbortController().signal, emit: (event) => events.push(event), prepare: history(500) });
      await vi.advanceTimersByTimeAsync(50_000);
      expect(phases()).toEqual([]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(phases()).toEqual(['quiet']);
      // Said once, not on every check.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(phases()).toEqual(['quiet']);
      release();
      const result = await pending;
      expect(phases()).toEqual(['quiet', null]);
      expect(result.error).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('discards incomplete tool calls on reconnect and executes the successful call only once', async () => {
    vi.useFakeTimers();
    try {
      const seen: ChatRequest[] = [];
      const run = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'saved' }] }));
      const adapter = scripted([
        [{ type: 'text', delta: 'incomplete' }, { type: 'tool_call_start', id: 'broken', name: 'save' }, { type: 'finish', reason: 'error', error: { code: 'provider_offline', message: 'reset', retryable: true } }],
        [{ type: 'tool_call_start', id: 'good', name: 'save' }, { type: 'tool_call_end', id: 'good', input: {} }, { type: 'finish', reason: 'tool_use' }],
        [{ type: 'text', delta: 'done' }, { type: 'finish', reason: 'end' }],
      ], seen);
      const pending = runTurn({ sessionId, repo, adapter, model, system: [], tools: [{ name: 'save', description: 'save', inputSchema: { type: 'object' }, readOnly: false, run }], effort: null, signal: new AbortController().signal, emit: () => {}, prepare: history(500) });
      await vi.runAllTimersAsync();
      expect((await pending).error).toBeNull();
      expect(run).toHaveBeenCalledTimes(1);
      const stored = (await repo.branch(sessionId)).messages;
      expect(JSON.stringify(stored)).not.toContain('incomplete');
      expect(JSON.stringify(stored)).not.toContain('broken');
    } finally { vi.useRealTimers(); }
  });

  it('stops immediately during a reconnect wait without showing a provider error', async () => {
    const controller = new AbortController();
    const seen: ChatRequest[] = [];
    const adapter = scripted([[{ type: 'finish', reason: 'error', error: { code: 'provider_offline', message: 'offline', retryable: true } }]], seen);
    const result = await runTurn({ sessionId, repo, adapter, model, system: [], tools: [], effort: null, signal: controller.signal, emit: (event) => { if (event.type === 'phase' && event.phase === 'retrying') controller.abort(); }, prepare: history(500) });
    expect(result.stopReason).toBe('aborted');
    expect(result.error).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('replaces revised browser text in the live reply and stored message without duplication', async () => {
    const seen: ChatRequest[] = [];
    const events: RunEvent[] = [];
    const adapter = scripted([[
      { type: 'text', delta: 'A **cool' },
      { type: 'text_snapshot', text: 'A cool homelab' },
      { type: 'text', delta: '.' },
      { type: 'finish', reason: 'end' },
    ]], seen);
    const result = await runTurn({ sessionId, repo, adapter, model, system: [], tools: [], effort: null, signal: new AbortController().signal, emit: event => events.push(event), prepare: history(500) });
    expect(result.error).toBeNull();
    expect((await repo.branch(sessionId)).messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'A cool homelab.' }]);
    expect(events.some(event => event.type === 'part' && event.index === 0 && event.part.type === 'text' && event.part.text === 'A cool homelab')).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('executes only the confirmed revised browser call and continues with its result', async () => {
    const seen: ChatRequest[] = [];
    const run = vi.fn(async (_input: unknown) => ({ content: [{ type: 'text' as const, text: 'saved' }] }));
    const call = (value: string) => `Saving. <tool_call>${JSON.stringify({ name: 'save', arguments: { value } })}</tool_call>`;
    const source = scripted([
      [{ type: 'text', delta: call('provisional') }, { type: 'text_snapshot', text: call('confirmed') }, { type: 'finish', reason: 'end' }],
      [{ type: 'text', delta: 'Do' }, { type: 'text_snapshot', text: 'Done.' }, { type: 'finish', reason: 'end' }],
    ], seen);
    const result = await runTurn({ sessionId, repo, adapter: withPromptedTools({ ...source, type: 'chatgpt-chat' }), model, system: [], tools: [{ name: 'save', description: 'save', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, readOnly: false, run }], effort: null, signal: new AbortController().signal, emit: () => {}, prepare: history(500) });
    expect(result.stopReason).toBe('end');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual({ value: 'confirmed' });
    const stored = (await repo.branch(sessionId)).messages;
    expect(stored.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(stored[1]!.parts).toEqual([{ type: 'text', text: 'Saving. ' }, expect.objectContaining({ type: 'tool_call', name: 'save', input: { value: 'confirmed' } })]);
    expect(stored.at(-1)!.parts).toEqual([{ type: 'text', text: 'Done.' }]);
    expect(JSON.stringify(stored)).not.toContain('provisional');
    expect(seen).toHaveLength(2);
  });

  it('streams, executes a tool call, then continues to a final answer', async () => {
    const seen: ChatRequest[] = [];
    const events: RunEvent[] = [];
    const adapter = scripted(
      [
        [
          { type: 'thinking', delta: 'plan' },
          { type: 'text', delta: 'Creating it.' },
          { type: 'tool_call_start', id: 'c1', name: 'artifact' },
          { type: 'tool_call_delta', id: 'c1', json: '{"command":"create"' },
          { type: 'tool_call_end', id: 'c1', input: { command: 'create', identifier: 'page', type: 'html', title: 'Page', content: '<p>x</p>' } },
          { type: 'usage', usage: { input: 10, output: 5 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        [
          { type: 'text', delta: 'Done' },
          { type: 'text', delta: '!' },
          { type: 'finish', reason: 'end' },
        ],
      ],
      seen,
    );
    const result = await runTurn({
      sessionId,
      repo,
      adapter,
      model,
      system: [{ text: 'sys' }],
      tools: [describeTool(createArtifactTool(new ArtifactRepo(db)), { tier: 'compact', mode: 'chat', has: () => false })],
      effort: null,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      prepare: history(500),
    });
    expect(result.stopReason).toBe('end');
    const { messages } = await repo.branch(sessionId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1]!.parts.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_call']);
    expect(messages[2]!.parts[0]).toMatchObject({ type: 'tool_result', callId: 'c1' });
    expect(messages[3]!.parts).toEqual([{ type: 'text', text: 'Done!' }]);
    // The second request includes the tool result as history.
    expect(seen[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(events.some((e) => e.type === 'artifact')).toBe(true);
    expect(seen[0]!.contextLength).toBe(8000);
  });

  it('rejects tool input that fails the schema and feeds the error back', async () => {
    const seen: ChatRequest[] = [];
    const adapter = scripted(
      [
        [
          { type: 'tool_call_start', id: 'c1', name: 'artifact' },
          { type: 'tool_call_end', id: 'c1', input: { command: 'explode' } },
          { type: 'finish', reason: 'tool_use' },
        ],
        [{ type: 'text', delta: 'ok' }, { type: 'finish', reason: 'end' }],
      ],
      seen,
    );
    await runTurn({ sessionId, repo, adapter, model, system: [], tools: [describeTool(createArtifactTool(new ArtifactRepo(db)), { tier: 'compact', mode: 'chat', has: () => false })], effort: null, signal: new AbortController().signal, emit: () => {}, prepare: history(100) });
    const tool = (await repo.branch(sessionId)).messages[2]!;
    expect(tool.parts[0]).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('parses an array or object argument the model sent as JSON text', async () => {
    // nemotron-3.5 sent AskUser's `questions` as a string and got "/questions must be array".
    const ran: unknown[] = [];
    const ask = {
      name: 'AskUser',
      description: 'Ask',
      inputSchema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } }, required: ['questions'], additionalProperties: false },
      readOnly: true,
      run: async (input: unknown) => (ran.push(input), { content: [{ type: 'text' as const, text: 'answered' }] }),
    };
    const sentArgs = { questions: '[{"question": "Which?", "options": []}]', note: '[not parsed: a string property]' };
    const adapter = scripted(
      [
        [{ type: 'tool_call_start', id: 'c1', name: 'AskUser' }, { type: 'tool_call_end', id: 'c1', input: sentArgs }, { type: 'finish', reason: 'tool_use' }],
        [{ type: 'tool_call_start', id: 'c2', name: 'AskUser' }, { type: 'tool_call_end', id: 'c2', input: { questions: 'not json' } }, { type: 'finish', reason: 'tool_use' }],
        [{ type: 'text', delta: 'ok' }, { type: 'finish', reason: 'end' }],
      ],
      [],
    );
    await runTurn({ sessionId, repo, adapter, model, system: [], tools: [ask], effort: null, signal: new AbortController().signal, emit: () => {}, prepare: history(100) });
    expect(ran).toEqual([{ questions: [{ question: 'Which?', options: [] }], note: '[not parsed: a string property]' }]);
    const { messages } = await repo.branch(sessionId);
    // The stored call stays as sent; text that isn't JSON still fails validation.
    expect(messages[1]!.parts[0]).toMatchObject({ type: 'tool_call', input: sentArgs });
    expect(messages[4]!.parts[0]).toMatchObject({ type: 'tool_result', isError: true, content: [{ text: 'Invalid input for AskUser: /questions must be array' }] });
  });

  it("reports the server's phase until the first output and clears it then, or when the reply fails or is stopped", async () => {
    const run = async (steps: StreamEvent[], opts: { abortOn?: 'phase' | 'retry'; throws?: boolean } = {}) => {
      const controller = new AbortController();
      const events: RunEvent[] = [];
      const adapter = opts.throws
        ? { ...scripted([], []), async *stream(): AsyncGenerator<StreamEvent> { yield { type: 'phase', phase: 'loading' }; throw new Error('socket hang up'); } }
        : scripted([steps], []);
      await runTurn({
        sessionId, repo, adapter, model, system: [], tools: [], effort: null, signal: controller.signal, prepare: history(100),
        emit: (e) => {
          events.push(e);
          if (e.type === 'phase' && ((opts.abortOn === 'phase' && e.phase) || (opts.abortOn === 'retry' && e.phase === 'retrying'))) controller.abort();
        },
      });
      // What happened around each phase change, by event type.
      return events.filter((e) => e.type !== 'message').map((e) => (e.type === 'phase' ? `phase:${e.phase}` : e.type));
    };

    expect(await run([{ type: 'phase', phase: 'loading' }, { type: 'text', delta: 'Hi' }, { type: 'text', delta: '!' }, { type: 'finish', reason: 'end' }]))
      .toEqual(['phase:loading', 'phase:null', 'part', 'delta', 'delta', 'done']);
    expect(await run([{ type: 'phase', phase: 'reading' }, { type: 'thinking', delta: 'Hm' }, { type: 'finish', reason: 'end' }]))
      .toEqual(['phase:reading', 'phase:null', 'part', 'delta', 'done']);
    // An error before any output, a stop and a failed request clear it too, before the reply ends.
    expect(await run([{ type: 'phase', phase: 'loading' }, { type: 'finish', reason: 'error', error: { code: 'provider_offline', message: 'gone', retryable: true } }], { abortOn: 'retry' }))
      .toEqual(['phase:loading', 'phase:null', 'phase:retrying', 'phase:null', 'done']);
    expect(await run([{ type: 'phase', phase: 'reading' }, { type: 'text', delta: 'never' }], { abortOn: 'phase' })).toEqual(['phase:reading', 'phase:null', 'done']);
    expect(await run([], { throws: true, abortOn: 'retry' })).toEqual(['phase:loading', 'phase:null', 'phase:retrying', 'phase:null', 'done']);
    // Providers that report no phase send none.
    expect(await run([{ type: 'text', delta: 'Hi' }, { type: 'finish', reason: 'end' }])).toEqual(['part', 'delta', 'done']);
  });

  it('persists partial output when aborted', async () => {
    const controller = new AbortController();
    const adapter = scripted([[{ type: 'text', delta: 'partial' }, { type: 'text', delta: ' more' }, { type: 'finish', reason: 'end' }]], []);
    const result = await runTurn({
      sessionId,
      repo,
      adapter,
      model,
      system: [],
      tools: [],
      effort: null,
      signal: controller.signal,
      emit: (e) => {
        if (e.type === 'delta') controller.abort();
      },
      prepare: history(100),
    });
    expect(result.stopReason).toBe('aborted');
    const last = (await repo.branch(sessionId)).messages.at(-1)!;
    expect(last.parts).toEqual([{ type: 'text', text: 'partial' }]);
    expect(last.stopReason).toBe('aborted');
  });

  it("asks again, up to twice, when the server couldn't parse the model's reply and nothing arrived", async () => {
    const seen: ChatRequest[] = [];
    const events: RunEvent[] = [];
    const malformed: StreamEvent[] = [
      { type: 'finish', reason: 'error', error: { code: 'model_output_invalid', message: "The model's reply didn't follow its own format", retryable: true } },
    ];
    const adapter = scripted([malformed, malformed, [{ type: 'text', delta: 'Third time' }, { type: 'usage', usage: { input: 9, output: 2 } }, { type: 'finish', reason: 'end' }], malformed, malformed, malformed], seen);
    const result = await runTurn({ sessionId, repo, adapter, model, system: [], tools: [], effort: null, signal: new AbortController().signal, emit: (e) => events.push(e), prepare: history(100) });
    expect(result).toMatchObject({ stopReason: 'end', error: null });
    expect(seen).toHaveLength(3);
    const { messages } = await repo.branch(sessionId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]).toMatchObject({ parts: [{ type: 'text', text: 'Third time' }], error: null, usage: { input: 9, output: 2 } });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);

    // Three failures in a row end the turn with the error.
    const again = await runTurn({ sessionId, repo, adapter, model, system: [], tools: [], effort: null, signal: new AbortController().signal, emit: () => {}, prepare: history(100) });
    expect(again.error?.code).toBe('model_output_invalid');
    expect(seen).toHaveLength(6);
  });

  it('does not repeat a malformed reply once part of it streamed', async () => {
    const seen: ChatRequest[] = [];
    const adapter = scripted(
      [[{ type: 'text', delta: 'Half' }, { type: 'finish', reason: 'error', error: { code: 'model_output_invalid', message: 'bad format', retryable: true } }]],
      seen,
    );
    const result = await runTurn({ sessionId, repo, adapter, model, system: [], tools: [], effort: null, signal: new AbortController().signal, emit: () => {}, prepare: history(100) });
    expect(result.error?.code).toBe('model_output_invalid');
    expect(seen).toHaveLength(1);
  });

  it('retries a request the provider rejects as too long into the same message, once', async () => {
    const seen: ChatRequest[] = [];
    const events: RunEvent[] = [];
    const overflow: StreamEvent[] = [{ type: 'finish', reason: 'error', error: { code: 'context_overflow', message: 'prompt is too long', retryable: false } }];
    const adapter = scripted([overflow, [{ type: 'text', delta: 'Fits now' }, { type: 'finish', reason: 'end' }], overflow, overflow], seen);
    let recovered = 0;
    const result = await runTurn({ sessionId, repo, adapter, model, system: [], tools: [], effort: null, signal: new AbortController().signal, emit: (e) => events.push(e), prepare: history(100), recoverOverflow: () => recovered++ });
    expect(result.stopReason).toBe('end');
    expect(recovered).toBe(1);
    const { messages } = await repo.branch(sessionId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]!.parts).toEqual([{ type: 'text', text: 'Fits now' }]);
    // The retry streams into the message the first attempt opened, which never ended with the error.
    const opened = events.filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.message.id : ''));
    expect(new Set(opened)).toEqual(new Set([messages[1]!.id]));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(seen[1]!.messages.map((m) => m.role)).toEqual(['user']);

    // A second rejection ends the turn with the error.
    const again = await runTurn({ sessionId, repo, adapter, model, system: [], tools: [], effort: null, signal: new AbortController().signal, emit: () => {}, prepare: history(100), recoverOverflow: () => recovered++ });
    expect(again.error?.code).toBe('context_overflow');
    expect(recovered).toBe(2);
  });
});

describe('a call written out as the reply', () => {
  const tools = [
    { name: 'Read', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    { name: 'artifact', inputSchema: { type: 'object', properties: { command: { type: 'string' }, content: { type: 'string' } }, required: ['command'] } },
  ];
  const text = (t: string): Part[] => [{ type: 'text', text: t }];

  it('is made when the reply is exactly one call to a tool the session has', () => {
    const plain = callWrittenAsText(text('Read {"file_path": "src/app.ts"}'), tools);
    expect(plain?.call).toMatchObject({ type: 'tool_call', name: 'Read', input: { file_path: 'src/app.ts' } });
    expect(callWrittenAsText(text('Read[CALL_7f3a]{"file_path":"a.md"}'), tools)?.call).toMatchObject({ name: 'Read', input: { file_path: 'a.md' } });
    expect(callWrittenAsText(text('```json\nartifact {"command":"create","content":"<h1>Hi</h1>"}\n```'), tools)?.call).toMatchObject({ name: 'artifact' });
    // Thinking beside it doesn't count as something said.
    expect(callWrittenAsText([{ type: 'thinking', text: 'hm' }, ...text('Read {"file_path":"x"}')], tools)?.index).toBe(1);
  });

  it('is left as text when anything else is said, the tool is unknown or the input does not fit', () => {
    expect(callWrittenAsText(text('I will read it: Read {"file_path": "a"}'), tools)).toBeNull();
    expect(callWrittenAsText(text('Read {"file_path": "a"} and then I will summarize'), tools)).toBeNull();
    expect(callWrittenAsText(text('Delete {"file_path": "a"}'), tools)).toBeNull();
    expect(callWrittenAsText(text('Read {"path": "a"}'), tools)).toBeNull();
    expect(callWrittenAsText(text('Read {not json}'), tools)).toBeNull();
    expect(callWrittenAsText([...text('Read {"file_path":"a"}'), ...text('second')], tools)).toBeNull();
  });
});
