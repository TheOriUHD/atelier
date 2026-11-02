import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sse, streamResponse } from '../../providers/__fixtures__/harness.ts';
import { resetCodexClientVersion } from '../../providers/chatgpt.ts';
import { ChatGptSignedOut } from '../../providers/chatgpt-auth.ts';
import type { ChatGptPort } from '../../providers/types.ts';
import { deps, events, fakeFetch, finishOf, imagesOf, INPUT, instance, jsonResponse, PNG_B64, request, stopped } from './__fixtures__/images.ts';
import { createResponsesImage } from './responses-image.ts';

const ROUTE = 'POST /backend-api/codex/responses';
const MODELS = { 'GET /backend-api/codex/models': () => jsonResponse({ models: [{ slug: 'gpt-5.6-terra', visibility: 'list', priority: 2 }, { slug: 'hidden', visibility: 'hide', priority: 0 }, { slug: 'gpt-5.6-sol', visibility: 'list', priority: 1 }] }) };
const auth = (): ChatGptPort => ({ credentials: async () => ({ accessToken: 'access', accountId: 'account', installationId: 'install' }), observe: vi.fn() });
const adapter = (fetch: Parameters<typeof deps>[0], port: ChatGptPort | undefined = auth()) => createResponsesImage(instance('responses-image', 'https://chatgpt.com/backend-api/codex', { preset: 'chatgpt', name: 'ChatGPT Plan' }), { ...deps(fetch), ...(port ? { chatgpt: port } : {}) });

