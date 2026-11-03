import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY, PNG, stopped } from './__fixtures__/images.ts';
import { videoRequest, videoOf } from './__fixtures__/video.ts';
import { createOpenRouterVideo, pollDelay } from './openrouter-video.ts';

const BASE = 'https://openrouter.ai/api';
// The first five rows of what /api/v1/videos/models answered on 2026-11-03.
const MODELS = JSON.parse(readFileSync(new URL('./__fixtures__/openrouter-video-models.json', import.meta.url), 'utf8'));
const MP4 = new Uint8Array(readFileSync(new URL('../__fixtures__/tiny.mp4', import.meta.url)));
const adapter = (fetch: Parameters<typeof deps>[0]) => createOpenRouterVideo(instance('openrouter-video', BASE), deps(fetch), { pollMs: 0 });
const statuses = (...answers: unknown[]) => {
  let at = 0;
  return () => jsonResponse(answers[Math.min(at++, answers.length - 1)]);
};
const SUBMITTED = { id: 'job1', polling_url: 'https://openrouter.ai/api/v1/videos/job1', status: 'pending' };
const DONE = { id: 'job1', status: 'completed', unsigned_urls: ['https://openrouter.ai/api/v1/videos/job1/content?index=0'], usage: { cost: 0.4, is_byok: false } };

