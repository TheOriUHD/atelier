import { describe, expect, it } from 'vitest';
import {
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
import { createLlamaCppAdapter } from './llamacpp.ts';

// Users often paste the OpenAI-style URL; server-root endpoints must still resolve.
const instance = providerInstance('llamacpp', 'http://localhost:8080/v1');

const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
  extra: Record<string, unknown> = {},
): { data: unknown } => ({
  data: {
    object: 'chat.completion.chunk',
    model: 'qwen3',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  },
});

const TIMINGS = { prompt_n: 30, prompt_ms: 120, predicted_n: 12, predicted_ms: 300, predicted_per_second: 40 };

const REASONING_STREAM = sse(
  [
    chunk({ role: 'assistant', content: null }),
    chunk({ reasoning_content: 'Hmm, ' }),
    chunk({ reasoning_content: 'easy.' }),
    chunk({ content: '4' }),
    chunk({}, 'stop', { timings: TIMINGS }),
    {
      data: {
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 30, completion_tokens: 12 },
        timings: TIMINGS,
      },
    },
  ],
  true,
);

const PROPS = {
  default_generation_settings: { n_ctx: 16384 },
  model_path: '/models/Qwen3-8B-Q4_K_M.gguf',
  modalities: { vision: true, audio: false },
  chat_template_caps: { supports_tools: true, supports_tool_calls: true, supports_system_role: true },
};

