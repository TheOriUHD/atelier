import { describe, expect, it } from 'vitest';
import { FAL_MODELS, lookUp } from '../catalog.ts';
import { deps, events, fakeFetch, finishOf, imagesOf, INPUT, instance, jsonResponse, KEY, PNG_B64, request, stopped } from './__fixtures__/images.ts';
import { createFal } from './fal.ts';

const BASE = 'https://queue.fal.run';
const REQUEST = `${BASE}/fal-ai/flux/requests/abc`;
const SUBMITTED = { request_id: 'abc', response_url: REQUEST, status_url: `${REQUEST}/status`, cancel_url: `${REQUEST}/cancel`, queue_position: 3 };
const SUBMIT = 'POST /fal-ai/flux/schnell';
const STATUS = 'GET /fal-ai/flux/requests/abc/status';
const RESULT = 'GET /fal-ai/flux/requests/abc';
const RESULT_BODY = { images: [{ url: 'https://v3.fal.media/files/a.png', width: 1024, height: 1024, content_type: 'image/png' }], seed: 5, has_nsfw_concepts: [false], prompt: 'a red lighthouse' };
const caps = lookUp(FAL_MODELS, 'fal-ai/flux/schnell');
const adapter = (fetch: Parameters<typeof deps>[0], models: string[] = []) => createFal(instance('fal', BASE, { models }), deps(fetch), { pollMs: 0 });
const generate = (over = {}) => request({ model: 'fal-ai/flux/schnell', capabilities: caps, width: 1024, height: 768, ...over });
const statuses = (...answers: unknown[]) => {
  let at = 0;
  return () => jsonResponse(answers[Math.min(at++, answers.length - 1)]);
};

