import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY, PNG, stopped } from './__fixtures__/images.ts';
import { videoOf, videoRequest } from './__fixtures__/video.ts';
import { createReplicate } from './replicate.ts';
import { replicateFrame, replicateVideoCapabilities, replicateVideoInput, replicateVideoSchema } from './replicate-video.ts';

const BASE = 'https://api.replicate.com';
// Veo 3.1's input as Replicate's API describes it (enums as their own schemas, referenced through allOf), on 2026-11-03.
const VEO = JSON.parse(readFileSync(new URL('./__fixtures__/replicate-veo-model.json', import.meta.url), 'utf8'));
const GET = `${BASE}/v1/predictions/p1`;
const PREDICTION = { id: 'p1', status: 'starting', urls: { get: GET, cancel: `${GET}/cancel` } };
const adapter = (fetch: Parameters<typeof deps>[0], models: string[] = []) => createReplicate(instance('replicate', BASE, { preset: 'replicate-video', models }), deps(fetch), { pollMs: 0 });
const statuses = (...answers: unknown[]) => {
  let at = 0;
  return () => jsonResponse(answers[Math.min(at++, answers.length - 1)]);
};

describe('Replicate video schemas', () => {
  it('makes capabilities from a model’s Input, following the enum schemas it refers to', () => {
    const schema = replicateVideoSchema(VEO)!;
    expect(schema).toMatchObject({ duration: 'duration', firstFrame: 'image', lastFrame: 'last_frame', audio: 'generate_audio', required: ['prompt'] });
    const caps = replicateVideoCapabilities(schema);
    expect(caps).toMatchObject({ output: 'video', seed: true, negativePrompt: true, sizes: { kind: 'aspect', ratios: ['16:9', '9:16'], classes: ['720p', '1080p'] } });
    expect(videoOf(caps)).toEqual({ durations: { kind: 'list', seconds: [4, 6, 8] }, defaultSeconds: 6, resolutions: ['720p', '1080p'], firstFrame: true, lastFrame: true, audio: 'optional' });
  });

  it('builds the input in the model’s own names, with a whole-number length', () => {
    const frame = { bytes: PNG, mime: 'image/png', name: 'f.png' };
    const body = replicateVideoInput(replicateVideoSchema(VEO)!, videoRequest({ aspectRatio: '9:16', seed: 2, negativePrompt: 'blur', video: { seconds: 4, resolution: '1080p', audio: false, firstFrame: frame, lastFrame: frame } }));
    expect(body).toMatchObject({ prompt: 'a red lighthouse', duration: 4, resolution: '1080p', aspect_ratio: '9:16', generate_audio: false, seed: 2, negative_prompt: 'blur' });
    expect(body.image).toMatch(/^data:image\/png;base64,/);
    expect(body.last_frame).toMatch(/^data:image\/png;base64,/);
  });

  it('refuses a picture too large to send inline that cannot be reduced', () => {
    expect(() => replicateFrame({ bytes: new Uint8Array(400_000), mime: 'image/webp', name: 'big.webp' })).toThrow('takes only small ones inline');
  });

  it('knows a model whose answer has no readable schema', () => {
    expect(replicateVideoSchema({ latest_version: {} })).toBeNull();
  });
});

