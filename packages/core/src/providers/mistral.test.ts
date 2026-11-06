import { describe, expect, it } from 'vitest';
import { listPrice } from './prices.ts';
import { createAdapter } from './index.ts';
import { mistralModel, uniqueModels, vibeBudget } from './mistral.ts';
import type { ChatRequest } from './types.ts';
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

const BASE = 'https://api.mistral.ai';
/** Mistral's stream: data-only events, ending in `[DONE]` when `done`. */
const sseOf = (chunks: unknown[], done = false) => sse(chunks.map((data) => ({ data })), done);
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: null, ...extra }],
});
const last = (delta: Record<string, unknown>, finish: string, usage: Record<string, unknown>) => ({ ...chunk(delta, { finish_reason: finish }), usage });

/** `/v1/models` as Mistral answers it: a card for every name, retired and non-chat models among them. */
const card = (id: string, extra: Record<string, unknown> = {}, caps: Record<string, unknown> = {}) => ({
  id,
  object: 'model',
  owned_by: 'mistralai',
  name: id,
  aliases: [],
  max_context_length: 262_144,
  deprecation: null,
  type: 'base',
  capabilities: { completion_chat: true, function_calling: true, vision: true, ...caps },
  ...extra,
});
const MODELS = {
  object: 'list',
  data: [
    card('mistral-small-2603', { aliases: ['mistral-small-latest'] }),
    card('mistral-small-latest', { name: 'mistral-small-2603', aliases: ['mistral-small-2603'] }),
    card('mistral-large-4', { max_context_length: 1_048_576, aliases: ['mistral-large-4-0'] }, { reasoning: true }),
    card('codestral-2508', { max_context_length: 131_072 }, { vision: false, completion_fim: true }),
    card('mistral-embed-2312', {}, { completion_chat: false }),
    card('devstral-2512', { deprecation: '2026-07-31T00:00:00Z' }),
    card('mistral-future-9', {}, { reasoning: true }),
  ],
};

function setup(type: 'mistral' | 'mistral-vibe' = 'mistral', stream?: string | ((call: { body: unknown }) => Response)) {
  const routes: Parameters<typeof fakeFetch>[0] = {
    'GET /v1/models': () => jsonResponse(MODELS),
    'POST /v1/chat/completions': (call) => (typeof stream === 'function' ? stream(call) : streamResponse(stream ?? sseOf([last({ content: 'Hi' }, 'stop', { prompt_tokens: 3, completion_tokens: 1 })], true))),
  };
  const fake = fakeFetch(routes);
  const adapter = createAdapter(providerInstance(type, BASE, API_KEY), deps(fake.fetch));
  return { adapter, calls: fake.calls };
}

const sent = (calls: { url: string; body: unknown }[]) => calls.filter((c) => c.url.endsWith('/chat/completions')).at(-1)!.body as Record<string, unknown>;

describe('Mistral models', () => {
  it('lists each model once, under its own name, and leaves out retired and non-chat ones', async () => {
    const models = await setup().adapter.listModels();
    expect(models.map((m) => m.modelId)).toEqual(['mistral-small-2603', 'mistral-large-4', 'codestral-2508', 'mistral-future-9']);
  });

  it('knows names, windows, vision and how each model reasons', async () => {
    const byId = Object.fromEntries((await setup().adapter.listModels()).map((m) => [m.modelId, m]));
    expect(byId['mistral-small-2603']).toMatchObject({ displayName: 'Mistral Small 4', contextLength: 262_144, capabilities: { tools: 'native', vision: true, pdf: true, reasoning: 'toggle', caching: true } });
    expect(byId['mistral-large-4']).toMatchObject({ displayName: 'Mistral Large 4', contextLength: 1_048_576, effortLevels: ['low', 'medium', 'high'], capabilities: { reasoning: 'effort' } });
    expect(byId['codestral-2508']).toMatchObject({ displayName: 'Codestral', contextLength: 131_072, capabilities: { vision: false, pdf: false, reasoning: 'none' } });
    // A reasoning model Atelier doesn't know yet: `high`, which every Mistral reasoning model takes.
    expect(byId['mistral-future-9']).toMatchObject({ displayName: 'mistral-future-9', effortLevels: ['high'], capabilities: { reasoning: 'effort' } });
    expect(byId['mistral-large-4']!.tier).toBe('full');
  });

  it('keeps a model that is deprecated but still served', () => {
    const now = Date.parse('2026-11-06T00:00:00Z');
    const model = mistralModel(providerInstance('mistral', BASE), card('mistral-medium-3-5', { deprecation: '2027-04-30T00:00:00Z' }), now);
    expect(model?.displayName).toBe('Mistral Medium 3.5');
    expect(uniqueModels([card('a', { name: 'b' }), card('b')]).map((c) => (c as { id: string }).id)).toEqual(['b']);
  });
});

