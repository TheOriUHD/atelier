import { describe, expect, it } from 'vitest';
import { ASPECT_DEFAULTS, lookUp, REPLICATE_MODELS } from '../catalog.ts';
import { deps, events, fakeFetch, finishOf, imagesOf, instance, jsonResponse, KEY, request, stopped } from './__fixtures__/images.ts';
import { createReplicate } from './replicate.ts';

const BASE = 'https://api.replicate.com';
const URLS = { get: `${BASE}/v1/predictions/p1`, cancel: `${BASE}/v1/predictions/p1/cancel` };
const prediction = (over: Record<string, unknown>) => ({ id: 'p1', model: 'black-forest-labs/flux-schnell', input: {}, logs: '', error: null, urls: URLS, ...over });
const caps = lookUp(REPLICATE_MODELS, 'black-forest-labs/flux-schnell', ASPECT_DEFAULTS);
const adapter = (fetch: Parameters<typeof deps>[0], models: string[] = []) => createReplicate(instance('replicate', BASE, { models }), deps(fetch), { pollMs: 0 });
const generate = (over = {}) => request({ model: 'black-forest-labs/flux-schnell', capabilities: caps, aspectRatio: '16:9', ...over });
const CREATE = 'POST /v1/predictions';
const GET = 'GET /v1/predictions/p1';

describe('Replicate', () => {
  it('waits for the answer, with a deadline, and reads a list of URLs', async () => {
    const { fetch, calls } = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'succeeded', output: ['https://replicate.delivery/a.png', 'https://replicate.delivery/b.png'] }), 201) });
    const out = await events(adapter(fetch).generate(generate({ count: 2, seed: 7, negativePrompt: 'fog' })));
    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, prefer: 'wait=60', 'cancel-after': '30m' });
    expect(calls[0]?.body).toEqual({ version: 'black-forest-labs/flux-schnell', input: { prompt: 'a red lighthouse', aspect_ratio: '16:9', num_outputs: 2, seed: 7, negative_prompt: 'fog', output_format: 'png' } });
    expect(imagesOf(out).map((e) => e.url)).toEqual(['https://replicate.delivery/a.png', 'https://replicate.delivery/b.png']);
    expect(finishOf(out).reason).toBe('done');
  });

  it('reads a single URL, and objects holding one', async () => {
    const single = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'succeeded', output: 'https://replicate.delivery/a.png' })) });
    expect(imagesOf(await events(adapter(single.fetch).generate(generate())))).toHaveLength(1);
    const objects = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'succeeded', output: [{ url: 'https://replicate.delivery/a.png' }] })) });
    expect(imagesOf(await events(adapter(objects.fetch).generate(generate())))).toHaveLength(1);
  });

  it('polls when the wait ran out, showing where it is', async () => {
    const answers = [prediction({ status: 'processing' }), prediction({ status: 'succeeded', output: ['https://replicate.delivery/a.png'] })];
    const { fetch, calls } = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'starting' }), 201), [GET]: () => jsonResponse(answers.shift()) });
    const out = await events(adapter(fetch).generate(generate()));
    expect(out.map((e) => e.type)).toEqual(['loading', 'progress', 'image', 'finish']);
    expect(calls[1]?.url).toBe(URLS.get);
  });

  it('reads a flagged prediction as a refusal', async () => {
    const { fetch } = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'failed', error: 'NSFW content detected. Try running it again, or try a different prompt.' })) });
    expect(finishOf(await events(adapter(fetch).generate(generate())))).toMatchObject({ reason: 'refused', error: { code: 'provider_refused', retryable: false } });
  });

  it('reads a sensitive-input 422 as a refusal', async () => {
    const { fetch } = fakeFetch({ [CREATE]: () => jsonResponse({ title: 'Invalid input', detail: 'The input was flagged as sensitive.', status: 422 }, 422) });
    expect(finishOf(await events(adapter(fetch).generate(generate()))).reason).toBe('refused');
  });

  it('lets a passing failure be tried again, and not a lasting one', async () => {
    const passing = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'failed', error: 'E6716: Timeout Starting Prediction' })) });
    expect(finishOf(await events(adapter(passing.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { retryable: true } });
    const lasting = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'failed', error: 'E1001: Model Out of Memory' })) });
    expect(finishOf(await events(adapter(lasting.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { retryable: false } });
  });

  it('keeps a throttled request retryable', async () => {
    const { fetch } = fakeFetch({ [CREATE]: () => jsonResponse({ detail: 'Request was throttled. Expected available in 1 second.' }, 429) });
    expect(finishOf(await events(adapter(fetch).generate(generate())))).toMatchObject({ error: { code: 'provider_busy', retryable: true } });
  });

  it('rides out a poll that fails for a moment', async () => {
    let polls = 0;
    const { fetch } = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'starting' })), [GET]: () => (++polls < 3 ? new Response('busy', { status: 503 }) : jsonResponse(prediction({ status: 'succeeded', output: 'https://replicate.delivery/a.png' }))) });
    expect(finishOf(await events(adapter(fetch).generate(generate()))).reason).toBe('done');
  });

  it('cancels the prediction on stop', async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch({
      [CREATE]: () => jsonResponse(prediction({ status: 'starting' })),
      [GET]: () => {
        controller.abort();
        return jsonResponse(prediction({ status: 'processing' }));
      },
      'POST /v1/predictions/p1/cancel': () => jsonResponse(prediction({ status: 'canceled' })),
    });
    expect(finishOf(await events(adapter(fetch).generate(generate({ signal: controller.signal })))).reason).toBe('aborted');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: URLS.cancel });
  });

  it('stops before it starts, and won’t send the key elsewhere', async () => {
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(generate({ signal: stopped() })))).reason).toBe('aborted');
    const { fetch, calls } = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'starting', urls: { get: 'https://evil.example.com/p1' } })) });
    expect(finishOf(await events(adapter(fetch).generate(generate()))).reason).toBe('error');
    expect(calls).toHaveLength(1);
  });

  it('reports an answer it cannot use', async () => {
    const empty = fakeFetch({ [CREATE]: () => jsonResponse(prediction({ status: 'succeeded', output: null })) });
    expect(finishOf(await events(adapter(empty.fetch).generate(generate()))).reason).toBe('error');
    const garbled = fakeFetch({ [CREATE]: () => new Response('<html>') });
    expect(finishOf(await events(adapter(garbled.fetch).generate(generate()))).reason).toBe('error');
  });

  it('lists what was typed in and its text-to-image collection', async () => {
    const collection = { name: 'Text to image', slug: 'text-to-image', models: [{ owner: 'black-forest-labs', name: 'flux-schnell', description: 'Fast' }, { owner: 'someone', name: 'other' }] };
    const { fetch } = fakeFetch({ 'GET /v1/collections/text-to-image': () => jsonResponse(collection) });
    const models = await adapter(fetch, ['someone/other']).listModels();
    expect(models.map((m) => [m.modelId, m.source])).toEqual([['someone/other', 'default'], ['black-forest-labs/flux-schnell', 'detected']]);
    expect(models[1]?.capabilities).toMatchObject({ maxCount: 4, seed: true, sizes: { kind: 'aspect' } });
  });
});
