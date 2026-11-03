import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY, PNG, stopped } from './__fixtures__/images.ts';
import { videoRequest, videoOf } from './__fixtures__/video.ts';
import { createFal } from './fal.ts';
import { falVideoBody, falVideoCapabilities, falVideoSchema } from './fal-video.ts';

// The input schemas fal's models API gave for these four endpoints on 2026-11-03, cut down to the POST and its input.
const FIXTURE = JSON.parse(readFileSync(new URL('./__fixtures__/fal-video-models.json', import.meta.url), 'utf8')) as { models: Record<string, unknown>[] };
const entry = (id: string) => FIXTURE.models.find((m) => m.endpoint_id === id)!;
const schemaOf = (id: string) => falVideoSchema(entry(id))!;

describe('fal video schemas', () => {
  it('makes capabilities from Wan’s: a nullable integer range, resolutions, an `audio` flag and a seed', () => {
    const caps = falVideoCapabilities(schemaOf('alibaba/wan-3.0/text-to-video'));
    expect(caps).toMatchObject({ output: 'video', seed: true, sizes: { kind: 'aspect', ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'], classes: ['480p', '720p', '1080p'] } });
    expect(videoOf(caps)).toEqual({ durations: { kind: 'range', min: 2, max: 30, step: 1 }, defaultSeconds: 5, resolutions: ['480p', '720p', '1080p'], firstFrame: false, lastFrame: false, audio: 'optional' });
  });

  it('knows an image-to-video endpoint needs its picture, and which fields are the frames', () => {
    const schema = schemaOf('kling/v4/image-to-video');
    expect(schema).toMatchObject({ firstFrame: 'start_image_url', lastFrame: 'end_image_url' });
    expect(videoOf(falVideoCapabilities(schema))).toMatchObject({ firstFrame: true, lastFrame: true, firstFrameRequired: true, audio: 'none', durations: { kind: 'range', min: 3, max: 30 } });
  });

  it('lists the lengths an enum allows without its "auto", and the frame rates', () => {
    const video = videoOf(falVideoCapabilities(schemaOf('lightricks/ltx-2.5/text-to-video/fast')));
    expect(video).toMatchObject({ durations: { kind: 'list', seconds: [6, 8, 10, 12, 14, 16, 18, 20] }, defaultSeconds: 6, fps: [24, 25, 48, 50], defaultFps: 25, resolutions: ['720p', '1080p', '1440p', '2160p'], audio: 'optional' });
  });

  it('sends Wan its fields in its own names and types', () => {
    const body = falVideoBody(schemaOf('alibaba/wan-3.0/text-to-video'), videoRequest({ aspectRatio: '9:16', seed: 3, video: { seconds: 8, resolution: '720p', audio: false } }));
    expect(body).toEqual({ prompt: 'a red lighthouse', duration: 8, resolution: '720p', aspect_ratio: '9:16', audio: false, seed: 3 });
  });

  it('spells a resolution as the endpoint does, and sends a required field’s default', () => {
    const body = falVideoBody(schemaOf('minimax/h3-max/text-to-video'), videoRequest({ aspectRatio: '16:9', video: { seconds: 6.5, resolution: '768p' } }));
    expect(body).toEqual({ prompt: 'a red lighthouse', duration: 6.5, resolution: '768P', aspect_ratio: '16:9', prompt_expansion_mode: 'balanced' });
  });

  it('sends the frames as images in the endpoint’s fields, and leaves out what it has no field for', () => {
    const frame = { bytes: PNG, mime: 'image/png', name: 'f.png' };
    const body = falVideoBody(schemaOf('kling/v4/image-to-video'), videoRequest({ aspectRatio: '16:9', seed: 9, negativePrompt: 'blur', video: { seconds: 5, resolution: '720p', audio: true, firstFrame: frame, lastFrame: frame } }));
    expect(Object.keys(body).sort()).toEqual(['duration', 'end_image_url', 'prompt', 'resolution', 'start_image_url']);
    expect(body.start_image_url).toMatch(/^data:image\/png;base64,/);
  });

  it('sends a length as a string when the endpoint lists them as strings', () => {
    const schema = { fields: { duration: { type: 'string', enum: ['auto', '4', '5'] } }, required: [] };
    expect(falVideoBody(schema, videoRequest({ video: { seconds: 5 } })).duration).toBe('5');
    expect(falVideoCapabilities(schema).video!.durations).toEqual({ kind: 'list', seconds: [4, 5] });
  });

  it('gives a model with no schema only what every endpoint takes', () => {
    expect(falVideoSchema({ endpoint_id: 'x' })).toBeNull();
    const caps = falVideoCapabilities({ fields: {}, required: [] });
    expect(videoOf(caps)).toMatchObject({ durations: { kind: 'list', seconds: [5] }, firstFrame: false, audio: 'none' });
    expect(falVideoBody({ fields: {}, required: [] }, videoRequest())).toEqual({ prompt: 'a red lighthouse' });
  });
});

describe('fal video generation', () => {
  const BASE = 'https://queue.fal.run';
  const WAN = 'alibaba/wan-3.0/text-to-video';
  const REQUEST = `${BASE}/fal-ai/wan-3/requests/abc`;
  const SUBMITTED = { request_id: 'abc', response_url: REQUEST, status_url: `${REQUEST}/status`, cancel_url: `${REQUEST}/cancel`, queue_position: 1 };
  const adapter = (fetch: Parameters<typeof deps>[0], models: string[] = []) => createFal(instance('fal', BASE, { preset: 'fal-video', models }), deps(fetch), { pollMs: 0 });
  const statuses = (...answers: unknown[]) => {
    let at = 0;
    return () => jsonResponse(answers[Math.min(at++, answers.length - 1)]);
  };

  it('lists typed-in endpoints first, then fal’s video categories, each from its own schema', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/models': (call) => {
        const url = new URL(call.url);
        if (url.searchParams.get('endpoint_id')) return jsonResponse({ models: [entry('kling/v4/image-to-video')] });
        return jsonResponse({ models: url.searchParams.get('category') === 'text-to-video' ? [entry(WAN), entry('minimax/h3-max/text-to-video')] : [entry('kling/v4/image-to-video')] });
      },
    });
    const models = await adapter(fetch, ['kling/v4/image-to-video', 'not/known']).listModels();
    expect(models.map((m) => [m.modelId, m.source])).toEqual([['kling/v4/image-to-video', 'default'], ['not/known', 'default'], [WAN, 'detected'], ['minimax/h3-max/text-to-video', 'detected']]);
    expect(models[0]!.displayName).toBe('Kling 4.0 Image to Video');
    expect(calls.every((c) => new URL(c.url).searchParams.get('expand') === 'openapi-3.0')).toBe(true);
    expect(calls.map((c) => new URL(c.url).searchParams.get('category'))).toEqual([null, 'text-to-video', 'image-to-video']);
  });

  it('submits a fitted body, follows the queue and hands over the clip’s address and seed', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/models': () => jsonResponse({ models: [entry(WAN)] }),
      [`POST /${WAN}`]: () => jsonResponse(SUBMITTED),
      'GET /fal-ai/wan-3/requests/abc/status': statuses({ status: 'IN_QUEUE', queue_position: 1 }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED' }),
      'GET /fal-ai/wan-3/requests/abc': () => jsonResponse({ video: { url: 'https://v3b.fal.media/files/b/x/out.mp4', content_type: 'video/mp4' }, seed: 12 }),
    });
    const out = await events(adapter(fetch).generate(videoRequest({ model: WAN, aspectRatio: '16:9', video: { seconds: 6, resolution: '480p' } })));
    // The schema is fetched once for the model that wasn't listed yet, then the job goes to the endpoint's own path.
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /v1/models', `POST /${WAN}`, 'GET /fal-ai/wan-3/requests/abc/status', 'GET /fal-ai/wan-3/requests/abc/status', 'GET /fal-ai/wan-3/requests/abc/status', 'GET /fal-ai/wan-3/requests/abc']);
    expect(calls[1]?.headers.authorization).toBe(`Key ${KEY}`);
    expect(calls[1]?.body).toEqual({ prompt: 'a red lighthouse', duration: 6, resolution: '480p', aspect_ratio: '16:9' });
    expect(out).toContainEqual({ type: 'queued', ahead: 1 });
    expect(out).toContainEqual({ type: 'video', url: 'https://v3b.fal.media/files/b/x/out.mp4', seed: 12 });
    expect(finishOf(out).reason).toBe('done');
  });

  it('reports an answer without a video, a policy 422 and a stop', async () => {
    const base = { 'GET /v1/models': () => jsonResponse({ models: [entry(WAN)] }), [`POST /${WAN}`]: () => jsonResponse(SUBMITTED), 'GET /fal-ai/wan-3/requests/abc/status': statuses({ status: 'COMPLETED' }) };
    const none = fakeFetch({ ...base, 'GET /fal-ai/wan-3/requests/abc': () => jsonResponse({}) });
    expect(finishOf(await events(adapter(none.fetch).generate(videoRequest({ model: WAN })))).error?.message).toContain('no video');
    const flagged = fakeFetch({ ...base, 'GET /fal-ai/wan-3/requests/abc': () => jsonResponse({ detail: [{ loc: ['body'], msg: 'The content was flagged by the safety checker', type: 'content_policy_violation' }] }, 422) });
    expect(finishOf(await events(adapter(flagged.fetch).generate(videoRequest({ model: WAN })))).reason).toBe('refused');
    expect(finishOf(await events(adapter(fakeFetch(base).fetch).generate(videoRequest({ model: WAN, signal: stopped() })))).reason).toBe('aborted');
  });

  it('cancels a job it has submitted when stopped', async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch({
      'GET /v1/models': () => jsonResponse({ models: [entry(WAN)] }),
      [`POST /${WAN}`]: () => jsonResponse(SUBMITTED),
      'GET /fal-ai/wan-3/requests/abc/status': () => {
        controller.abort();
        return jsonResponse({ status: 'IN_PROGRESS' });
      },
      'PUT /fal-ai/wan-3/requests/abc/cancel': () => jsonResponse({ status: 'OK' }),
    });
    expect(finishOf(await events(adapter(fetch).generate(videoRequest({ model: WAN, signal: controller.signal })))).reason).toBe('aborted');
    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/cancel'))).toBe(true);
  });
});