describe('Mistral requests', () => {
  it('sends only fields Mistral takes, with usage coming by itself', async () => {
    const { adapter, calls } = setup();
    await collect(adapter.stream(chatRequest({ model: 'codestral-2508', temperature: 1.9, queue: { owner: 'session-1' } })));
    const body = sent(calls);
    expect(body).toEqual({
      model: 'codestral-2508',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
      stream: true,
      max_tokens: 4096,
      temperature: 1.5,
      prompt_cache_key: 'session-1',
    });
    expect(calls.at(-1)!.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('turns thinking on and off on a switch model, and clamps levels on a leveled one', async () => {
    const { adapter, calls } = setup();
    await adapter.listModels();
    const effortFor = async (model: string, effort: ChatRequest['effort']) => {
      await collect(adapter.stream(chatRequest({ model, effort })));
      return sent(calls).reasoning_effort;
    };
    expect(await effortFor('mistral-small-2603', 'medium')).toBe('high');
    expect(await effortFor('mistral-small-2603', null)).toBe('none');
    // An alias reasons as its model does.
    expect(await effortFor('mistral-small-latest', 'low')).toBe('high');
    expect(await effortFor('mistral-large-4', 'low')).toBe('low');
    expect(await effortFor('mistral-large-4', 'max')).toBe('high');
    expect(await effortFor('mistral-large-4', 'ultracode')).toBe('high');
    expect(await effortFor('mistral-large-4', null)).toBeUndefined();
    expect(await effortFor('codestral-2508', 'high')).toBeUndefined();
  });

  it('sends tools, a forced tool and images and PDFs as Mistral takes them', async () => {
    const { adapter, calls } = setup();
    const tools = [{ name: 'Read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];
    await collect(
      adapter.stream(
        chatRequest({
          model: 'mistral-small-2603',
          tools,
          toolChoice: { name: 'Read' },
          messages: [
            message('user', [
              { type: 'text', text: 'Look' },
              { type: 'image', mime: 'image/png', blob: 'png' },
              { type: 'document', mime: 'application/pdf', blob: 'pdf', name: 'a.pdf' },
            ]),
          ],
        }),
      ),
    );
    const body = sent(calls);
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } });
    expect((body.messages as unknown[])[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image_url', image_url: 'data:image/png;base64,iVBORw==' },
        { type: 'document_url', document_url: 'data:application/pdf;base64,JVBERi0xLjc=', document_name: 'a.pdf' },
      ],
    });
  });

  it('maps call ids from other providers to nine letters on both sides, and sends thinking back', async () => {
    const { adapter, calls } = setup();
    const foreign = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    await collect(
      adapter.stream(
        chatRequest({
          model: 'mistral-small-2603',
          messages: [
            userText('Read it'),
            {
              ...message('assistant', [
                { type: 'thinking', text: 'I should read.', provider: 'mistral', replay: { signature: 'sig-1' } },
                { type: 'thinking', text: 'From another provider', provider: 'anthropic' },
                { type: 'text', text: 'Reading.' },
                { type: 'tool_call', id: foreign, name: 'Read', input: { path: 'a' } },
                { type: 'tool_call', id: 'gSIMJiOkT', name: 'Read', input: { path: 'b' } },
              ]),
            },
            message('user', [
              { type: 'tool_result', callId: foreign, content: [{ type: 'text', text: 'one' }, { type: 'image', mime: 'image/png', blob: 'png' }] },
              { type: 'tool_result', callId: 'gSIMJiOkT', content: [{ type: 'text', text: 'two' }], isError: true },
            ]),
            message('assistant', []),
          ],
        }),
      ),
    );
    const messages = sent(calls).messages as Record<string, unknown>[];
    const assistant = messages[2]!;
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: [{ type: 'text', text: 'I should read.' }], signature: 'sig-1' },
      { type: 'text', text: 'Reading.' },
    ]);
    const ids = (assistant.tool_calls as { id: string }[]).map((c) => c.id);
    expect(ids[0]).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(ids[1]).toBe('gSIMJiOkT');
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: ids[0], name: 'Read', content: 'one' });
    expect(messages[4]).toEqual({ role: 'tool', tool_call_id: 'gSIMJiOkT', name: 'Read', content: 'Error: two' });
    // The tool's image follows as the person's, and the empty reply at the end is left out.
    expect(messages[5]).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'image_url' }] });
    expect(messages).toHaveLength(6);
  });
});

