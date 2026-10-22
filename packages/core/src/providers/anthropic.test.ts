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
  userText,
} from './__fixtures__/harness.ts';
import { allowsSampling, claudeVersion, createAnthropicAdapter, usesBudgetThinking } from './anthropic.ts';
import type { ChatRequest, StreamEvent } from './types.ts';

const instance = providerInstance('anthropic', 'https://api.anthropic.com', API_KEY);

const ev = (type: string, data: Record<string, unknown> = {}): { event: string; data: unknown } => ({
  event: type,
  data: { type, ...data },
});

const messageStart = (usage: Record<string, unknown>): { event: string; data: unknown } =>
  ev('message_start', {
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-opus-5-5',
      stop_reason: null,
      usage,
    },
  });

const THINKING_STREAM = sse([
  messageStart({ input_tokens: 12, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 1 }),
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
  ev('ping'),
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'The user ' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'greets me.' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM' } }),
  ev('content_block_stop', { index: 0 }),
  ev('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'EmwKAhgB' } }),
  ev('content_block_stop', { index: 1 }),
  ev('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'Hello' } }),
  ev('content_block_delta', { index: 2, delta: { type: 'citations_delta', citation: {} } }),
  ev('content_block_delta', { index: 2, delta: { type: 'text_delta', text: '!' } }),
  ev('content_block_stop', { index: 2 }),
  ev('content_block_start', { index: 3, content_block: { type: 'some_future_block', payload: 1 } }),
  ev('content_block_stop', { index: 3 }),
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 15 } }),
  ev('message_stop'),
]);

const TOOL_STREAM = sse([
  messageStart({ input_tokens: 50, output_tokens: 1 }),
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Checking.' } }),
  ev('content_block_stop', { index: 0 }),
  ev('content_block_start', {
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: {} },
  }),
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path": "src/' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'a.ts"}' } }),
  ev('content_block_stop', { index: 1 }),
  ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }),
  ev('message_stop'),
]);

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  { name: 'list_dir', description: 'List a directory', inputSchema: { type: 'object' } },
];

