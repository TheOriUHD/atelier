import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY, PNG, stopped } from './__fixtures__/images.ts';
import { videoOf, videoRequest } from './__fixtures__/video.ts';
import { createBfl } from './bfl.ts';

const BASE = 'https://api.bfl.ai';
const SUBMITTED = { id: 'task', polling_url: 'https://api.eu.bfl.ai/v1/get_result?id=task', cost: 40 };
const POLL = 'GET /v1/get_result?id=task';
const adapter = (fetch: Parameters<typeof deps>[0], models: string[] = []) => createBfl(instance('bfl', BASE, { preset: 'bfl-video', models }), deps(fetch), { pollMs: 0 });
const sequence = (...answers: unknown[]) => {
  let at = 0;
  return () => jsonResponse(answers[Math.min(at++, answers.length - 1)]);
};

describe('Black Forest Labs video', () => {
  it('lists FLUX 3 video, with its lengths and resolutions, on the video service only', async () => {
    const models = await adapter(fakeFetch({}).fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['flux-3-video']);
    expect(videoOf(models[0]!.capabilities)).toMatchObject({ durations: { kind: 'range', min: 5, max: 20, step: 1 }, resolutions: ['hd', 'fhd', 'qhd', 'uhd'], firstFrame: true, lastFrame: false, audio: 'optional' });
    const images = await createBfl(instance('bfl', BASE), deps(fakeFetch({}).fetch)).listModels();
    expect(images.every((m) => m.capabilities.output !== 'video')).toBe(true);
  });

  it('asks for text to video, follows the job and hands over the clip’s address and its cost', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/flux-3-video': () => jsonResponse(SUBMITTED), [POLL]: sequence({ status: 'Pending' }, { status: 'Generating', progress: 0.5 }, { status: 'Ready', result: { sample: 'https://delivery.eu.bfl.ai/v.mp4' } }) });
    const out = await events(adapter(fetch).generate(videoRequest({ model: 'flux-3-video', aspectRatio: '16:9', video: { seconds: 8, resolution: 'fhd', audio: false } })));
    expect(calls[0]?.headers['x-key']).toBe(KEY);
    expect(calls[0]?.body).toEqual({ mode: 't2v', prompt: 'a red lighthouse', duration: 8, resolution: 'fhd', aspect_ratio: '16:9', generate_audio: false });
    expect(out).toContainEqual({ type: 'usage', costUsd: 0.4 });
    expect(out).toContainEqual({ type: 'progress', fraction: 0.5 });
    expect(out).toContainEqual({ type: 'video', url: 'https://delivery.eu.bfl.ai/v.mp4' });
    expect(out.some((e) => e.type === 'image')).toBe(false);
    expect(finishOf(out).reason).toBe('done');
  });

  it('starts from a picture as image to video', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/flux-3-video': () => jsonResponse(SUBMITTED), [POLL]: sequence({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/v.mp4' } }) });
    await events(adapter(fetch).generate(videoRequest({ model: 'flux-3-video', video: { seconds: 5, firstFrame: { bytes: PNG, mime: 'image/png', name: 'f.png' } } })));
    expect(calls[0]?.body).toMatchObject({ mode: 'i2v', keyframes: Buffer.from(PNG).toString('base64') });
  });

  it('keeps moderation final and reports a stop', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/flux-3-video': () => jsonResponse(SUBMITTED), [POLL]: sequence({ status: 'Content Moderated', details: { 'Moderation Reasons': ['Violence'] } }) });
    expect(finishOf(await events(adapter(fetch).generate(videoRequest({ model: 'flux-3-video' }))))).toMatchObject({ reason: 'refused' });
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(videoRequest({ model: 'flux-3-video', signal: stopped() })))).reason).toBe('aborted');
  });
});
