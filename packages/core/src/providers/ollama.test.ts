import { describe, expect, it } from 'vitest';
import {
  chatRequest,
  collect,
  deps,
  fakeFetch,
  finishOf,
  jsonResponse,
  message,
  ndjson,
  offlineFetch,
  providerInstance,
  streamResponse,
  textOf,
  thinkingOf,
  usageOf,
  userText,
} from './__fixtures__/harness.ts';
import { PS_TIMEOUT_MS, createOllamaAdapter, historyCallId, parseShow, thinkParam } from './ollama.ts';
import type { StreamEvent } from './types.ts';

const instance = providerInstance('ollama', 'http://localhost:11434');
/** The /api/chat requests among the recorded calls (the adapter looks a model up with /api/show first). */
const chatCalls = (calls: { url: string; body: unknown }[]) => calls.filter((c) => c.url.endsWith('/api/chat'));

const chunk = (msg: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'qwen3:32b',
  created_at: '2026-10-13T10:00:00Z',
  message: { role: 'assistant', content: '', ...msg },
  done: false,
  ...extra,
});

const DONE = {
  model: 'qwen3:32b',
  created_at: '2026-10-13T10:00:01Z',
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  total_duration: 2_500_000_000,
  prompt_eval_count: 42,
  eval_count: 20,
  eval_duration: 500_000_000,
};

const TEXT_STREAM = ndjson([chunk({ content: 'Hel' }), chunk({ content: 'lo!' }), DONE]);

const SHOW_QWEN = {
  capabilities: ['completion', 'tools', 'thinking'],
  model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 },
};
const SHOW_GPT_OSS = {
  capabilities: ['completion', 'tools', 'thinking'],
  model_info: { 'gptoss.context_length': 131072 },
  thinking: { values: ['low', 'medium', 'high'] },
};

/** What Ollama 0.33 (llama-server backend) answers for gpt-oss: no `thinking.values`, just the family. */
const SHOW_GPT_OSS_033 = {
  capabilities: ['tools', 'completion', 'thinking'],
  details: { format: 'gguf', family: 'gpt-oss', families: ['gpt-oss'], parameter_size: '20.9B', quantization_level: 'MXFP4_MOE' },
  model_info: { 'gpt-oss.context_length': 131072 },
  parameters: 'num_ctx                        32768',
};

/** The part of qwen3.6's template (Ollama 0.33) that reads reasoning out of an assistant message's content. */
const QWEN_TEMPLATE = "{%- if message.reasoning_content is string %}{%- else %}{%- if '</think>' in content %}{%- set reasoning_content = content.split('</think>')[0] %}{%- endif %}{%- endif %}";

