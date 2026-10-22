import { describe, expect, it } from 'vitest';
import type { Effort } from '@atelier/protocol';
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
import { createOpenAIAdapter } from './openai.ts';

const instance = providerInstance('openai', 'https://api.openai.com', API_KEY);

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}): { event: string; data: unknown } => ({
  event: type,
  data: { type, sequence_number: seq++, ...data },
});

const REASONING_ITEM = {
  id: 'rs_1',
  type: 'reasoning',
  summary: [
    { type: 'summary_text', text: '**Plan** Greet back.' },
    { type: 'summary_text', text: 'Keep it short.' },
  ],
  encrypted_content: 'gAAAAABencrypted==',
};

const COMPLETED = (usage: Record<string, unknown>): { event: string; data: unknown } =>
  ev('response.completed', { response: { id: 'resp_1', status: 'completed', usage } });

const TEXT_STREAM = sse([
  ev('response.created', { response: { id: 'resp_1', status: 'in_progress' } }),
  ev('response.output_item.added', { output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }),
  ev('response.reasoning_summary_part.added', {
    item_id: 'rs_1',
    summary_index: 0,
    part: { type: 'summary_text', text: '' },
  }),
  ev('response.reasoning_summary_text.delta', { item_id: 'rs_1', summary_index: 0, delta: '**Plan** ' }),
  ev('response.reasoning_summary_text.delta', { item_id: 'rs_1', summary_index: 0, delta: 'Greet back.' }),
  ev('response.reasoning_summary_part.added', {
    item_id: 'rs_1',
    summary_index: 1,
    part: { type: 'summary_text', text: '' },
  }),
  ev('response.reasoning_summary_text.delta', { item_id: 'rs_1', summary_index: 1, delta: 'Keep it short.' }),
  ev('response.output_item.done', { output_index: 0, item: REASONING_ITEM }),
  ev('response.output_item.added', {
    output_index: 1,
    item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
  }),
  ev('response.content_part.added', {
    item_id: 'msg_1',
    output_index: 1,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  }),
  ev('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Hi' }),
  ev('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: ' there' }),
  ev('response.output_text.done', { item_id: 'msg_1', output_index: 1, content_index: 0, text: 'Hi there' }),
  COMPLETED({
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 30 },
    total_tokens: 150,
  }),
]);

const FUNCTION_ITEM = { id: 'fc_1', type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '' };
const TOOL_STREAM = sse([
  ev('response.output_item.added', { output_index: 0, item: { id: 'rs_2', type: 'reasoning', summary: [] } }),
  ev('response.output_item.done', { output_index: 0, item: { ...REASONING_ITEM, id: 'rs_2', summary: [] } }),
  ev('response.output_item.added', { output_index: 1, item: FUNCTION_ITEM }),
  ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 1, delta: '{"location":' }),
  ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 1, delta: '"Paris"}' }),
  ev('response.function_call_arguments.done', { item_id: 'fc_1', output_index: 1, arguments: '{"location":"Paris"}' }),
  ev('response.output_item.done', {
    output_index: 1,
    item: { ...FUNCTION_ITEM, arguments: '{"location":"Paris"}', status: 'completed' },
  }),
  COMPLETED({ input_tokens: 80, output_tokens: 20 }),
]);

const TOOLS = [
  {
    name: 'get_weather',
    description: 'Weather for a city',
    inputSchema: { type: 'object', properties: { location: { type: 'string' } } },
  },
];