describe('OpenRouter video', () => {
  it('lists the video models with what each takes, and leaves out those that need a video to start from', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /api/v1/videos/models': () => jsonResponse(MODELS) });
    const models = await adapter(fetch).listModels();
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(models.map((m) => m.modelId)).toEqual(['tbc/mischief-1', 'x-ai/grok-imagine-video-1.5', 'minimax/hailuo-2.3', 'google/veo-3.1']);
    const veo = models.find((m) => m.modelId === 'google/veo-3.1')!;
    expect(veo).toMatchObject({ ref: 'img/google/veo-3.1', displayName: expect.any(String), source: 'detected' });
    expect(veo.capabilities).toMatchObject({ output: 'video', seed: true, sizes: { kind: 'aspect', ratios: ['16:9', '9:16'], classes: ['720p', '1080p', '4K'] } });
    expect(videoOf(veo.capabilities)).toEqual({ durations: { kind: 'list', seconds: [4, 6, 8] }, defaultSeconds: 6, resolutions: ['720p', '1080p', '4K'], firstFrame: true, lastFrame: true, audio: 'optional' });
    const grok = models.find((m) => m.modelId.startsWith('x-ai/'))!;
    expect(videoOf(grok.capabilities)).toMatchObject({ defaultSeconds: 5, audio: 'none', lastFrame: false });
    expect(videoOf(grok.capabilities).durations).toMatchObject({ kind: 'list' });
  });

  it('checks health against the same list', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /api/v1/videos/models': () => jsonResponse(MODELS) });
    expect((await adapter(fetch).health()).ok).toBe(true);
    expect(calls[0]?.url).toBe(`${BASE}/v1/videos/models`);
  });

  it('submits, follows the job and downloads the clip with the key, reporting the cost', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /api/v1/videos': () => jsonResponse(SUBMITTED, 202),
      'GET /api/v1/videos/job1': statuses({ ...SUBMITTED, status: 'pending' }, { ...SUBMITTED, status: 'in_progress' }, DONE),
      'GET /api/v1/videos/job1/content': () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }),
    });
    const out = await events(adapter(fetch).generate(videoRequest({ model: 'google/veo-3.1', aspectRatio: '16:9', seed: 4, video: { seconds: 6, resolution: '1080p', audio: true } })));
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.body).toEqual({ model: 'google/veo-3.1', prompt: 'a red lighthouse', duration: 6, resolution: '1080p', aspect_ratio: '16:9', generate_audio: true, seed: 4 });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/v1/videos', '/api/v1/videos/job1', '/api/v1/videos/job1', '/api/v1/videos/job1', '/api/v1/videos/job1/content']);
    expect(calls.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(out).toContainEqual({ type: 'loading', what: 'Waiting for a free slot' });
    expect(out).toContainEqual({ type: 'progress' });
    expect(out).toContainEqual({ type: 'usage', costUsd: 0.4 });
    const clip = out.find((e) => e.type === 'video');
    expect(clip && 'bytes' in clip && clip.bytes?.byteLength).toBe(MP4.byteLength);
    expect(finishOf(out).reason).toBe('done');
  });

  it('sends the first and last frame as images, and no sound flag to a silent model', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /api/v1/videos': () => jsonResponse(SUBMITTED, 202),
      'GET /api/v1/videos/job1': statuses(DONE),
      'GET /api/v1/videos/job1/content': () => new Response(MP4),
    });
    const frame = { bytes: PNG, mime: 'image/png', name: 'f.png' };
    const silent = videoRequest({ model: 'minimax/hailuo-3', video: { seconds: 6, firstFrame: frame, lastFrame: frame, audio: true } }, { audio: 'none' });
    await events(adapter(fetch).generate(silent));
    const sent = calls[0]?.body as { frame_images: { frame_type: string; image_url: { url: string } }[] };
    expect(sent).not.toHaveProperty('generate_audio');
    expect(sent.frame_images.map((f) => f.frame_type)).toEqual(['first_frame', 'last_frame']);
    expect(sent.frame_images[0]!.image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('refuses to send the key to another host, in the job address or the download', async () => {
    const wandering = fakeFetch({ 'POST /api/v1/videos': () => jsonResponse({ ...SUBMITTED, polling_url: 'https://evil.example.com/steal' }, 202) });
    expect(finishOf(await events(adapter(wandering.fetch).generate(videoRequest()))).error?.message).toContain("won't send the key");
    expect(wandering.calls).toHaveLength(1);
    const download = fakeFetch({
      'POST /api/v1/videos': () => jsonResponse(SUBMITTED, 202),
      'GET /api/v1/videos/job1': statuses({ ...DONE, unsigned_urls: ['https://evil.example.com/v.mp4'] }),
    });
    expect(finishOf(await events(adapter(download.fetch).generate(videoRequest()))).error?.message).toContain("won't send the key");
    expect(download.calls.some((c) => c.url.includes('evil'))).toBe(false);
  });

  it('turns a policy failure into a refusal and another failure into an error', async () => {
    const refused = fakeFetch({ 'POST /api/v1/videos': () => jsonResponse(SUBMITTED, 202), 'GET /api/v1/videos/job1': statuses({ status: 'failed', error: 'The prompt was blocked by the content policy' }) });
    expect(finishOf(await events(adapter(refused.fetch).generate(videoRequest()))).reason).toBe('refused');
    const broken = fakeFetch({ 'POST /api/v1/videos': () => jsonResponse(SUBMITTED, 202), 'GET /api/v1/videos/job1': statuses({ status: 'failed', error: 'The provider crashed' }) });
    expect(finishOf(await events(adapter(broken.fetch).generate(videoRequest())))).toMatchObject({ reason: 'error', error: { message: 'Service: The provider crashed', retryable: false } });
  });

  it('turns a 400 that names a moderation reason into a refusal, and keeps 429 retryable', async () => {
    const moderated = fakeFetch({ 'POST /api/v1/videos': () => jsonResponse({ error: { message: 'Content flagged by moderation' } }, 400) });
    expect(finishOf(await events(adapter(moderated.fetch).generate(videoRequest()))).reason).toBe('refused');
    const limited = fakeFetch({ 'POST /api/v1/videos': () => jsonResponse({ error: { message: 'slow down' } }, 429) });
    expect(finishOf(await events(adapter(limited.fetch).generate(videoRequest())))).toMatchObject({ error: { retryable: true } });
  });

  it('rides out a poll that fails for a moment, and gives up after five', async () => {
    let polls = 0;
    const flaky = fakeFetch({
      'POST /api/v1/videos': () => jsonResponse(SUBMITTED, 202),
      'GET /api/v1/videos/job1': () => (++polls < 3 ? jsonResponse({}, 503) : jsonResponse(DONE)),
      'GET /api/v1/videos/job1/content': () => new Response(MP4),
    });
    expect(finishOf(await events(adapter(flaky.fetch).generate(videoRequest()))).reason).toBe('done');
    const down = fakeFetch({ 'POST /api/v1/videos': () => jsonResponse(SUBMITTED, 202), 'GET /api/v1/videos/job1': () => jsonResponse({}, 503) });
    expect(finishOf(await events(adapter(down.fetch).generate(videoRequest()))).reason).toBe('error');
    expect(down.calls.filter((c) => c.method === 'GET')).toHaveLength(6);
  });

  it('ends as aborted when stopped', async () => {
    const { fetch } = fakeFetch({ 'POST /api/v1/videos': () => jsonResponse(SUBMITTED, 202) });
    expect(finishOf(await events(adapter(fetch).generate(videoRequest({ signal: stopped() })))).reason).toBe('aborted');
  });

  it('reports a finished job with no video', async () => {
    const empty = fakeFetch({ 'POST /api/v1/videos': () => jsonResponse(SUBMITTED, 202), 'GET /api/v1/videos/job1': statuses({ status: 'completed' }) });
    expect(finishOf(await events(adapter(empty.fetch).generate(videoRequest()))).error?.message).toContain('no video');
  });

  it('asks often at first and settles at every 10 seconds, which a job of minutes can take', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(pollDelay)).toEqual([2000, 3500, 5000, 6500, 8000, 9500, 10000, 10000]);
  });
});