describe('ollama adapter', () => {
  it('falls back to prompted tools when the backend cannot compile the native grammar', async () => {
    let attempts = 0;
    const { fetch, calls } = fakeFetch({
      'POST /api/show': () => jsonResponse(SHOW_QWEN),
      'POST /api/chat': () => ++attempts === 1
        ? jsonResponse({ error: { message: 'Failed to initialize samplers: failed to parse grammar', type: 'invalid_request_error' } }, 400)
        : streamResponse(ndjson([chunk({ content: '<tool_call>{"name":"lookup","arguments":{}}</tool_call>' }), DONE])),
    });
    const adapter = createOllamaAdapter(instance, deps(fetch));
    const events = await collect(adapter.stream(chatRequest({ tools: [{ name: 'lookup', description: 'Look up a value', inputSchema: { type: 'object', properties: {} } }] })));
    expect(attempts).toBe(2);
    expect(chatCalls(calls)[1]!.body).not.toHaveProperty('tools');
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call_start', name: 'lookup' }));
    expect(finishOf(events)).toMatchObject({ reason: 'tool_use' });
    await collect(adapter.stream(chatRequest({ tools: [{ name: 'lookup', description: 'Look up a value', inputSchema: { type: 'object', properties: {} } }] })));
    expect(attempts).toBe(3);
    expect(chatCalls(calls)[2]!.body).not.toHaveProperty('tools');
  });
  it('knows gpt-oss takes reasoning levels when /api/show lists none', async () => {
    expect(parseShow(SHOW_GPT_OSS_033)).toEqual({ capabilities: ['tools', 'completion', 'thinking'], thinkLevels: ['low', 'medium', 'high'], contextLength: 131072 });
    expect(parseShow({ ...SHOW_GPT_OSS_033, details: { family: 'qwen3' } }).thinkLevels).toEqual([]);
    expect(parseShow({ ...SHOW_GPT_OSS_033, capabilities: ['completion'] }).thinkLevels).toEqual([]);

    const { fetch, calls } = fakeFetch({
      'GET /api/tags': () => jsonResponse({ models: [{ name: 'gpt-oss-20b:mxfp4' }] }),
      'POST /api/show': () => jsonResponse(SHOW_GPT_OSS_033),
      'POST /api/chat': () => streamResponse(TEXT_STREAM),
    });
    const adapter = createOllamaAdapter(instance, deps(fetch));
    const [listed] = await adapter.listModels();
    expect(listed).toMatchObject({ capabilities: { reasoning: 'effort' }, effortLevels: ['low', 'medium', 'high'] });
    await collect(adapter.stream(chatRequest({ model: 'gpt-oss-20b:mxfp4', effort: 'low' })));
    await collect(adapter.stream(chatRequest({ model: 'gpt-oss-20b:mxfp4', effort: 'ultracode' })));
    const thinks = calls.filter((c) => c.url.endsWith('/api/chat')).map((c) => (c.body as { think?: unknown }).think);
    expect(thinks).toEqual(['low', 'high']);
  });

  it('streams text, maps usage with tokens/s and always sends num_ctx', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /api/chat': () => streamResponse(TEXT_STREAM) });
    const adapter = createOllamaAdapter(instance, deps(fetch));
    const events = await collect(adapter.stream(chatRequest({ model: 'qwen3:32b', contextLength: 65536 })));

    expect(textOf(events)).toBe('Hello!');
    expect(usageOf(events)).toEqual({ input: 42, output: 20, durationMs: 2500, tokensPerSecond: 40 });
    expect(finishOf(events)).toEqual({ type: 'finish', reason: 'end' });
    const body = chatCalls(calls)[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen3:32b',
      stream: true,
      options: { num_ctx: 65536, num_predict: 4096 },
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(body).not.toHaveProperty('think');
  });

  it('says whether the server is loading the model or reading the prompt, from /api/ps', async () => {
    const phases = async (ps: () => Response | Promise<Response>, model = 'qwen3:32b') => {
      const { fetch, calls } = fakeFetch({ 'GET /api/ps': ps, 'POST /api/chat': () => streamResponse(TEXT_STREAM) });
      const events = await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest({ model })));
      expect(textOf(events)).toBe('Hello!');
      // Asked right before the chat request, and only once.
      expect(calls.map((c) => new URL(c.url).pathname).slice(-2)).toEqual(['/api/ps', '/api/chat']);
      return events.filter((e) => e.type === 'phase');
    };
    const running = (name: string) => () => jsonResponse({ models: [{ name, model: name, size: 1 }] });

    expect(await phases(running('qwen3:32b'))).toEqual([{ type: 'phase', phase: 'reading' }]);
    expect(await phases(running('llama3:latest'), 'llama3')).toEqual([{ type: 'phase', phase: 'reading' }]);
    expect(await phases(running('llama3:8b'))).toEqual([{ type: 'phase', phase: 'loading' }]);
    expect(await phases(() => jsonResponse({ models: [] }))).toEqual([{ type: 'phase', phase: 'loading' }]);
    // The phase comes before any output.
    const { fetch } = fakeFetch({ 'GET /api/ps': () => jsonResponse({ models: [] }), 'POST /api/chat': () => streamResponse(TEXT_STREAM) });
    expect((await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest())))[0]).toEqual({ type: 'phase', phase: 'loading' });
  });

  it('says nothing about the phase when /api/ps fails, answers nonsense or takes too long', async () => {
    const phases = async (ps: (signal: AbortSignal | null) => Response | Promise<Response>) => {
      const { fetch } = fakeFetch({ 'GET /api/ps': (_call, signal) => ps(signal), 'POST /api/chat': () => streamResponse(TEXT_STREAM) });
      const events = await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest()));
      expect(textOf(events)).toBe('Hello!');
      return events.filter((e) => e.type === 'phase');
    };
    expect(await phases(() => new Response('nope', { status: 500 }))).toEqual([]);
    expect(await phases(() => jsonResponse({ unexpected: true }))).toEqual([]);
    expect(await phases(() => Promise.reject(new TypeError('fetch failed')))).toEqual([]);
    // Never answers: given up on after PS_TIMEOUT_MS, and the reply goes ahead.
    const started = Date.now();
    const hung = (signal: AbortSignal | null) =>
      new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    expect(await phases(hung)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(PS_TIMEOUT_MS - 50);
    expect(Date.now() - started).toBeLessThan(PS_TIMEOUT_MS + 1500);
  });

  it('reports the part of the prompt Ollama 0.33 served from its cache as cache reads', async () => {
    // The done chunk of a follow-up turn as gpt-oss-20b on Ollama 0.33.3 sent it.
    const done = { ...DONE, prompt_eval_count: 2751, prompt_eval_cached_count: 2686, prompt_eval_duration: 58_833_000, eval_count: 35, eval_duration: 272_808_000, total_duration: 410_037_112 };
    const { fetch } = fakeFetch({ 'POST /api/chat': () => streamResponse(ndjson([chunk({ content: 'ok' }), done])) });
    const events = await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest()));
    expect(usageOf(events)).toMatchObject({ input: 65, cacheRead: 2686, output: 35 });
  });

  it('falls back to num_ctx 32768 when no context length is requested', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /api/chat': () => streamResponse(TEXT_STREAM) });
    await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest()));
    expect(chatCalls(calls)[0]!.body).toMatchObject({ options: { num_ctx: 32768 } });
  });

  it('maps effort to think levels when the model supports them and streams thinking', async () => {
    const stream = ndjson([
      chunk({ thinking: 'Let me ' }),
      chunk({ thinking: 'think.' }),
      chunk({ content: 'Done.' }),
      DONE,
    ]);
    const { fetch, calls } = fakeFetch({
      'POST /api/show': () => jsonResponse(SHOW_GPT_OSS),
      'POST /api/chat': () => streamResponse(stream),
    });
    const events = await collect(
      createOllamaAdapter(instance, deps(fetch)).stream(chatRequest({ model: 'gpt-oss:20b', effort: 'max' })),
    );
    expect(thinkingOf(events)).toBe('Let me think.');
    expect(textOf(events)).toBe('Done.');
    expect(calls.find((c) => c.url.endsWith('/api/chat'))!.body).toMatchObject({ think: 'high' });
  });

  it('asks leveled thinking models for their highest level at Extra, Max and Ultracode', () => {
    const leveled = { capabilities: ['completion', 'thinking'], thinkLevels: ['low', 'medium', 'high'] };
    const levels = (['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const).map((effort) => thinkParam(effort, leveled));
    expect(levels).toEqual(['low', 'medium', 'high', 'high', 'high', 'high']);
    expect(thinkParam('ultracode', { ...leveled, thinkLevels: ['low', 'medium'] })).toBe('medium');
    expect(thinkParam('ultracode', { capabilities: ['completion', 'thinking'], thinkLevels: [] })).toBe(true);
    expect(thinkParam(null, leveled)).toBeUndefined();
  });

  it('sends think:true for thinking models without levels and omits it for models without thinking', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /api/show': (call) =>
        jsonResponse(
          (call.body as { model: string }).model === 'qwen3:32b' ? SHOW_QWEN : { capabilities: ['completion'] },
        ),
      'POST /api/chat': () => streamResponse(TEXT_STREAM),
    });
    const adapter = createOllamaAdapter(instance, deps(fetch));
    await collect(adapter.stream(chatRequest({ model: 'qwen3:32b', effort: 'low' })));
    await collect(adapter.stream(chatRequest({ model: 'llama3.2', effort: 'low' })));
    const chats = calls.filter((c) => c.url.endsWith('/api/chat')).map((c) => c.body as Record<string, unknown>);
    expect(chats[0]!.think).toBe(true);
    expect(chats[1]).not.toHaveProperty('think');
  });

  it("replays gpt-oss's reasoning before a tool call as content when the server renders its Jinja template", async () => {
    const history = [
      message('user', [{ type: 'text', text: 'Rename greet' }]),
      message('assistant', [
        { type: 'thinking', text: 'Need to read greet.ts first.', provider: 'ollama' },
        { type: 'tool_call', id: 'c1', name: 'Read', input: { file_path: 'greet.ts' } },
      ]),
      message('tool', [{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'export function greet() {}' }] }]),
      message('assistant', [{ type: 'thinking', text: 'Done.', provider: 'ollama' }, { type: 'text', text: 'Renamed.' }]),
    ];
    const sent = async (show: Record<string, unknown>) => {
      const { fetch, calls } = fakeFetch({ 'POST /api/show': () => jsonResponse(show), 'POST /api/chat': () => streamResponse(TEXT_STREAM) });
      await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest({ model: 'gpt-oss-20b:mxfp4', messages: history })));
      return (calls.find((c) => c.url.endsWith('/api/chat'))!.body as { messages: Record<string, unknown>[] }).messages;
    };
    // Ollama 0.33 (llama-server backend) shows the model's Jinja template and drops `thinking` from history.
    const jinja = await sent({ ...SHOW_GPT_OSS_033, template: '{%- if message.content and message.thinking %}x{%- endif %}' });
    expect(jinja[2]).toEqual({ role: 'assistant', content: 'Need to read greet.ts first.', tool_calls: [{ id: historyCallId('c1'), function: { name: 'Read', arguments: { file_path: 'greet.ts' } } }] });
    // A final answer keeps its text; its reasoning stays in `thinking`, which the template leaves out anyway.
    expect(jinja[4]).toEqual({ role: 'assistant', content: 'Renamed.', thinking: 'Done.' });
    // Ollama's own renderer (a Go template) reads `thinking`, so it stays there.
    const native = await sent({ ...SHOW_GPT_OSS_033, template: '{{- range .Messages }}{{ .Thinking }}{{ end }}' });
    expect(native[2]).toMatchObject({ content: '', thinking: 'Need to read greet.ts first.' });
  });

  it('turns thinking off explicitly when the switch is off, except for models whose reasoning stays on', async () => {
    const shows: Record<string, unknown> = { 'qwen3.6:35b': { ...SHOW_QWEN, template: QWEN_TEMPLATE }, 'gpt-oss-20b:mxfp4': SHOW_GPT_OSS_033, 'llama3.2': { capabilities: ['completion'] } };
    const { fetch, calls } = fakeFetch({
      'POST /api/show': (call) => jsonResponse(shows[(call.body as { model: string }).model]),
      'POST /api/chat': () => streamResponse(TEXT_STREAM),
    });
    const adapter = createOllamaAdapter(instance, deps(fetch));
    for (const model of Object.keys(shows)) await collect(adapter.stream(chatRequest({ model, effort: null })));
    const sent = chatCalls(calls).map((c) => c.body as Record<string, unknown>);
    // qwen3.6 on Ollama 0.33 reasons at length unless told `think: false`.
    expect(sent[0]!.think).toBe(false);
    expect(sent[1]).not.toHaveProperty('think');
    expect(sent[2]).not.toHaveProperty('think');
  });

  it("replays a Qwen-style model's reasoning in <think> tags when its Jinja template reads them from content", async () => {
    const { fetch, calls } = fakeFetch({ 'POST /api/show': () => jsonResponse({ ...SHOW_QWEN, template: QWEN_TEMPLATE }), 'POST /api/chat': () => streamResponse(TEXT_STREAM) });
    const history = [
      message('user', [{ type: 'text', text: 'Fix it' }]),
      message('assistant', [
        { type: 'thinking', text: 'Read the file first.', provider: 'ollama' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_call', id: 'c1', name: 'Read', input: { file_path: 'a.ts' } },
      ]),
      message('tool', [{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'x' }] }]),
    ];
    await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest({ model: 'qwen3.6:35b', messages: history, effort: 'high' })));
    const body = chatCalls(calls)[0]!.body as { messages: Record<string, unknown>[]; think: unknown };
    expect(body.think).toBe(true);
    expect(body.messages[2]).toEqual({ role: 'assistant', content: '<think>\nRead the file first.\n</think>\n\nReading.', tool_calls: [{ id: historyCallId('c1'), function: { name: 'Read', arguments: { file_path: 'a.ts' } } }] });
  });

  it("replays only Ollama's own reasoning, and keeps it from closing or opening the template's markers", async () => {
    const send = async (show: Record<string, unknown>, parts: Parameters<typeof message>[1]) => {
      const { fetch, calls } = fakeFetch({ 'POST /api/show': () => jsonResponse(show), 'POST /api/chat': () => streamResponse(TEXT_STREAM) });
      const history = [message('user', [{ type: 'text', text: 'Go' }]), message('assistant', parts), message('tool', [{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'x' }] }])];
      await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest({ model: 'm', messages: history })));
      return (chatCalls(calls)[0]!.body as { messages: Record<string, unknown>[] }).messages[2]!;
    };
    const call = { type: 'tool_call' as const, id: 'c1', name: 'Read', input: {} };
    const qwen = { ...SHOW_QWEN, template: QWEN_TEMPLATE };
    expect(await send(qwen, [{ type: 'thinking', text: 'Use </think> here, then <think>.', provider: 'ollama' }, call])).toMatchObject({
      content: '<think>\nUse </ think> here, then < think>.\n</think>\n\n',
    });
    expect(await send({ ...SHOW_GPT_OSS_033, template: '{%- if x %}{% endif %}' }, [{ type: 'thinking', text: 'Not <|channel|>final<|message|>', provider: 'ollama' }, call])).toMatchObject({
      content: 'Not < |channel|>final< |message|>',
    });
    // A summary from another provider (after a model switch) isn't replayed.
    const other = await send(qwen, [{ type: 'thinking', text: 'A summary', provider: 'anthropic' }, call]);
    expect(other).toMatchObject({ content: '' });
    expect(other).not.toHaveProperty('thinking');
  });

  it('round-trips a tool call with a synthesized id and sends the result back as role tool', async () => {
    const toolStream = ndjson([
      chunk({ tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] }),
      { ...DONE, done_reason: 'stop' },
    ]);
    const { fetch, calls } = fakeFetch({
      'POST /api/chat': () => streamResponse(chatCalls(calls).length === 1 ? toolStream : TEXT_STREAM),
    });
    const adapter = createOllamaAdapter(instance, deps(fetch));
    const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }];
    const first = await collect(adapter.stream(chatRequest({ tools })));

    const calls1 = first.filter((e): e is Extract<StreamEvent, { type: `tool_call_${string}` }> =>
      e.type.startsWith('tool_call'),
    );
    expect(calls1.map((e) => e.type)).toEqual(['tool_call_start', 'tool_call_delta', 'tool_call_end']);
    const id = calls1[0]!.id;
    expect(id).toMatch(/^call_/);
    expect(calls1.every((e) => e.id === id)).toBe(true);
    expect(calls1[2]).toMatchObject({ input: { path: 'a.txt' } });
    expect(finishOf(first).reason).toBe('tool_use');
    expect(chatCalls(calls)[0]!.body).toMatchObject({
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
        },
      ],
    });

    await collect(
      adapter.stream(
        chatRequest({
          tools,
          messages: [
            message('user', [
              { type: 'text', text: 'Read a.txt' },
              { type: 'image', mime: 'image/png', blob: 'png' },
            ]),
            message('assistant', [{ type: 'tool_call', id, name: 'read_file', input: { path: 'a.txt' } }]),
            message('tool', [{ type: 'tool_result', callId: id, content: [{ type: 'text', text: 'contents' }] }]),
          ],
        }),
      ),
    );
    expect((chatCalls(calls)[1]!.body as { messages: unknown[] }).messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Read a.txt', images: ['iVBORw=='] },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: historyCallId(id), function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
      },
      { role: 'tool', content: 'contents', tool_name: 'read_file', tool_call_id: historyCallId(id) },
    ]);
  });

  it('sends call ids back as nine letters and digits, the same for a call and its result', () => {
    // Mistral's template on Ollama 0.33 refused the 32-character ids the server itself had handed out.
    const id = historyCallId('5E4eAV0P8XhGrzGhPgcnJDcGeg60J2Vl');
    expect(id).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(historyCallId('5E4eAV0P8XhGrzGhPgcnJDcGeg60J2Vl')).toBe(id);
    expect(historyCallId('call_other')).not.toBe(id);
    expect(historyCallId('abcDEF123')).toBe('abcDEF123');
  });

  it('maps done_reason length to max_tokens', async () => {
    const { fetch } = fakeFetch({
      'POST /api/chat': () => streamResponse(ndjson([chunk({ content: 'x' }), { ...DONE, done_reason: 'length' }])),
    });
    const events = await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest()));
    expect(finishOf(events).reason).toBe('max_tokens');
  });

  it('maps HTTP, in-stream and network errors to error finishes', async () => {
    const missing = fakeFetch({ 'POST /api/chat': () => jsonResponse({ error: "model 'nope' not found" }, 404) });
    const notFound = finishOf(await collect(createOllamaAdapter(instance, deps(missing.fetch)).stream(chatRequest())));
    expect(notFound).toMatchObject({
      reason: 'error',
      error: { code: 'model_not_found', fix: 'settings/models', retryable: false },
    });

    const midStream = fakeFetch({
      'POST /api/chat': () => streamResponse(ndjson([chunk({ content: 'a' }), { error: 'server overloaded' }])),
    });
    const busy = finishOf(await collect(createOllamaAdapter(instance, deps(midStream.fetch)).stream(chatRequest())));
    expect(busy).toMatchObject({ reason: 'error', error: { code: 'provider_busy', retryable: true } });

    const offline = finishOf(await collect(createOllamaAdapter(instance, deps(offlineFetch())).stream(chatRequest())));
    expect(offline).toMatchObject({
      reason: 'error',
      error: { code: 'provider_offline', retryable: true },
    });
    expect(offline.error?.fix).toBeUndefined();
  });

  it('reports a stream cut off before done as truncated', async () => {
    const { fetch } = fakeFetch({ 'POST /api/chat': () => streamResponse(ndjson([chunk({ content: 'partial' })])) });
    const events = await collect(createOllamaAdapter(instance, deps(fetch)).stream(chatRequest()));
    expect(finishOf(events)).toMatchObject({ reason: 'error', error: { code: 'stream_truncated', retryable: true } });
  });

  it('finishes with aborted when the request signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch({
      'POST /api/chat': (_call, signal) => streamResponse(ndjson([chunk({ content: 'Hi' })]), { hangUntil: signal }),
    });
    const events: StreamEvent[] = [];
    for await (const e of createOllamaAdapter(instance, deps(fetch)).stream(
      chatRequest({ signal: controller.signal }),
    )) {
      events.push(e);
      if (e.type === 'text') controller.abort();
    }
    expect(textOf(events)).toBe('Hi');
    expect(finishOf(events)).toEqual({ type: 'finish', reason: 'aborted' });
  });

  it('lists chat models with detected capabilities and skips embedding models', async () => {
    const { fetch } = fakeFetch({
      'GET /api/tags': () =>
        jsonResponse({
          models: [{ name: 'qwen3:32b' }, { name: 'gpt-oss:120b' }, { name: 'nomic-embed-text' }, { name: 'old' }],
        }),
      'POST /api/show': (call) => {
        const model = (call.body as { model: string }).model;
        if (model === 'qwen3:32b')
          return jsonResponse({ ...SHOW_QWEN, capabilities: ['completion', 'tools', 'thinking', 'vision'] });
        if (model === 'gpt-oss:120b') return jsonResponse(SHOW_GPT_OSS);
        if (model === 'nomic-embed-text') return jsonResponse({ capabilities: ['embedding'] });
        return jsonResponse({ error: 'boom' }, 500);
      },
    });
    const models = await createOllamaAdapter(instance, deps(fetch)).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['qwen3:32b', 'gpt-oss:120b', 'old']);
    expect(models[0]).toMatchObject({
      ref: 'ollama-1/qwen3:32b',
      // Detected 40960, capped to 32k by default so the KV cache fits consumer GPUs.
      contextLength: 32768,
      capabilities: { tools: 'native', vision: true, reasoning: 'toggle' },
      tier: 'compact',
      source: 'detected',
    });
    expect(models[1]).toMatchObject({
      contextLength: 32768,
      capabilities: { reasoning: 'effort' },
      effortLevels: ['low', 'medium', 'high'],
      tier: 'full',
    });
    expect(models[2]).toMatchObject({ contextLength: 32768, source: 'default', capabilities: { tools: 'native' } });
  });

  it('estimates context from actual tag size and architecture, retaining fallback when metadata is incomplete', async () => {
    const show = { capabilities: ['completion'], model_info: {
      'general.architecture': 'llama', 'llama.context_length': 131072, 'llama.block_count': 32,
      'llama.embedding_length': 4096, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8,
    } };
    const { fetch, calls } = fakeFetch({
      'GET /api/tags': () => jsonResponse({ models: [{ name: 'large', size: 8 * 1024 ** 3 }, { name: 'small', size: 4 * 1024 ** 3 }, { name: 'unknown' }] }),
      'POST /api/show': () => jsonResponse(show),
      'POST /api/chat': () => streamResponse(TEXT_STREAM),
    });
    const adapter = createOllamaAdapter({ ...instance, vramGiB: 16, parallelRequests: 2 }, deps(fetch));
    const models = await adapter.listModels();
    expect(models.map((m) => m.contextLength)).toEqual([28672, 45312, 32768]);
    await collect(adapter.stream(chatRequest({ model: 'large', contextLength: models[0]!.contextLength })));
    expect(chatCalls(calls)[0]!.body).toMatchObject({ options: { num_ctx: 28672 } });
    // An explicit per-model context is authoritative, even above the estimate.
    await collect(adapter.stream(chatRequest({ model: 'large', contextLength: 65536 })));
    expect(chatCalls(calls)[1]!.body).toMatchObject({ options: { num_ctx: 65536 } });
    const fallback = await createOllamaAdapter(instance, deps(fetch)).listModels();
    expect(fallback.map((m) => m.contextLength)).toEqual([32768, 32768, 32768]);
  });

  it('refreshes architecture metadata on every explicit model discovery', async () => {
    let context = 8192;
    const { fetch, calls } = fakeFetch({
      'GET /api/tags': () => jsonResponse({ models: [{ name: 'refresh' }] }),
      'POST /api/show': () => jsonResponse({ capabilities: ['completion'], model_info: { 'general.architecture': 'llama', 'llama.context_length': context } }),
    });
    const adapter = createOllamaAdapter(instance, deps(fetch));
    expect((await adapter.listModels())[0]?.contextLength).toBe(8192);
    context = 16384;
    expect((await adapter.listModels())[0]?.contextLength).toBe(16384);
    expect(calls.filter((call) => call.url.endsWith('/api/show'))).toHaveLength(2);
  });

  it('reports health with version and latency', async () => {
    const { fetch } = fakeFetch({ 'GET /api/version': () => jsonResponse({ version: '0.13.2' }) });
    const health = await createOllamaAdapter(instance, deps(fetch)).health();
    expect(health).toMatchObject({ ok: true, version: '0.13.2', warnings: [] });
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);

    const down = await createOllamaAdapter(instance, deps(offlineFetch())).health();
    expect(down).toMatchObject({ ok: false, latencyMs: null });
    expect(down.error).toContain('Cannot reach');
  });

  it('keeps text from a later user turn after the tool results', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /api/chat': () => streamResponse(TEXT_STREAM) });
    await collect(
      createOllamaAdapter(instance, deps(fetch)).stream(
        chatRequest({ messages: [userText('a'), message('assistant', [{ type: 'text', text: 'b' }]), userText('c')] }),
      ),
    );
    expect((chatCalls(calls)[0]!.body as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });
});