describe('llama.cpp adapter', () => {
  it('streams reasoning_content as thinking and reports tokens/s from timings', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/chat/completions': () => streamResponse(REASONING_STREAM) });
    const events = await collect(createLlamaCppAdapter(instance, deps(fetch)).stream(chatRequest()));
    expect(calls[0]!.url).toBe('http://localhost:8080/v1/chat/completions');
    // The server holds its one model: before any output it is reading the prompt.
    expect(events[0]).toEqual({ type: 'phase', phase: 'reading' });
    expect(thinkingOf(events)).toBe('Hmm, easy.');
    expect(textOf(events)).toBe('4');
    expect(usageOf(events)).toEqual({ input: 30, output: 12, tokensPerSecond: 40, durationMs: 420 });
    expect(finishOf(events).reason).toBe('end');
  });

  it('round-trips a tool call through the shared chat-completions core', async () => {
    const toolStream = sse(
      [
        chunk({
          tool_calls: [{ index: 0, id: 'abc', type: 'function', function: { name: 'grep', arguments: '{"pattern":' } }],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"TODO"}' } }] }),
        chunk({}, 'tool_calls', { timings: TIMINGS }),
      ],
      true,
    );
    const { fetch, calls } = fakeFetch({
      'POST /v1/chat/completions': () => streamResponse(calls.length === 1 ? toolStream : REASONING_STREAM),
    });
    const adapter = createLlamaCppAdapter(instance, deps(fetch));
    const tools = [{ name: 'grep', description: 'Search', inputSchema: { type: 'object' } }];
    const events = await collect(adapter.stream(chatRequest({ tools })));
    expect(events.find((e) => e.type === 'tool_call_end')).toEqual({
      type: 'tool_call_end',
      id: 'abc',
      input: { pattern: 'TODO' },
    });
    expect(finishOf(events).reason).toBe('tool_use');

    await collect(
      adapter.stream(
        chatRequest({
          tools,
          messages: [
            message('user', [{ type: 'text', text: 'find todos' }]),
            message('assistant', [{ type: 'tool_call', id: 'abc', name: 'grep', input: { pattern: 'TODO' } }]),
            message('tool', [{ type: 'tool_result', callId: 'abc', content: [{ type: 'text', text: 'a.ts:1' }] }]),
          ],
        }),
      ),
    );
    expect((calls[1]!.body as { messages: unknown[] }).messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'abc',
      content: 'a.ts:1',
    });
  });

  it('maps a template/jinja 400 on a tool request to llamacpp_no_jinja', async () => {
    const { fetch } = fakeFetch({
      'POST /v1/chat/completions': () =>
        jsonResponse(
          { error: { code: 400, message: 'tools param requires --jinja flag', type: 'invalid_request_error' } },
          400,
        ),
    });
    const tools = [{ name: 'grep', description: 'Search', inputSchema: { type: 'object' } }];
    const events = await collect(createLlamaCppAdapter(instance, deps(fetch)).stream(chatRequest({ tools })));
    const finish = finishOf(events);
    expect(finish).toMatchObject({
      reason: 'error',
      error: { code: 'llamacpp_no_jinja', fix: 'settings/models', retryable: false },
    });
    expect(finish.error!.message).toContain('--jinja');

    const plain = await collect(createLlamaCppAdapter(instance, deps(fetch)).stream(chatRequest()));
    expect(finishOf(plain).error!.code).toBe('provider_error');
  });

  it('lists the single loaded model from /props and /v1/models', async () => {
    const { fetch } = fakeFetch({
      'GET /models': () => jsonResponse({ data: [{ id: 'Qwen3-8B-Q4_K_M.gguf', object: 'model' }] }),
      'GET /props': () => jsonResponse(PROPS),
      'GET /v1/models': () => jsonResponse({ data: [{ id: 'Qwen3-8B-Q4_K_M.gguf', meta: { n_ctx_train: 40960 } }] }),
    });
    const models = await createLlamaCppAdapter(instance, deps(fetch)).listModels();
    expect(models).toEqual([
      expect.objectContaining({
        ref: 'llamacpp-1/Qwen3-8B-Q4_K_M.gguf',
        contextLength: 16384,
        capabilities: { tools: 'native', vision: true, pdf: false, reasoning: 'none', caching: false },
        source: 'detected',
        tier: 'compact',
      }),
    ]);
  });

  it('reads from the chat template how a model can be told to think, and sends it as chat_template_kwargs', async () => {
    const qwen = "{%- if enable_thinking is defined and enable_thinking is false %}<think>\n\n</think>{%- endif %}";
    const gptOss = "Reasoning: {{ reasoning_effort | default('medium') }}";
    const listWith = async (template: string | undefined) => {
      const { fetch } = fakeFetch({
        'GET /props': () => jsonResponse({ ...PROPS, ...(template ? { chat_template: template } : {}) }),
        'GET /v1/models': () => jsonResponse({ data: [{ id: 'm' }] }),
      });
      const adapter = createLlamaCppAdapter(instance, deps(fetch));
      return { adapter, models: await adapter.listModels() };
    };
    expect((await listWith(qwen)).models[0]).toMatchObject({ capabilities: { reasoning: 'toggle' } });
    expect((await listWith(gptOss)).models[0]).toMatchObject({ capabilities: { reasoning: 'effort' }, effortLevels: ['low', 'medium', 'high'] });
    expect((await listWith('{{ messages }}')).models[0]).toMatchObject({ capabilities: { reasoning: 'none' } });

    // A switch is set either way, so a request without a level turns thinking off.
    const body = async (template: string, effort: 'high' | 'low' | null) => {
      const { fetch, calls } = fakeFetch({
        'GET /props': () => jsonResponse({ ...PROPS, chat_template: template }),
        'GET /v1/models': () => jsonResponse({ data: [{ id: 'm' }] }),
        'POST /v1/chat/completions': () => streamResponse(REASONING_STREAM),
      });
      const a = createLlamaCppAdapter(instance, deps(fetch));
      await a.listModels();
      await collect(a.stream(chatRequest({ model: 'm', effort })));
      return calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    };
    expect(await body(qwen, 'high')).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
    expect(await body(qwen, null)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(await body(qwen, 'high')).not.toHaveProperty('reasoning_effort');
    // A level: passed to the template; none sent, none passed.
    expect(await body(gptOss, 'low')).toMatchObject({ chat_template_kwargs: { reasoning_effort: 'low' }, reasoning_effort: 'low' });
    expect(await body(gptOss, null)).not.toHaveProperty('chat_template_kwargs');
    // A template that reads neither is left alone.
    expect(await body('{{ messages }}', 'high')).not.toHaveProperty('chat_template_kwargs');
  });

  it('marks tools unverified when chat_template_caps is absent and prompted when caps deny tools', async () => {
    const legacy = fakeFetch({
      'GET /props': () => jsonResponse({ n_ctx: 4096, model_path: 'C:\\models\\tiny.gguf' }),
      'GET /v1/models': () => jsonResponse({ error: 'nope' }, 500),
    });
    const [model] = await createLlamaCppAdapter(instance, deps(legacy.fetch)).listModels();
    expect(model).toMatchObject({
      modelId: 'tiny.gguf',
      contextLength: 4096,
      capabilities: { tools: 'native' },
      source: 'default',
    });

    const noTools = fakeFetch({
      'GET /props': () =>
        jsonResponse({ ...PROPS, chat_template_caps: { supports_tools: false, supports_tool_calls: false } }),
      'GET /v1/models': () => jsonResponse({ data: [{ id: 'm' }] }),
    });
    const [denied] = await createLlamaCppAdapter(instance, deps(noTools.fetch)).listModels();
    expect(denied!.capabilities.tools).toBe('prompted');
  });

  it('lists router-mode models and only asks loaded ones for props', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /models': () =>
        jsonResponse({
          data: [
            { id: 'qwen3-8b', status: { value: 'loaded' } },
            { id: 'gemma-3-27b', status: { value: 'unloaded' } },
          ],
        }),
      'GET /props?model=qwen3-8b': () => jsonResponse(PROPS),
    });
    const models = await createLlamaCppAdapter(instance, deps(fetch)).listModels();
    expect(models.map((m) => [m.modelId, m.contextLength, m.source])).toEqual([
      ['qwen3-8b', 16384, 'detected'],
      ['gemma-3-27b', 32768, 'default'],
    ]);
    expect(calls.filter((c) => c.url.includes('/props'))).toHaveLength(1);
  });

  it('reports a loading server as not ok with a warning', async () => {
    const loading = fakeFetch({
      'GET /health': () => jsonResponse({ error: { code: 503, message: 'Loading model' } }, 503),
    });
    expect(await createLlamaCppAdapter(instance, deps(loading.fetch)).health()).toMatchObject({
      ok: false,
      warnings: ['llama-server is still loading the model'],
    });
    const ready = fakeFetch({ 'GET /health': () => jsonResponse({ status: 'ok' }) });
    expect(await createLlamaCppAdapter(instance, deps(ready.fetch)).health()).toMatchObject({ ok: true });
  });

  it('counts tokens with /tokenize on the flattened prompt', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /tokenize': () => jsonResponse({ tokens: [1, 2, 3, 4, 5, 6, 7] }) });
    const adapter = createLlamaCppAdapter(instance, deps(fetch));
    const count = await adapter.countTokens!(chatRequest());
    expect(count).toBe(7 + 4);
    expect(calls[0]!.body).toEqual({ content: 'You are helpful.\n\nuser: Hello' });
  });
});