describe('fal.ai', () => {
  it('submits with its key scheme, follows the queue and fetches the result by the app’s path', async () => {
    const { fetch, calls } = fakeFetch({ [SUBMIT]: () => jsonResponse(SUBMITTED), [STATUS]: statuses({ status: 'IN_QUEUE', queue_position: 2 }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED', metrics: { inference_time: 1 } }), [RESULT]: () => jsonResponse(RESULT_BODY) });
    const out = await events(adapter(fetch).generate(generate({ count: 2, seed: 5 })));
    expect(calls[0]?.headers.authorization).toBe(`Key ${KEY}`);
    expect(calls[0]?.body).toEqual({ prompt: 'a red lighthouse', image_size: { width: 1024, height: 768 }, num_images: 2, seed: 5, output_format: 'png' });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/fal-ai/flux/schnell', '/fal-ai/flux/requests/abc/status', '/fal-ai/flux/requests/abc/status', '/fal-ai/flux/requests/abc/status', '/fal-ai/flux/requests/abc']);
    expect(out).toContainEqual({ type: 'loading', ahead: 2 });
    expect(out).toContainEqual({ type: 'progress' });
    expect(imagesOf(out)).toEqual([{ type: 'image', url: 'https://v3.fal.media/files/a.png', seed: 5 }]);
    expect(finishOf(out).reason).toBe('done');
  });

  it('sends input images as data URLs to an edit model, and reads a data URL back as bytes', async () => {
    const body = { images: [{ url: `data:image/png;base64,${PNG_B64}` }] };
    const { fetch, calls } = fakeFetch({ 'POST /fal-ai/flux-2/edit': () => jsonResponse({ ...SUBMITTED }), [STATUS]: statuses({ status: 'COMPLETED' }), [RESULT]: () => jsonResponse(body) });
    const out = await events(adapter(fetch).generate(generate({ model: 'fal-ai/flux-2/edit', capabilities: lookUp(FAL_MODELS, 'fal-ai/flux-2/edit'), references: [INPUT] })));
    expect(calls[0]?.body).toMatchObject({ image_urls: [`data:image/png;base64,${PNG_B64}`] });
    expect(imagesOf(out)[0]?.bytes).toBeDefined();
  });

  it('turns a content policy 422 into a refusal', async () => {
    const body = { detail: [{ loc: ['body', 'prompt'], msg: 'The content could not be processed because it was flagged.', type: 'content_policy_violation', ctx: { categories: ['violence'] } }] };
    const atSubmit = fakeFetch({ [SUBMIT]: () => jsonResponse(body, 422) });
    expect(finishOf(await events(adapter(atSubmit.fetch).generate(generate())))).toMatchObject({ reason: 'refused', error: { retryable: false } });
    const atResult = fakeFetch({ [SUBMIT]: () => jsonResponse(SUBMITTED), [STATUS]: statuses({ status: 'COMPLETED' }), [RESULT]: () => jsonResponse(body, 422) });
    expect(finishOf(await events(adapter(atResult.fetch).generate(generate()))).reason).toBe('refused');
  });

  it('treats images its checker blanked as refused', async () => {
    const all = fakeFetch({ [SUBMIT]: () => jsonResponse(SUBMITTED), [STATUS]: statuses({ status: 'COMPLETED' }), [RESULT]: () => jsonResponse({ ...RESULT_BODY, has_nsfw_concepts: [true] }) });
    expect(finishOf(await events(adapter(all.fetch).generate(generate()))).reason).toBe('refused');
    const some = { images: [{ url: 'https://v3.fal.media/a.png' }, { url: 'https://v3.fal.media/b.png' }], has_nsfw_concepts: [true, false] };
    const partly = fakeFetch({ [SUBMIT]: () => jsonResponse(SUBMITTED), [STATUS]: statuses({ status: 'COMPLETED' }), [RESULT]: () => jsonResponse(some) });
    const out = await events(adapter(partly.fetch).generate(generate()));
    expect(imagesOf(out).map((e) => e.url)).toEqual(['https://v3.fal.media/b.png']);
    expect(finishOf(out).reason).toBe('done');
  });

  it('reads a failed run from its status', async () => {
    const timedOut = fakeFetch({ [SUBMIT]: () => jsonResponse(SUBMITTED), [STATUS]: statuses({ status: 'COMPLETED', error: 'The runner took too long', error_type: 'runner_connection_timeout' }) });
    expect(finishOf(await events(adapter(timedOut.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { retryable: true } });
    const bad = fakeFetch({ [SUBMIT]: () => jsonResponse(SUBMITTED), [STATUS]: statuses({ status: 'COMPLETED', error: 'Bad input', error_type: 'bad_request' }) });
    expect(finishOf(await events(adapter(bad.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { retryable: false } });
  });

  it('keeps 429 and 503 retryable, and rides out a poll that fails for a moment', async () => {
    const limited = fakeFetch({ [SUBMIT]: () => jsonResponse({ detail: 'Too many requests' }, 429) });
    expect(finishOf(await events(adapter(limited.fetch).generate(generate())))).toMatchObject({ error: { retryable: true } });
    let polls = 0;
    const flaky = fakeFetch({ [SUBMIT]: () => jsonResponse(SUBMITTED), [STATUS]: () => (++polls < 3 ? new Response('busy', { status: 503 }) : jsonResponse({ status: 'COMPLETED' })), [RESULT]: () => jsonResponse(RESULT_BODY) });
    expect(finishOf(await events(adapter(flaky.fetch).generate(generate()))).reason).toBe('done');
  });

  it('cancels the job on stop', async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch({
      [SUBMIT]: () => jsonResponse(SUBMITTED),
      [STATUS]: () => {
        controller.abort();
        return jsonResponse({ status: 'IN_PROGRESS' });
      },
      'PUT /fal-ai/flux/requests/abc/cancel': () => jsonResponse({ status: 'CANCELLATION_REQUESTED' }, 202),
    });
    const out = await events(adapter(fetch).generate(generate({ signal: controller.signal })));
    expect(finishOf(out).reason).toBe('aborted');
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: `${REQUEST}/cancel`, headers: { authorization: `Key ${KEY}` } });
  });

  it('stops before it starts, and won’t send the key elsewhere', async () => {
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(generate({ signal: stopped() })))).reason).toBe('aborted');
    const { fetch, calls } = fakeFetch({ [SUBMIT]: () => jsonResponse({ ...SUBMITTED, status_url: 'https://evil.example.com/status' }) });
    expect(finishOf(await events(adapter(fetch).generate(generate()))).reason).toBe('error');
    expect(calls).toHaveLength(1);
  });

  it('reports an answer it cannot use', async () => {
    const empty = fakeFetch({ [SUBMIT]: () => jsonResponse({}) });
    expect(finishOf(await events(adapter(empty.fetch).generate(generate()))).reason).toBe('error');
    const noImages = fakeFetch({ [SUBMIT]: () => jsonResponse(SUBMITTED), [STATUS]: statuses({ status: 'COMPLETED' }), [RESULT]: () => jsonResponse({ images: [] }) });
    expect(finishOf(await events(adapter(noImages.fetch).generate(generate()))).reason).toBe('error');
    const weird = fakeFetch({ [SUBMIT]: () => jsonResponse(SUBMITTED), [STATUS]: statuses({ status: 'NONSENSE' }) });
    expect(finishOf(await events(adapter(weird.fetch).generate(generate()))).reason).toBe('error');
  });

  it('lists what was typed in and what its search finds', async () => {
    const found = { models: [{ endpoint_id: 'fal-ai/flux/schnell', metadata: { display_name: 'FLUX.1 [schnell]', category: 'text-to-image', status: 'active' } }, { endpoint_id: 'fal-ai/nano-banana-pro', metadata: { display_name: 'Nano Banana Pro' } }], next_cursor: 'x', has_more: true };
    const { fetch, calls } = fakeFetch({ 'GET /v1/models': () => jsonResponse(found) });
    const models = await adapter(fetch, ['fal-ai/flux/schnell']).listModels();
    expect(new URL(calls[0]!.url).host).toBe('api.fal.ai');
    expect(calls[0]?.url).toContain('category=text-to-image');
    expect(models.map((m) => [m.modelId, m.source])).toEqual([['fal-ai/flux/schnell', 'default'], ['fal-ai/nano-banana-pro', 'detected']]);
    expect(models[1]?.displayName).toBe('Nano Banana Pro');
  });

  it('still lists what was typed in when the search fails', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/models': () => jsonResponse({}, 500) });
    expect((await adapter(fetch, ['fal-ai/flux/schnell']).listModels()).map((m) => m.modelId)).toEqual(['fal-ai/flux/schnell']);
  });
});