function cacheControlCount(body: unknown): number {
  return (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;
}

describe('claude version rules', () => {
  it.each([
    ['claude-opus-5-5', { major: 5, minor: 5 }, false, false],
    ['claude-fable-5-1', { major: 5, minor: 1 }, false, false],
    ['claude-opus-4-7', { major: 4, minor: 7 }, false, false],
    ['claude-opus-4-6', { major: 4, minor: 6 }, false, true],
    ['claude-sonnet-4-5-20250929', { major: 4, minor: 5 }, true, true],
    ['claude-opus-4-20250514', { major: 4, minor: 0 }, true, true],
    ['claude-3-7-sonnet-latest', { major: 3, minor: 7 }, true, true],
    ['claude-3-opus-20240229', { major: 3, minor: 0 }, true, true],
    ['claude-next', null, false, false],
  ])('%s', (id, version, budget, sampling) => {
    expect(claudeVersion(id)).toEqual(version);
    expect(usesBudgetThinking(id)).toBe(budget);
    expect(allowsSampling(id)).toBe(sampling);
  });
});

describe('anthropic adapter', () => {
  it('streams thinking, signatures, redacted thinking and text, tolerating unknown events and blocks', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v1/messages': () => streamResponse(THINKING_STREAM, { chunkSize: 11 }),
    });
    const events = await collect(
      createAnthropicAdapter(instance, deps(fetch)).stream(chatRequest({ model: 'claude-opus-5-5' })),
    );

    expect(thinkingOf(events)).toBe('The user greets me.');
    expect(textOf(events)).toBe('Hello!');
    expect(events.filter((e) => e.type === 'thinking_replay')).toEqual([
      { type: 'thinking_replay', data: 'EqQBCgIYAhIM' },
      { type: 'thinking_replay', data: 'EmwKAhgB', redacted: true },
    ]);
    expect(usageOf(events)).toEqual({ input: 12, output: 15, cacheRead: 2000, cacheWrite: 100 });
    expect(finishOf(events)).toEqual({ type: 'finish', reason: 'end' });
    expect(calls[0]!.headers).toMatchObject({ 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' });
    expect(calls[0]!.headers).not.toHaveProperty('authorization');
  });

  it('uses adaptive summarized thinking with output_config.effort and never sends temperature to claude-opus-5-5', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/messages': () => streamResponse(THINKING_STREAM) });
    await collect(
      createAnthropicAdapter(instance, deps(fetch)).stream(
        chatRequest({
          model: 'claude-opus-5-5',
          effort: 'xhigh',
          temperature: 0.2,
          tools: TOOLS,
          toolChoice: { name: 'read_file' },
        }),
      ),
    );
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4096,
      stream: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
    });
    for (const key of ['temperature', 'top_p', 'top_k', 'tool_choice']) expect(body).not.toHaveProperty(key);

    // Without effort there is no thinking, but sampling parameters are still never sent.
    await collect(
      createAnthropicAdapter(instance, deps(fetch)).stream(chatRequest({ model: 'claude-opus-5-5', temperature: 0.2 })),
    );
    expect(calls[1]!.body).not.toHaveProperty('temperature');
    expect(calls[1]!.body).not.toHaveProperty('thinking');
  });

  it('uses budget thinking for legacy models and sends temperature only without thinking', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/messages': () => streamResponse(THINKING_STREAM) });
    const adapter = createAnthropicAdapter(instance, deps(fetch));
    await collect(
      adapter.stream(
        chatRequest({ model: 'claude-sonnet-4-5', effort: 'medium', temperature: 0.5, maxOutputTokens: 32000 }),
      ),
    );
    expect(calls[0]!.body).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 10000 } });
    expect(calls[0]!.body).not.toHaveProperty('output_config');
    expect(calls[0]!.body).not.toHaveProperty('temperature');

    await collect(adapter.stream(chatRequest({ model: 'claude-3-7-sonnet-latest', temperature: 0.5 })));
    expect(calls[1]!.body).toMatchObject({ temperature: 0.5 });
  });

  it('runs Ultracode at Extra, clamped to the levels a model has, and budgets each level on legacy models', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/messages': () => streamResponse(THINKING_STREAM) });
    const adapter = createAnthropicAdapter(instance, deps(fetch));
    const sent = async (request: Partial<ChatRequest>) => {
      await collect(adapter.stream(chatRequest(request)));
      return calls.at(-1)!.body as Record<string, unknown>;
    };
    expect(await sent({ model: 'claude-opus-5-5', effort: 'ultracode' })).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
    });
    expect(await sent({ model: 'claude-opus-5-5', effort: 'low' })).toMatchObject({ output_config: { effort: 'low' } });
    const budgets = [];
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const) {
      budgets.push(((await sent({ model: 'claude-opus-4-5', effort, maxOutputTokens: 64_000 })).thinking as { budget_tokens: number }).budget_tokens);
    }
    expect(budgets).toEqual([4_000, 10_000, 20_000, 32_000, 48_000, 32_000]);
    // The budget always leaves room for the answer.
    expect((await sent({ model: 'claude-opus-4-5', effort: 'max', maxOutputTokens: 32_000 })).thinking).toEqual({ type: 'enabled', budget_tokens: 30_976 });
  });

  it('round-trips a tool call: replays signatures, drops foreign thinking and puts tool_result blocks first', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v1/messages': () => streamResponse(calls.length === 1 ? TOOL_STREAM : THINKING_STREAM),
    });
    const adapter = createAnthropicAdapter(instance, deps(fetch));
    const events = await collect(adapter.stream(chatRequest({ model: 'claude-opus-5-5', tools: TOOLS })));
    const toolEvents = events.filter((e) => e.type.startsWith('tool_call'));
    expect(toolEvents).toEqual([
      { type: 'tool_call_start', id: 'toolu_01', name: 'read_file' },
      { type: 'tool_call_delta', id: 'toolu_01', json: '{"path": "src/' },
      { type: 'tool_call_delta', id: 'toolu_01', json: 'a.ts"}' },
      { type: 'tool_call_end', id: 'toolu_01', input: { path: 'src/a.ts' } },
    ] satisfies StreamEvent[]);
    expect(finishOf(events).reason).toBe('tool_use');
    expect(usageOf(events)).toEqual({ input: 50, output: 30 });

    await collect(
      adapter.stream(
        chatRequest({
          model: 'claude-opus-5-5',
          tools: TOOLS,
          messages: [
            userText('Read src/a.ts'),
            message('assistant', [
              { type: 'thinking', text: 'Need the file.', replay: 'sig-1', provider: 'anthropic' },
              { type: 'thinking', text: '', replay: 'opaque', provider: 'anthropic', redacted: true },
              { type: 'thinking', text: 'from elsewhere', replay: { type: 'reasoning' }, provider: 'openai' },
              { type: 'thinking', text: 'unsigned', provider: 'anthropic' },
              { type: 'text', text: 'Checking.' },
              { type: 'tool_call', id: 'toolu_01', name: 'read_file', input: { path: 'src/a.ts' } },
            ]),
            message('tool', [
              { type: 'tool_result', callId: 'toolu_01', content: [{ type: 'text', text: 'export {}' }] },
            ]),
            message('user', [
              { type: 'context', text: '<context-update>cwd changed</context-update>' },
              { type: 'image', mime: 'image/png', blob: 'png' },
            ]),
          ],
        }),
      ),
    );
    const messages = (calls[1]!.body as { messages: { role: string; content: Record<string, unknown>[] }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1]!.content).toEqual([
      { type: 'thinking', thinking: 'Need the file.', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'src/a.ts' } },
    ]);
    const last = messages[2]!.content;
    expect(last.map((b) => b.type)).toEqual(['tool_result', 'text', 'image']);
    expect(last[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: [{ type: 'text', text: 'export {}' }],
    });
    expect(last[2]).toMatchObject({ source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } });
  });

  it('places at most 4 cache breakpoints: the cached system blocks, previous user turn and final block', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/messages': () => streamResponse(THINKING_STREAM) });
    await collect(
      createAnthropicAdapter(instance, deps(fetch)).stream(
        chatRequest({
          model: 'claude-opus-5-5',
          tools: TOOLS,
          system: [{ text: 'identity', cache: true }, { text: 'env', cache: true }, { text: 'volatile' }],
          messages: [
            userText('one'),
            message('assistant', [{ type: 'text', text: 'two' }]),
            userText('three'),
            message('assistant', [
              { type: 'text', text: 'four' },
              { type: 'tool_call', id: 't1', name: 'list_dir', input: {} },
            ]),
            message('tool', [{ type: 'tool_result', callId: 't1', content: [{ type: 'text', text: 'a b c' }] }]),
          ],
        }),
      ),
    );
    const body = calls[0]!.body as {
      tools: Record<string, unknown>[];
      system: Record<string, unknown>[];
      messages: { content: Record<string, unknown>[] }[];
    };
    expect(cacheControlCount(body)).toBe(4);
    // The system breakpoints cover the tools, which come first in the cache prefix.
    expect(body.tools.some((t) => 'cache_control' in t)).toBe(false);
    expect(body.system.map((b) => 'cache_control' in b)).toEqual([true, true, false]);
    expect(body.messages[2]!.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[4]!.content.at(-1)).toMatchObject({
      type: 'tool_result',
      cache_control: { type: 'ephemeral' },
    });
    expect(body.messages[0]!.content[0]).not.toHaveProperty('cache_control');
  });

  it('never marks thinking blocks and stays within 4 breakpoints for short histories', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/messages': () => streamResponse(THINKING_STREAM) });
    await collect(
      createAnthropicAdapter(instance, deps(fetch)).stream(
        chatRequest({ model: 'claude-opus-5-5', system: [{ text: 'sys', cache: true }], messages: [userText('hi')] }),
      ),
    );
    expect(cacheControlCount(calls[0]!.body)).toBe(2);
  });

  it('sends PDFs as base64 document blocks', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/messages': () => streamResponse(THINKING_STREAM) });
    await collect(
      createAnthropicAdapter(instance, deps(fetch)).stream(
        chatRequest({
          messages: [
            message('user', [
              { type: 'document', mime: 'application/pdf', blob: 'pdf', name: 'spec.pdf' },
              { type: 'text', text: 'Summarize' },
            ]),
          ],
        }),
      ),
    );
    const [doc] = (calls[0]!.body as { messages: { content: Record<string, unknown>[] }[] }).messages[0]!.content;
    expect(doc).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjc=' },
      title: 'spec.pdf',
    });
  });

  it('maps stream error events and HTTP errors', async () => {
    const overloaded = sse([
      messageStart({ input_tokens: 1, output_tokens: 1 }),
      ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ]);
    const busy = fakeFetch({ 'POST /v1/messages': () => streamResponse(overloaded) });
    const busyFinish = finishOf(
      await collect(createAnthropicAdapter(instance, deps(busy.fetch)).stream(chatRequest())),
    );
    expect(busyFinish).toMatchObject({
      reason: 'error',
      error: { code: 'provider_busy', retryable: true },
    });
    expect(busyFinish.error).not.toHaveProperty('fix');

    const auth = fakeFetch({
      'POST /v1/messages': () =>
        jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
    });
    const authFinish = finishOf(
      await collect(createAnthropicAdapter(instance, deps(auth.fetch)).stream(chatRequest())),
    );
    expect(authFinish).toMatchObject({ reason: 'error', error: { code: 'provider_auth', retryable: false } });
    expect(JSON.stringify(authFinish)).not.toContain(API_KEY);

    const missing = fakeFetch({
      'POST /v1/messages': () =>
        jsonResponse({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } }, 404),
    });
    const missingFinish = finishOf(
      await collect(createAnthropicAdapter(instance, deps(missing.fetch)).stream(chatRequest())),
    );
    expect(missingFinish).toMatchObject({ error: { code: 'model_not_found', fix: 'settings/models' } });

    const overflow = fakeFetch({
      'POST /v1/messages': () =>
        jsonResponse(
          {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'prompt is too long: 1200000 tokens > 1000000 maximum' },
          },
          400,
        ),
    });
    const overflowFinish = finishOf(
      await collect(createAnthropicAdapter(instance, deps(overflow.fetch)).stream(chatRequest())),
    );
    expect(overflowFinish.error!.code).toBe('context_overflow');
  });

  it('finishes with aborted when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch } = fakeFetch({ 'POST /v1/messages': () => streamResponse(THINKING_STREAM) });
    const events = await collect(
      createAnthropicAdapter(instance, deps(fetch)).stream(chatRequest({ signal: controller.signal })),
    );
    expect(events).toEqual([{ type: 'finish', reason: 'aborted' }]);
  });

  it('lists models from metadata, falling back to the catalog, and uses discovered effort levels', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/models?limit=1000': () =>
        jsonResponse({
          data: [
            {
              id: 'claude-opus-5-5',
              display_name: 'Claude Opus 5.5',
              type: 'model',
              max_input_tokens: 1_000_000,
              max_tokens: 128_000,
              capabilities: {
                image_input: { supported: true },
                pdf_input: { supported: true },
                thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
                effort: {
                  supported: true,
                  low: { supported: true },
                  medium: { supported: true },
                  high: { supported: true },
                },
              },
            },
            { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', type: 'model' },
            { id: 'claude-haiku-5-5', type: 'model' },
          ],
          has_more: false,
        }),
      'POST /v1/messages': () => streamResponse(THINKING_STREAM),
    });
    const adapter = createAnthropicAdapter(instance, deps(fetch));
    const models = await adapter.listModels();
    expect(models[0]).toMatchObject({
      ref: 'anthropic-1/claude-opus-5-5',
      contextLength: 1_000_000,
      maxOutput: 128_000,
      capabilities: { tools: 'native', vision: true, pdf: true, reasoning: 'effort', caching: true },
      effortLevels: ['low', 'medium', 'high'],
      recommendedEffort: { code: 'medium', chat: 'medium', work: 'medium' },
      tier: 'full',
      source: 'detected',
    });
    // Thinking budgets: every level, Extra and Max included.
    expect(models[1]).toMatchObject({
      contextLength: 200_000,
      capabilities: { reasoning: 'budget' },
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'catalog',
    });
    expect(models[1]).not.toHaveProperty('recommendedEffort');
    expect(models[2]).toMatchObject({
      contextLength: 1_000_000,
      maxOutput: 128_000,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'catalog',
    });

    // The discovered levels clamp a requested effort the model does not accept.
    await collect(adapter.stream(chatRequest({ model: 'claude-opus-5-5', effort: 'max' })));
    expect(calls.at(-1)!.body).toMatchObject({ output_config: { effort: 'high' } });
    await collect(adapter.stream(chatRequest({ model: 'claude-opus-5-5', effort: 'ultracode' })));
    expect(calls.at(-1)!.body).toMatchObject({ output_config: { effort: 'high' } });
  });

  it('counts tokens with count_tokens using only prompt fields', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/messages/count_tokens': () => jsonResponse({ input_tokens: 321 }) });
    const count = await createAnthropicAdapter(instance, deps(fetch)).countTokens!(
      chatRequest({ model: 'claude-opus-5-5', tools: TOOLS, temperature: 1 }),
    );
    expect(count).toBe(321);
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual(['messages', 'model', 'system', 'tools']);
  });

  it('checks health with a one-model listing', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /v1/models?limit=1': () => jsonResponse({ data: [] }) });
    expect(await createAnthropicAdapter(instance, deps(fetch)).health()).toMatchObject({ ok: true });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1');
  });
});