const completed = { type: 'response.output_item.done', item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', revised_prompt: 'A red lighthouse at dawn', result: PNG_B64 } };

describe('ChatGPT Plan images', () => {
  beforeEach(resetCodexClientVersion);
  afterEach(resetCodexClientVersion);
  it('sends the image_generation tool through the Codex path, with the account’s text model', async () => {
    const stream = sse([
      { event: 'response.image_generation_call.generating', data: { type: 'response.image_generation_call.generating' } },
      { event: 'response.image_generation_call.partial_image', data: { type: 'response.image_generation_call.partial_image', partial_image_b64: PNG_B64, partial_image_index: 0 } },
      { event: 'response.output_item.done', data: completed },
      { event: 'response.completed', data: { type: 'response.completed', response: { usage: { total_tokens: 10 } } } },
    ]);
    const { fetch, calls } = fakeFetch({ ...MODELS, 'GET /@openai/codex/latest': () => jsonResponse({ version: '1.0.0' }), [ROUTE]: () => streamResponse(stream) });
    const out = await events(adapter(fetch).generate(request({ model: 'chatgpt-plan-image', width: 1536, height: 1024, quality: 'draft', transparent: true, references: [INPUT] })));
    const call = calls.find((c) => c.url.endsWith('/responses'));
    expect(call?.headers).toMatchObject({ authorization: 'Bearer access', 'chatgpt-account-id': 'account', accept: 'text/event-stream', originator: 'atelier' });
    expect(call?.body).toMatchObject({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'a red lighthouse' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}` }] }],
      tools: [{ type: 'image_generation', output_format: 'png', partial_images: 2, quality: 'low', size: '1536x1024', background: 'transparent' }],
      tool_choice: { type: 'image_generation' },
      stream: true,
      store: false,
    });
    expect(out.map((e) => e.type)).toEqual(['progress', 'preview', 'image', 'finish']);
    expect(imagesOf(out)[0]?.revisedPrompt).toBe('A red lighthouse at dawn');
  });

  it('falls back on a known text model when the account list can’t be read', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /@openai/codex/latest': () => jsonResponse({ version: '1.0.0' }), [ROUTE]: () => streamResponse(sse([{ data: completed }])) });
    await events(adapter(fetch).generate(request()));
    expect(calls.find((c) => c.url.endsWith('/responses'))?.body).toMatchObject({ model: 'gpt-5.5' });
  });

  it('says plainly when the backend turns the route down', async () => {
    const { fetch } = fakeFetch({ ...MODELS, [ROUTE]: () => jsonResponse({ error: { message: "Tool 'image_generation' is not supported with this model", code: 'unsupported_tool' } }, 400) });
    const finish = finishOf(await events(adapter(fetch).generate(request())));
    expect(finish).toMatchObject({ reason: 'error', error: { retryable: false } });
    expect(finish.error?.message).toContain("didn't accept this image request (400)");
  });

  it('reads a failed response for moderation as a refusal', async () => {
    const failed = { type: 'response.failed', response: { error: { code: 'moderation_blocked', message: 'Your request was rejected.' } } };
    const { fetch } = fakeFetch({ ...MODELS, [ROUTE]: () => streamResponse(sse([{ data: failed }])) });
    expect(finishOf(await events(adapter(fetch).generate(request())))).toMatchObject({ reason: 'refused' });
  });

  it('reads a 400 for moderation as a refusal', async () => {
    const { fetch } = fakeFetch({ ...MODELS, [ROUTE]: () => jsonResponse({ error: { code: 'moderation_blocked', message: 'Rejected by the safety system.' } }, 400) });
    expect(finishOf(await events(adapter(fetch).generate(request()))).reason).toBe('refused');
  });

  it('keeps rate limits retryable, and a used-up plan final', async () => {
    const limited = fakeFetch({ ...MODELS, [ROUTE]: () => jsonResponse({ error: { message: 'Slow down' } }, 429) });
    expect(finishOf(await events(adapter(limited.fetch).generate(request())))).toMatchObject({ error: { retryable: true } });
    const spent = fakeFetch({ ...MODELS, [ROUTE]: () => jsonResponse({ error: { code: 'usage_limit_reached', message: 'The usage limit has been reached' } }, 429) });
    expect(finishOf(await events(adapter(spent.fetch).generate(request())))).toMatchObject({ error: { code: 'provider_quota', retryable: false } });
  });

  it('says so when a reply comes back in words only', async () => {
    const { fetch } = fakeFetch({ ...MODELS, [ROUTE]: () => streamResponse(sse([{ data: { type: 'response.output_text.delta', delta: 'I made nothing.' } }])) });
    expect(finishOf(await events(adapter(fetch).generate(request())))).toMatchObject({ reason: 'error', error: { message: expect.stringContaining('I made nothing.') } });
  });

  it('stops when told to, and reports what it cannot read', async () => {
    const { fetch } = fakeFetch(MODELS);
    expect(finishOf(await events(adapter(fetch).generate(request({ signal: stopped() })))).reason).toBe('aborted');
    const broken = fakeFetch({ ...MODELS, [ROUTE]: () => streamResponse('data: {nope\n\n') });
    expect(finishOf(await events(adapter(broken.fetch).generate(request()))).reason).toBe('error');
  });

  it('offers one model with no price, and needs a sign-in', async () => {
    const { fetch } = fakeFetch({});
    const models = await adapter(fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['chatgpt-plan-image']);
    expect(models[0]?.capabilities).toMatchObject({ maxCount: 1, maxReferences: 5, mask: false, previews: true });
    const signedOut: ChatGptPort = { credentials: () => Promise.reject(new ChatGptSignedOut('Sign in to ChatGPT first.')), observe: vi.fn() };
    expect(await adapter(fetch, signedOut).health()).toMatchObject({ ok: false, error: 'Sign in to ChatGPT first.' });
    expect((await adapter(fetch).health()).ok).toBe(true);
  });

  it('explains itself on a backend with no ChatGPT sign-in', async () => {
    const service = createResponsesImage(instance('responses-image', 'https://chatgpt.com/backend-api/codex'), deps(fakeFetch({}).fetch));
    expect(await service.listModels()).toEqual([]);
    expect((await service.health()).ok).toBe(false);
    expect(finishOf(await events(service.generate(request())))).toMatchObject({ reason: 'error', error: { code: 'provider_auth' } });
  });
});