describe('Replicate video generation', () => {
  it('lists typed-in models first, then the video collections, each from its schema', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/models/google/veo-3.1': () => jsonResponse(VEO),
      'GET /v1/models/alibaba/wan-3': () => jsonResponse({ description: 'Wan', latest_version: { openapi_schema: { components: { schemas: { Input: { properties: { prompt: { type: 'string' }, duration: { type: 'integer', minimum: 2, maximum: 30 } }, required: ['prompt'] } } } } } }),
      'GET /v1/collections/text-to-video': () => jsonResponse({ models: [{ owner: 'google', name: 'veo-3.1' }, { owner: 'alibaba', name: 'wan-3' }] }),
      'GET /v1/collections/image-to-video': () => jsonResponse({ models: [{ owner: 'alibaba', name: 'wan-3' }] }),
    });
    const models = await adapter(fetch, ['google/veo-3.1']).listModels();
    expect(models.map((m) => [m.modelId, m.source])).toEqual([['google/veo-3.1', 'default'], ['alibaba/wan-3', 'detected']]);
    expect(videoOf(models[1]!.capabilities)).toMatchObject({ durations: { kind: 'range', min: 2, max: 30, step: 1 }, firstFrame: false, audio: 'none' });
    expect(models[1]!.description).toBe('Wan');
    expect(calls.every((c) => c.headers.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it('keeps a model whose schema cannot be read, with what every model takes', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/models/o/gone': () => jsonResponse({}, 404), 'GET /v1/collections/text-to-video': () => jsonResponse({ models: [] }), 'GET /v1/collections/image-to-video': () => jsonResponse({ models: [] }) });
    const [model] = await adapter(fetch, ['o/gone']).listModels();
    expect(videoOf(model!.capabilities)).toMatchObject({ durations: { kind: 'list', seconds: [5] }, firstFrame: false });
  });

  it('creates a prediction from the schema, waits on it and hands over the one address it made', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/models/google/veo-3.1': () => jsonResponse(VEO),
      'POST /v1/predictions': () => jsonResponse(PREDICTION, 201),
      'GET /v1/predictions/p1': statuses({ ...PREDICTION, status: 'processing' }, { ...PREDICTION, status: 'succeeded', output: 'https://replicate.delivery/xezq/out.mp4' }),
    });
    const out = await events(adapter(fetch).generate(videoRequest({ model: 'google/veo-3.1', aspectRatio: '16:9', video: { seconds: 6, resolution: '720p', audio: false } })));
    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.headers.prefer).toBe('wait=60');
    expect(create.body).toEqual({ version: 'google/veo-3.1', input: { prompt: 'a red lighthouse', duration: 6, resolution: '720p', aspect_ratio: '16:9', generate_audio: false } });
    expect(out).toContainEqual({ type: 'loading' });
    expect(out).toContainEqual({ type: 'progress' });
    expect(out).toContainEqual({ type: 'video', url: 'https://replicate.delivery/xezq/out.mp4' });
    expect(out.some((e) => e.type === 'image')).toBe(false);
    expect(finishOf(out).reason).toBe('done');
  });

  it('answers with a list of addresses by taking the first', async () => {
    const { fetch } = fakeFetch({
      'GET /v1/models/o/m': () => jsonResponse({}),
      'POST /v1/predictions': () => jsonResponse({ ...PREDICTION, status: 'succeeded', output: ['https://replicate.delivery/a.mp4', 'https://replicate.delivery/b.mp4'] }),
    });
    const out = await events(adapter(fetch).generate(videoRequest({ model: 'o/m' })));
    expect(out.filter((e) => e.type === 'video')).toEqual([{ type: 'video', url: 'https://replicate.delivery/a.mp4' }]);
  });

  it('reports a failure, a content refusal and a prediction with no video', async () => {
    const run = (prediction: unknown) => fakeFetch({ 'GET /v1/models/o/m': () => jsonResponse({}), 'POST /v1/predictions': () => jsonResponse(prediction, 201) });
    expect(finishOf(await events(adapter(run({ ...PREDICTION, status: 'failed', error: 'Out of memory' }).fetch).generate(videoRequest({ model: 'o/m' }))))).toMatchObject({ reason: 'error', error: { message: 'Service: Out of memory' } });
    expect(finishOf(await events(adapter(run({ ...PREDICTION, status: 'failed', error: 'Content flagged by the safety filter' }).fetch).generate(videoRequest({ model: 'o/m' })))).reason).toBe('refused');
    expect(finishOf(await events(adapter(run({ ...PREDICTION, status: 'succeeded', output: null }).fetch).generate(videoRequest({ model: 'o/m' })))).error?.message).toContain('no video');
  });

  it('cancels the prediction when stopped, and ends as aborted', async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch({
      'GET /v1/models/o/m': () => jsonResponse({}),
      'POST /v1/predictions': () => jsonResponse({ ...PREDICTION, status: 'processing' }, 201),
      'GET /v1/predictions/p1': () => {
        controller.abort();
        return jsonResponse({ ...PREDICTION, status: 'processing' });
      },
      'POST /v1/predictions/p1/cancel': () => jsonResponse({}),
    });
    expect(finishOf(await events(adapter(fetch).generate(videoRequest({ model: 'o/m', signal: controller.signal })))).reason).toBe('aborted');
    expect(calls.some((c) => c.url.endsWith('/p1/cancel'))).toBe(true);
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(videoRequest({ model: 'o/m', signal: stopped() })))).reason).toBe('aborted');
  });
});