describe('Mistral replies', () => {
  it('streams text and reads usage from the last chunk, cached tokens included', async () => {
    const { adapter } = setup('mistral', sseOf([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hel' }), last({ content: 'lo' }, 'stop', { prompt_tokens: 200, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 128 } })], true));
    const events = await collect(adapter.stream(chatRequest()));
    expect(textOf(events)).toBe('Hello');
    expect(usageOf(events)).toEqual({ input: 72, output: 2, cacheRead: 128 });
    expect(finishOf(events).reason).toBe('end');
  });

  it('reads cached tokens where an older reply puts them', async () => {
    const { adapter } = setup('mistral', sseOf([last({ content: 'x' }, 'stop', { prompt_tokens: 100, completion_tokens: 1, num_cached_tokens: 64, completion_tokens_details: { reasoning_tokens: 7 } })]));
    expect(usageOf(await collect(adapter.stream(chatRequest())))).toEqual({ input: 36, output: 1, cacheRead: 64, reasoning: 7 });
  });

  it('streams thinking chunks, then the answer, and keeps the signature to send back', async () => {
    const { adapter } = setup(
      'mistral',
      sseOf(
        [
          chunk({ role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Two and ' }] }] }),
          chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'two.' }], signature: 'sig-9' }, { type: 'text', text: '2 + 2' }] }),
          chunk({ content: [{ type: 'text', text: ' = 4' }] }),
          last({ content: '' }, 'stop', { prompt_tokens: 10, completion_tokens: 46 }),
        ],
        true,
      ),
    );
    const events = await collect(adapter.stream(chatRequest({ model: 'mistral-small-2603', effort: 'high' })));
    expect(thinkingOf(events)).toBe('Two and two.');
    expect(textOf(events)).toBe('2 + 2 = 4');
    expect(events).toContainEqual({ type: 'thinking_replay', data: { signature: 'sig-9' } });
  });

  it('takes a tool call sent whole in one chunk, as Mistral’s own models send them', async () => {
    const { adapter } = setup('mistral', sseOf([chunk({ role: 'assistant', content: '' }), last({ content: null, tool_calls: [{ id: 'gSIMJiOkT', function: { name: 'weather', arguments: '{"location": "Paris"}' } }] }, 'tool_calls', { prompt_tokens: 124, completion_tokens: 22 })], true));
    const events = await collect(adapter.stream(chatRequest()));
    expect(events.filter((e) => e.type.startsWith('tool_call'))).toEqual([
      { type: 'tool_call_start', id: 'gSIMJiOkT', name: 'weather' },
      { type: 'tool_call_delta', id: 'gSIMJiOkT', json: '{"location": "Paris"}' },
      { type: 'tool_call_end', id: 'gSIMJiOkT', input: { location: 'Paris' } },
    ]);
    expect(finishOf(events).reason).toBe('tool_use');
  });

  it('takes tool calls streamed in pieces by index, as the models it hosts for others send them', async () => {
    const { adapter } = setup(
      'mistral',
      sseOf([
        chunk({ tool_calls: [{ id: 'chatcmpl-tool-9f14', type: 'function', function: { name: 'search', arguments: '' }, index: 0 }], content: '' }),
        chunk({ tool_calls: [{ type: 'function', function: { name: '', arguments: '{"query": ' }, index: 0 }], content: '' }),
        chunk({ tool_calls: [{ type: 'function', function: { name: '', arguments: '"berlin"}' }, index: 0 }], content: '' }),
        last({ content: '' }, 'tool_calls', { prompt_tokens: 171, completion_tokens: 14 }),
      ]),
    );
    const events = await collect(adapter.stream(chatRequest({ model: 'zai-glm-5-3' })));
    expect(events.find((e) => e.type === 'tool_call_end')).toEqual({ type: 'tool_call_end', id: 'chatcmpl-tool-9f14', input: { query: 'berlin' } });
  });

  it('says the reply was cut off at the model’s length', async () => {
    const { adapter } = setup('mistral', sseOf([last({ content: 'partial' }, 'model_length', { prompt_tokens: 1, completion_tokens: 1 })]));
    expect(finishOf(await collect(adapter.stream(chatRequest()))).reason).toBe('max_tokens');
  });
});

