import { describe, expect, it } from 'vitest';
import {
  API_KEY,
  chatRequest,
  collect,
  deps,
  fakeFetch,
  finishOf,
  jsonResponse,
  message,
  providerInstance,
  sse,
  streamResponse,
  textOf,
  thinkingOf,
  usageOf,
} from './__fixtures__/harness.ts';
import { createOpenAICompatibleAdapter } from './openai-compatible.ts';
import type { StreamEvent } from './types.ts';

const instance = providerInstance('openai-compatible', 'http://localhost:1234/v1', API_KEY);

const delta = (d: Record<string, unknown>, finish: string | null = null): { data: unknown } => ({
  data: { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] },
});
const usageChunk = (usage: Record<string, unknown>): { data: unknown } => ({
  data: { id: 'c1', object: 'chat.completion.chunk', choices: [], usage },
});

const TEXT = sse(
  [
    delta({ role: 'assistant', content: '' }),
    delta({ content: 'Hi ' }),
    delta({ content: 'there' }),
    delta({}, 'stop'),
    usageChunk({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 60 },
      completion_tokens_details: { reasoning_tokens: 2 },
    }),
  ],
  true,
);

type ToolEvent = Extract<StreamEvent, { type: 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' }>;
const toolEvents = (events: StreamEvent[]): ToolEvent[] =>
  events.filter((e): e is ToolEvent => e.type.startsWith('tool_call'));

describe('openai-compatible adapter', () => {
  it('streams text, guards the empty-choices usage chunk and joins /v1 once', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/chat/completions': () => streamResponse(TEXT) });
    const events = await collect(createOpenAICompatibleAdapter(instance, deps(fetch)).stream(chatRequest()));

    expect(textOf(events)).toBe('Hi there');
    expect(usageOf(events)).toEqual({ input: 40, output: 5, cacheRead: 60, reasoning: 2 });
    expect(finishOf(events)).toEqual({ type: 'finish', reason: 'end' });
    expect(calls[0]!.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]!.body).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096,
    });
  });

  it('parses reasoning_content and reasoning deltas as thinking and sends reasoning_effort', async () => {
    const stream = sse(
      [
        delta({ reasoning_content: 'Consider ' }),
        delta({ reasoning: 'options.' }),
        delta({ content: 'Answer' }),
        delta({}, 'stop'),
        usageChunk({ prompt_tokens: 1, completion_tokens: 1 }),
      ],
      true,
    );
    const { fetch, calls } = fakeFetch({ 'POST /v1/chat/completions': () => streamResponse(stream) });
    const events = await collect(
      createOpenAICompatibleAdapter(instance, deps(fetch)).stream(chatRequest({ effort: 'xhigh' })),
    );
    expect(thinkingOf(events)).toBe('Consider options.');
    expect(textOf(events)).toBe('Answer');
    expect(calls[0]!.body).toMatchObject({ reasoning_effort: 'high' });
  });

  it('sends low and medium as they are and every higher level as high', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/chat/completions': () => streamResponse(sse([delta({ content: 'Hi' }), delta({}, 'stop')], true)) });
    const adapter = createOpenAICompatibleAdapter(instance, deps(fetch));
    const sent: unknown[] = [];
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const) {
      await collect(adapter.stream(chatRequest({ effort })));
      sent.push((calls.at(-1)!.body as { reasoning_effort: string }).reasoning_effort);
    }
    expect(sent).toEqual(['low', 'medium', 'high', 'high', 'high', 'high']);
    await collect(adapter.stream(chatRequest()));
    expect(calls.at(-1)!.body).not.toHaveProperty('reasoning_effort');
  });

  it('merges OpenRouter reasoning_details for verbatim replay', async () => {
    const stream = sse(
      [
        delta({
          reasoning: 'Step 1',
          reasoning_details: [{ type: 'reasoning.text', text: 'Step 1', index: 0, format: 'anthropic-claude-v1' }],
        }),
        delta({ reasoning: '. Step 2', reasoning_details: [{ type: 'reasoning.text', text: '. Step 2', index: 0 }] }),
        delta({ reasoning_details: [{ type: 'reasoning.text', signature: 'sig==', index: 0 }] }),
        delta({ content: 'ok' }, 'stop'),
      ],
      true,
    );
    const { fetch, calls } = fakeFetch({ 'POST /v1/chat/completions': () => streamResponse(stream) });
    const adapter = createOpenAICompatibleAdapter(instance, deps(fetch));
    const events = await collect(adapter.stream(chatRequest()));
    expect(thinkingOf(events)).toBe('Step 1. Step 2');
    const replay = events.find((e) => e.type === 'thinking_replay');
    const details = [
      { type: 'reasoning.text', text: 'Step 1. Step 2', index: 0, format: 'anthropic-claude-v1', signature: 'sig==' },
    ];
    expect(replay).toEqual({ type: 'thinking_replay', data: details });

    await collect(
      adapter.stream(
        chatRequest({
          messages: [
            message('user', [{ type: 'text', text: 'q' }]),
            message('assistant', [
              { type: 'thinking', text: 'Step 1. Step 2', replay: details, provider: 'openai-compatible' },
              { type: 'thinking', text: 'other', replay: [{ x: 1 }], provider: 'anthropic' },
              { type: 'text', text: 'ok' },
            ]),
            message('user', [{ type: 'text', text: 'next' }]),
          ],
        }),
      ),
    );
    const sent = (calls[1]!.body as { messages: Record<string, unknown>[] }).messages[2];
    expect(sent).toEqual({ role: 'assistant', content: 'ok', reasoning_details: details });
  });

  it('merges split tool-call deltas by index and round-trips the results', async () => {
    const stream = sse(
      [
        delta({
          role: 'assistant',
          content: null,
          tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } }],
        }),
        delta({
          tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list', arguments: '{"dir"' } }],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
        delta({ tool_calls: [{ index: 1, function: { arguments: ':"src"}' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
        delta({}, 'tool_calls'),
        usageChunk({ prompt_tokens: 10, completion_tokens: 8 }),
      ],
      true,
    );
    const { fetch, calls } = fakeFetch({
      'POST /v1/chat/completions': () => streamResponse(calls.length === 1 ? stream : TEXT),
    });
    const adapter = createOpenAICompatibleAdapter(instance, deps(fetch));
    const tools = [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }];
    const events = await collect(adapter.stream(chatRequest({ tools })));

    expect(toolEvents(events)).toEqual([
      { type: 'tool_call_start', id: 'call_a', name: 'read' },
      { type: 'tool_call_start', id: 'call_b', name: 'list' },
      { type: 'tool_call_delta', id: 'call_b', json: '{"dir"' },
      { type: 'tool_call_delta', id: 'call_a', json: '{"path":' },
      { type: 'tool_call_delta', id: 'call_b', json: ':"src"}' },
      { type: 'tool_call_delta', id: 'call_a', json: '"a.ts"}' },
      { type: 'tool_call_end', id: 'call_a', input: { path: 'a.ts' } },
      { type: 'tool_call_end', id: 'call_b', input: { dir: 'src' } },
    ]);
    expect(finishOf(events).reason).toBe('tool_use');
    expect(calls[0]!.body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }],
    });

    await collect(
      adapter.stream(
        chatRequest({
          tools,
          messages: [
            message('user', [{ type: 'text', text: 'look' }]),
            message('assistant', [
              { type: 'tool_call', id: 'call_a', name: 'read', input: { path: 'a.ts' } },
              { type: 'tool_call', id: 'call_b', name: 'list', input: { dir: 'src' } },
            ]),
            message('tool', [
              { type: 'tool_result', callId: 'call_a', content: [{ type: 'text', text: 'file body' }] },
              {
                type: 'tool_result',
                callId: 'call_b',
                content: [
                  { type: 'text', text: 'denied' },
                  { type: 'image', mime: 'image/png', blob: 'png' },
                ],
                isError: true,
              },
            ]),
          ],
        }),
      ),
    );
    expect((calls[1]!.body as { messages: unknown[] }).messages.slice(2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
          { id: 'call_b', type: 'function', function: { name: 'list', arguments: '{"dir":"src"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'file body' },
      { role: 'tool', tool_call_id: 'call_b', content: 'Error: denied' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Images returned by the tool calls above:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
        ],
      },
    ]);
  });

  it('synthesizes ids for servers that send whole tool calls without index or id', async () => {
    const stream = sse(
      [
        delta({ tool_calls: [{ function: { name: 'a', arguments: '{"x":1}' } }] }),
        delta({ tool_calls: [{ id: 'second', function: { name: 'b', arguments: '{}' } }] }),
        delta({ tool_calls: [{ function: { name: 'c', arguments: '{"y":' } }] }),
        delta({ tool_calls: [{ function: { arguments: '2}' } }] }),
        delta({}, 'stop'),
      ],
      true,
    );
    const { fetch } = fakeFetch({ 'POST /v1/chat/completions': () => streamResponse(stream) });
    const events = await collect(createOpenAICompatibleAdapter(instance, deps(fetch)).stream(chatRequest()));
    const ends = toolEvents(events).filter((e) => e.type === 'tool_call_end');
    expect(ends).toHaveLength(3);
    expect(ends[0]).toMatchObject({ input: { x: 1 } });
    expect(ends[0]!.id).toMatch(/^call_/);
    expect(ends[1]).toMatchObject({ id: 'second', input: {} });
    expect(ends[2]).toMatchObject({ input: { y: 2 } });
    expect(finishOf(events).reason).toBe('tool_use');
  });

  it('sends images as data URLs', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/chat/completions': () => streamResponse(TEXT) });
    await collect(
      createOpenAICompatibleAdapter(instance, deps(fetch)).stream(
        chatRequest({
          messages: [
            message('user', [
              { type: 'text', text: 'What is this?' },
              { type: 'image', mime: 'image/png', blob: 'png' },
            ]),
          ],
        }),
      ),
    );
    expect((calls[0]!.body as { messages: unknown[] }).messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
      ],
    });
  });

  it('maps HTTP errors without leaking the API key', async () => {
    const auth = fakeFetch({
      'POST /v1/chat/completions': () =>
        jsonResponse({ error: { message: `Incorrect API key provided: ${API_KEY}` } }, 401),
    });
    const authFinish = finishOf(
      await collect(createOpenAICompatibleAdapter(instance, deps(auth.fetch)).stream(chatRequest())),
    );
    expect(authFinish).toMatchObject({
      reason: 'error',
      error: { code: 'provider_auth', fix: 'settings/providers', retryable: false },
    });
    expect(JSON.stringify(authFinish)).not.toContain(API_KEY);

    const busy = fakeFetch({
      'POST /v1/chat/completions': () => jsonResponse({ error: { message: 'Rate limited' } }, 429),
    });
    const busyFinish = finishOf(
      await collect(createOpenAICompatibleAdapter(instance, deps(busy.fetch)).stream(chatRequest())),
    );
    expect(busyFinish).toMatchObject({ reason: 'error', error: { code: 'provider_busy', retryable: true } });
  });

  it('maps an in-stream error chunk and reports a cut-off stream as truncated', async () => {
    const errStream = sse([delta({ content: 'a' }), { data: { error: { code: 502, message: 'Upstream error' } } }]);
    const errored = fakeFetch({ 'POST /v1/chat/completions': () => streamResponse(errStream) });
    const errFinish = finishOf(
      await collect(createOpenAICompatibleAdapter(instance, deps(errored.fetch)).stream(chatRequest())),
    );
    expect(errFinish).toMatchObject({ reason: 'error', error: { code: 'provider_busy', retryable: true } });

    const cut = fakeFetch({ 'POST /v1/chat/completions': () => streamResponse(sse([delta({ content: 'a' })])) });
    const cutFinish = finishOf(
      await collect(createOpenAICompatibleAdapter(instance, deps(cut.fetch)).stream(chatRequest())),
    );
    expect(cutFinish).toMatchObject({ reason: 'error', error: { code: 'stream_truncated' } });
  });

  it('lists models with OpenRouter metadata when present and defaults otherwise', async () => {
    const openrouter = providerInstance('openai-compatible', 'https://openrouter.ai/api/v1', API_KEY);
    const { fetch, calls } = fakeFetch({
      'GET /api/v1/models': () =>
        jsonResponse({
          data: [
            {
              id: 'anthropic/claude-opus-5-5',
              name: 'Anthropic: Claude Opus 5.5',
              context_length: 1_000_000,
              architecture: { input_modalities: ['text', 'image', 'file'] },
              supported_parameters: ['tools', 'reasoning', 'max_tokens'],
              top_provider: { max_completion_tokens: 128_000 },
            },
            {
              id: 'some/small-model',
              context_length: 8192,
              architecture: { input_modalities: ['text'] },
              supported_parameters: ['max_tokens'],
              top_provider: { max_completion_tokens: null },
            },
          ],
        }),
    });
    const models = await createOpenAICompatibleAdapter(openrouter, deps(fetch)).listModels();
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/models');
    expect(models[0]).toMatchObject({
      modelId: 'anthropic/claude-opus-5-5',
      displayName: 'Anthropic: Claude Opus 5.5',
      contextLength: 1_000_000,
      maxOutput: 128_000,
      capabilities: { tools: 'native', vision: true, pdf: true, reasoning: 'effort' },
      tier: 'full',
      source: 'detected',
    });
    // OpenRouter lists what each model takes: one without tools gets none.
    expect(models[1]).toMatchObject({
      capabilities: { tools: 'none', vision: false },
      maxOutput: 8192,
      tier: 'compact',
    });
    expect(models.some((m) => m.free)).toBe(false);

    const plain = fakeFetch({
      'GET /v1/models': () => jsonResponse({ data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'text-embedding-nomic' }] }),
    });
    const local = await createOpenAICompatibleAdapter(instance, deps(plain.fetch)).listModels();
    expect(local).toEqual([
      expect.objectContaining({
        modelId: 'qwen2.5-7b-instruct',
        contextLength: 32768,
        capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: false },
        source: 'default',
      }),
    ]);
  });

  it('marks OpenRouter’s free models and sends its attribution headers', async () => {
    const openrouter = providerInstance('openai-compatible', 'https://openrouter.ai/api/v1', API_KEY);
    const { fetch, calls } = fakeFetch({
      'GET /api/v1/models': () =>
        jsonResponse({
          data: [
            { id: 'google/gemma-4-31b-it:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
            { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
            { id: 'anthropic/claude-opus-5-5', pricing: { prompt: '0.000004', completion: '0.00002' }, supported_parameters: ['tools'] },
          ],
        }),
      'POST /api/v1/chat/completions': () => streamResponse(TEXT),
    });
    const adapter = createOpenAICompatibleAdapter(openrouter, deps(fetch));
    expect((await adapter.listModels()).map((m) => [m.modelId, !!m.free])).toEqual([
      ['google/gemma-4-31b-it:free', true],
      ['openrouter/free', true],
      ['anthropic/claude-opus-5-5', false],
    ]);
    await collect(adapter.stream(chatRequest()));
    for (const call of calls) {
      expect(call.headers['http-referer']).toBe('https://atelierhq.dev');
      expect(call.headers['x-openrouter-title']).toBe('Atelier');
      expect(call.headers['x-title']).toBe('Atelier');
    }

    // Other servers get no attribution.
    const local = fakeFetch({ 'GET /v1/models': () => jsonResponse({ data: [] }) });
    await createOpenAICompatibleAdapter(instance, deps(local.fetch)).listModels();
    expect(local.calls[0]!.headers['http-referer']).toBeUndefined();
  });

  it('lists OpenCode Zen’s models where it publishes them and chats on its OpenAI path', async () => {
    const zen = providerInstance('openai-compatible', 'https://opencode.ai/inference/openai/v1', API_KEY);
    const { fetch, calls } = fakeFetch({
      'GET /inference/v1/models': () => jsonResponse({ object: 'list', data: [{ id: 'claude-fable-5', object: 'model', owned_by: 'opencode' }] }),
      'POST /inference/openai/v1/chat/completions': () => streamResponse(TEXT),
    });
    const adapter = createOpenAICompatibleAdapter(zen, deps(fetch));
    expect((await adapter.listModels()).map((m) => m.modelId)).toEqual(['claude-fable-5']);
    expect(textOf(await collect(adapter.stream(chatRequest())))).toBe('Hi there');
    expect(calls.map((c) => c.url)).toEqual(['https://opencode.ai/inference/v1/models', 'https://opencode.ai/inference/openai/v1/chat/completions']);
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[1]!.headers['user-agent']).toBeUndefined();
  });

  it('checks health against the models endpoint', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/models': () => jsonResponse({ data: [] }) });
    expect(await createOpenAICompatibleAdapter(instance, deps(fetch)).health()).toMatchObject({
      ok: true,
      warnings: [],
    });
    const denied = fakeFetch({ 'GET /v1/models': () => jsonResponse({ error: 'no' }, 401) });
    const health = await createOpenAICompatibleAdapter(instance, deps(denied.fetch)).health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain('rejected the credentials');
  });
});