describe('openai responses adapter', () => {
  it('streams text and reasoning summaries, captures the reasoning item and maps usage', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/responses': () => streamResponse(TEXT_STREAM, { chunkSize: 17 }) });
    const events = await collect(
      createOpenAIAdapter(instance, deps(fetch)).stream(
        chatRequest({ model: 'gpt-6-astra', effort: 'max', temperature: 0.3 }),
      ),
    );
    expect(thinkingOf(events)).toBe('**Plan** Greet back.\n\nKeep it short.');
    expect(textOf(events)).toBe('Hi there');
    expect(events.find((e) => e.type === 'thinking_replay')).toEqual({ type: 'thinking_replay', data: REASONING_ITEM });
    expect(usageOf(events)).toEqual({ input: 60, output: 50, cacheRead: 40, reasoning: 30 });
    expect(finishOf(events)).toEqual({ type: 'finish', reason: 'end' });

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]!.body).toEqual({
      model: 'gpt-6-astra',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      instructions: 'You are helpful.',
      stream: true,
      store: false,
      max_output_tokens: 4096,
      reasoning: { effort: 'xhigh', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    });
  });

  it('sends Max and Ultracode as xhigh, clamped to the levels a model has', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/responses': () => streamResponse(TEXT_STREAM) });
    const adapter = createOpenAIAdapter(instance, deps(fetch));
    const sent = async (model: string, effort: Effort) => {
      await collect(adapter.stream(chatRequest({ model, effort })));
      return (calls.at(-1)!.body as { reasoning: { effort: string } }).reasoning.effort;
    };
    expect(await sent('gpt-6-astra', 'ultracode')).toBe('xhigh');
    expect(await sent('gpt-6-astra', 'xhigh')).toBe('xhigh');
    expect(await sent('gpt-5', 'ultracode')).toBe('high');
    expect(await sent('gpt-5', 'medium')).toBe('medium');
  });

  it('round-trips a function call with reasoning replay and function_call_output', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v1/responses': () => streamResponse(calls.length === 1 ? TOOL_STREAM : TEXT_STREAM),
    });
    const adapter = createOpenAIAdapter(instance, deps(fetch));
    const events = await collect(adapter.stream(chatRequest({ model: 'gpt-6.1-sol', tools: TOOLS, effort: 'low' })));
    expect(events.filter((e) => e.type.startsWith('tool_call'))).toEqual([
      { type: 'tool_call_start', id: 'call_abc', name: 'get_weather' },
      { type: 'tool_call_delta', id: 'call_abc', json: '{"location":' },
      { type: 'tool_call_delta', id: 'call_abc', json: '"Paris"}' },
      { type: 'tool_call_end', id: 'call_abc', input: { location: 'Paris' } },
    ]);
    expect(finishOf(events).reason).toBe('tool_use');
    expect(calls[0]!.body).toMatchObject({
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Weather for a city',
          parameters: TOOLS[0]!.inputSchema,
          strict: false,
        },
      ],
      reasoning: { effort: 'low', summary: 'auto' },
    });
    expect(calls[0]!.body).not.toHaveProperty('tool_choice');

    const replay = events.find((e) => e.type === 'thinking_replay');
    await collect(
      adapter.stream(
        chatRequest({
          model: 'gpt-6.1-sol',
          tools: TOOLS,
          messages: [
            userText('Weather in Paris?'),
            message('assistant', [
              {
                type: 'thinking',
                text: '',
                replay: replay?.type === 'thinking_replay' ? replay.data : null,
                provider: 'openai',
              },
              { type: 'thinking', text: 'claude thoughts', replay: 'sig', provider: 'anthropic' },
              { type: 'tool_call', id: 'call_abc', name: 'get_weather', input: { location: 'Paris' } },
            ]),
            message('tool', [{ type: 'tool_result', callId: 'call_abc', content: [{ type: 'text', text: '18°C' }] }]),
          ],
        }),
      ),
    );
    expect((calls[1]!.body as { input: unknown[] }).input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] },
      { ...REASONING_ITEM, id: 'rs_2', summary: [] },
      { type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"location":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_abc', output: '18°C' },
    ]);
  });

  it('sends images, PDFs and image tool results as input items', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/responses': () => streamResponse(TEXT_STREAM) });
    await collect(
      createOpenAIAdapter(instance, deps(fetch)).stream(
        chatRequest({
          model: 'gpt-6-luna',
          messages: [
            message('user', [
              { type: 'text', text: 'Look' },
              { type: 'image', mime: 'image/png', blob: 'png' },
              { type: 'document', mime: 'application/pdf', blob: 'pdf', name: 'a.pdf' },
            ]),
            message('assistant', [
              { type: 'text', text: 'Sure.' },
              { type: 'tool_call', id: 'c1', name: 'screenshot', input: {} },
            ]),
            message('tool', [
              {
                type: 'tool_result',
                callId: 'c1',
                content: [{ type: 'image', mime: 'image/png', blob: 'png' }],
                isError: false,
              },
            ]),
          ],
        }),
      ),
    );
    expect((calls[0]!.body as { input: unknown[] }).input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Look' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw==' },
          { type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjc=' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sure.' }] },
      { type: 'function_call', call_id: 'c1', name: 'screenshot', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw==' }],
      },
    ]);
  });

  it('maps incomplete, failed and error events', async () => {
    const incomplete = fakeFetch({
      'POST /v1/responses': () =>
        streamResponse(
          sse([
            ev('response.output_text.delta', { delta: 'Long answ' }),
            ev('response.incomplete', {
              response: {
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                usage: { input_tokens: 5, output_tokens: 9 },
              },
            }),
          ]),
        ),
    });
    const cut = await collect(createOpenAIAdapter(instance, deps(incomplete.fetch)).stream(chatRequest()));
    expect(finishOf(cut).reason).toBe('max_tokens');
    expect(usageOf(cut)).toEqual({ input: 5, output: 9 });

    const failed = fakeFetch({
      'POST /v1/responses': () =>
        streamResponse(
          sse([
            ev('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: 'oops' } } }),
          ]),
        ),
    });
    const failedFinish = finishOf(
      await collect(createOpenAIAdapter(instance, deps(failed.fetch)).stream(chatRequest())),
    );
    expect(failedFinish).toMatchObject({ reason: 'error', error: { code: 'provider_busy', retryable: true } });

    const errored = fakeFetch({
      'POST /v1/responses': () =>
        streamResponse(sse([ev('error', { code: 'invalid_prompt', message: 'Bad prompt', param: null })])),
    });
    const errorFinish = finishOf(
      await collect(createOpenAIAdapter(instance, deps(errored.fetch)).stream(chatRequest())),
    );
    expect(errorFinish).toMatchObject({ reason: 'error', error: { code: 'provider_error', retryable: false } });
    expect(errorFinish.error!.message).toContain('Bad prompt');

    const http = fakeFetch({
      'POST /v1/responses': () =>
        jsonResponse(
          {
            error: {
              message: 'The model `gpt-9` does not exist',
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          },
          404,
        ),
    });
    const httpFinish = finishOf(await collect(createOpenAIAdapter(instance, deps(http.fetch)).stream(chatRequest())));
    expect(httpFinish).toMatchObject({ error: { code: 'model_not_found', fix: 'settings/models' } });
  });

  it.each([
    ['error', { error: { code: 'server_error', message: 'Nested outage' } }, 'provider_busy', true, 'Nested outage'],
    ['error', { error: { type: 'authentication_error', message: 'Invalid credentials' } }, 'provider_auth', false, 'Invalid credentials'],
    ['error', { error: { code: 'context_length_exceeded', message: 'Too long' } }, 'context_overflow', false, 'Too long'],
    ['error', { error: { code: 'model_not_found', message: 'Missing model' } }, 'model_not_found', false, 'Missing model'],
    ['error', { error: { message: 'Bad request', status: 400 } }, 'provider_error', false, 'Bad request'],
    ['error', { error: 'Temporary interruption' }, 'provider_error', true, 'Temporary interruption'],
    ['error', { message: 'error' }, 'provider_error', true, 'error'],
    ['error', {}, 'provider_error', true, 'response failed'],
    ['response.failed', { error: { code: 'server_error', message: 'Top-level outage' } }, 'provider_busy', true, 'Top-level outage'],
    ['response.failed', { response: { error: { type: 'authentication_error', message: 'Denied' } } }, 'provider_auth', false, 'Denied'],
    ['response.failed', { response: { error: 'Service interrupted' } }, 'provider_error', true, 'Service interrupted'],
  ] as const)('extracts %s payload %j accurately', async (type, data, code, retryable, detail) => {
    const { fetch } = fakeFetch({ 'POST /v1/responses': () => streamResponse(sse([ev(type, data)])) });
    const finish = finishOf(await collect(createOpenAIAdapter(instance, deps(fetch)).stream(chatRequest())));
    expect(finish).toMatchObject({ reason: 'error', error: { code, retryable } });
    expect(finish.error!.message).toContain(detail);
    if (retryable) expect(finish.error).not.toHaveProperty('fix');
  });

  it('omits reasoning parameters for unknown ids without effort and temperature for reasoning models', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/responses': () => streamResponse(TEXT_STREAM) });
    const adapter = createOpenAIAdapter(instance, deps(fetch));
    await collect(adapter.stream(chatRequest({ model: 'gpt-4o', temperature: 0.4 })));
    await collect(adapter.stream(chatRequest({ model: 'mystery-model' })));
    expect(calls[0]!.body).toMatchObject({ temperature: 0.4 });
    expect(calls[0]!.body).not.toHaveProperty('include');
    expect(calls[1]!.body).not.toHaveProperty('reasoning');
    expect(calls[1]!.body).not.toHaveProperty('include');
  });

  it('lists chat-capable models with catalog capabilities', async () => {
    const { fetch } = fakeFetch({
      'GET /v1/models': () =>
        jsonResponse({
          object: 'list',
          data: [
            'gpt-6-astra',
            'gpt-5.2-2025-12-11',
            'o3',
            'gpt-image-1',
            'text-embedding-3-large',
            'gpt-4o-realtime-preview',
            'whisper-1',
            'gpt-7-preview',
          ].map((id) => ({ id, object: 'model', owned_by: 'openai' })),
        }),
    });
    const models = await createOpenAIAdapter(instance, deps(fetch)).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['gpt-5.2-2025-12-11', 'gpt-6-astra', 'gpt-7-preview', 'o3']);
    expect(models.find((m) => m.modelId === 'gpt-6-astra')).toMatchObject({
      contextLength: 1_050_000,
      maxOutput: 128_000,
      capabilities: { tools: 'native', vision: true, reasoning: 'effort' },
      tier: 'full',
      source: 'catalog',
    });
    expect(models.find((m) => m.modelId === 'gpt-5.2-2025-12-11')).toMatchObject({
      source: 'catalog',
      contextLength: 400_000,
    });
    expect(models.find((m) => m.modelId === 'gpt-7-preview')).toMatchObject({
      source: 'default',
      capabilities: { vision: false, reasoning: 'none' },
    });
  });
});