describe('Mistral errors', () => {
  const failing = (status: number, body: unknown, type: 'mistral' | 'mistral-vibe' = 'mistral') => setup(type, () => jsonResponse(body, status)).adapter;

  it('says which field a 422 refused', async () => {
    const adapter = failing(422, { object: 'error', message: { detail: [{ type: 'extra_forbidden', loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted' }] }, type: 'invalid_request_error', code: null });
    const error = finishOf(await collect(adapter.stream(chatRequest()))).error!;
    expect(error.message).toContain('body.stream_options: Extra inputs are not permitted');
  });

  it('tells a conversation that is too long', async () => {
    const adapter = failing(400, { object: 'error', message: 'Prompt contains 321774 tokens and 0 draft tokens, too large for model with 262144 maximum context length', type: 'invalid_request_invalid_args', code: '3051' });
    expect(finishOf(await collect(adapter.stream(chatRequest()))).error!.code).toBe('context_overflow');
  });

  it('tells a wrong key, and a Vibe plan past its allowance', async () => {
    expect(finishOf(await collect(failing(401, { detail: 'Invalid API Key' }).stream(chatRequest()))).error!.code).toBe('provider_auth');
    const error = finishOf(await collect(failing(402, { object: 'error', message: 'Payment required', type: 'payment_required' }, 'mistral-vibe').stream(chatRequest()))).error!;
    expect(error.code).toBe('provider_quota');
    expect(error.message).toContain('Vibe allowance starts again');
    expect(error.message).not.toContain(API_KEY);
  });
});

describe('Mistral Vibe', () => {
  it('reads the plan’s allowance from Mistral’s billing API', async () => {
    const { fetch } = fakeFetch({
      'GET /v1/billing/budget': () => jsonResponse({ vibe_budget: { usage_percentage: 42.5, initial_budget: 15, reset_at: '2026-12-01T00:00:00Z', payg_enabled: false } }),
      'GET /v1/billing/subscription': () => jsonResponse({ plan_name: 'Le Chat Pro', vibe_payg_enabled: false }),
    });
    expect(await vibeBudget(providerInstance('mistral-vibe', BASE, API_KEY), deps(fetch))).toEqual({ usedPercent: 42.5, resetsAt: Date.parse('2026-12-01T00:00:00Z'), plan: 'Le Chat Pro' });
  });

  it('has no reading where the key may not see it, and only a Vibe provider asks', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/billing/budget': () => jsonResponse({ detail: 'Forbidden' }, 403) });
    expect(await vibeBudget(providerInstance('mistral-vibe', BASE, API_KEY), deps(fetch))).toBeNull();
    expect(setup('mistral').adapter.planUsage).toBeUndefined();
    expect(setup('mistral-vibe').adapter.planUsage).toBeTypeOf('function');
  });

  it('has list prices for a console key, and none for a Vibe key', () => {
    expect(listPrice('mistral', 'mistral-large-4-0')).toEqual({ input: 0.7, output: 2.1, cacheRead: 0.07 });
    expect(listPrice('mistral', 'mistral-small-latest')).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.015 });
    expect(listPrice('mistral', 'deepseek-v4-1-flash-1017')?.input).toBe(0.3);
    expect(listPrice('mistral', 'unknown-model')).toBeNull();
    expect(listPrice('mistral-vibe', 'mistral-large-4')).toBeNull();
  });
});
