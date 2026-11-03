import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY, PNG, stopped } from './__fixtures__/images.ts';
import { videoRequest } from './__fixtures__/video.ts';
import { createXaiVideo } from './xai-video.ts';

const BASE = 'https://api.x.ai';
const adapter = (fetch: Parameters<typeof deps>[0], models: string[] = []) => createXaiVideo(instance('xai-video', BASE, { models }), deps(fetch), { pollMs: 0 });
const statuses = (...answers: unknown[]) => {
  let at = 0;
  return () => jsonResponse(answers[Math.min(at++, answers.length - 1)]);
};
const DONE = { status: 'done', progress: 100, video: { url: 'https://vidgen.x.ai/abc/video.mp4', duration: 6, respect_moderation: true }, usage: { cost_in_usd_ticks: 3_000_000_000 } };

describe('xAI video', () => {
  it('lists the documented models, the classic one without 1080p, plus any typed in', async () => {
    const models = await adapter(fakeFetch({}).fetch, ['grok-imagine-video-2']).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite', 'grok-imagine-video', 'grok-imagine-video-2']);
    expect(models[0]!.capabilities.video).toMatchObject({ durations: { kind: 'range', min: 1, max: 15, step: 1 }, resolutions: ['480p', '720p', '1080p'], firstFrame: true, lastFrame: false, audio: 'optional' });
    expect(models[2]!.capabilities.video!.resolutions).toEqual(['480p', '720p']);
    expect(models[3]!.source).toBe('default');
  });

  it('checks health with a lookup that needs the key', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /v1/models': () => jsonResponse({ data: [] }) });
    expect((await adapter(fetch).health()).ok).toBe(true);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('submits, polls with progress, and hands over the clip’s address with its cost', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v1/videos/generations': () => jsonResponse({ request_id: 'req 1' }),
      'GET /v1/videos/req%201': statuses({ status: 'pending', progress: 20 }, { status: 'pending' }, DONE),
    });
    const out = await events(adapter(fetch).generate(videoRequest({ model: 'grok-imagine-video-1.5', aspectRatio: '9:16', video: { seconds: 6, resolution: '720p', audio: false } })));
    expect(calls[0]?.body).toEqual({ model: 'grok-imagine-video-1.5', prompt: 'a red lighthouse', duration: 6, resolution: '720p', aspect_ratio: '9:16', generate_audio: false });
    expect(out).toContainEqual({ type: 'progress', fraction: 0.2 });
    expect(out).toContainEqual({ type: 'usage', costUsd: 0.3 });
    expect(out).toContainEqual({ type: 'video', url: 'https://vidgen.x.ai/abc/video.mp4' });
    expect(finishOf(out).reason).toBe('done');
  });

  it('starts from a picture without sending an aspect ratio, which the picture decides', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/videos/generations': () => jsonResponse({ request_id: 'r' }), 'GET /v1/videos/r': statuses(DONE) });
    await events(adapter(fetch).generate(videoRequest({ aspectRatio: '16:9', video: { seconds: 5, firstFrame: { bytes: PNG, mime: 'image/png', name: 'f.png' } } })));
    const sent = calls[0]?.body as { image: { url: string } };
    expect(sent.image.url).toMatch(/^data:image\/png;base64,/);
    expect(sent).not.toHaveProperty('aspect_ratio');
  });

  it('calls a clip moderation held back a refusal', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/videos/generations': () => jsonResponse({ request_id: 'r' }), 'GET /v1/videos/r': statuses({ status: 'done', video: { url: '', respect_moderation: false } }) });
    expect(finishOf(await events(adapter(fetch).generate(videoRequest()))).reason).toBe('refused');
  });

  it('reads a failed job by its code', async () => {
    const run = (error: unknown) => fakeFetch({ 'POST /v1/videos/generations': () => jsonResponse({ request_id: 'r' }), 'GET /v1/videos/r': statuses({ status: 'failed', error }) });
    expect(finishOf(await events(adapter(run({ code: 'permission_denied', message: 'No.' }).fetch).generate(videoRequest())))).toMatchObject({ reason: 'refused' });
    expect(finishOf(await events(adapter(run({ code: 'invalid_argument', message: 'Bad duration' }).fetch).generate(videoRequest())))).toMatchObject({ reason: 'error', error: { message: 'Service: Bad duration', retryable: false } });
    expect(finishOf(await events(adapter(run({ code: 'service_unavailable', message: 'Busy' }).fetch).generate(videoRequest())))).toMatchObject({ error: { retryable: true } });
  });

  it('keeps a submit refusal final, and ends as aborted when stopped', async () => {
    const moderated = fakeFetch({ 'POST /v1/videos/generations': () => jsonResponse({ error: 'Content violates the safety policy' }, 400) });
    expect(finishOf(await events(adapter(moderated.fetch).generate(videoRequest()))).reason).toBe('refused');
    const { fetch } = fakeFetch({});
    expect(finishOf(await events(adapter(fetch).generate(videoRequest({ signal: stopped() })))).reason).toBe('aborted');
  });

  it('rides out a poll that fails for a moment', async () => {
    let polls = 0;
    const { fetch } = fakeFetch({ 'POST /v1/videos/generations': () => jsonResponse({ request_id: 'r' }), 'GET /v1/videos/r': () => (++polls < 3 ? jsonResponse({}, 502) : jsonResponse(DONE)) });
    expect(finishOf(await events(adapter(fetch).generate(videoRequest()))).reason).toBe('done');
  });
});
