import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY, PNG, stopped } from './__fixtures__/images.ts';
import { videoOf, videoRequest } from './__fixtures__/video.ts';
import { createGemini } from './gemini.ts';
import { fileIdOf } from './gemini-omni.ts';
import { fitVideo } from '../video-params.ts';

const BASE = 'https://generativelanguage.googleapis.com';
const MP4 = new Uint8Array(readFileSync(new URL('../__fixtures__/tiny.mp4', import.meta.url)));
const MODEL = 'gemini-omni-1.1-flash';
const adapter = (fetch: Parameters<typeof deps>[0], models: string[] = []) => createGemini(instance('gemini', BASE, { preset: 'gemini-video', models }), deps(fetch));
const clip = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'v1_abc', status: 'completed', model: MODEL, object: 'interaction', steps: [{ type: 'user_input', content: [{ type: 'text', text: 'p' }] }, { type: 'thought', content: [{ type: 'thought', text: '…' }] }, { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', ...content }] }], ...extra });
const caps = () => adapter(fakeFetch({}).fetch).listModels().then((m) => m[0]!.capabilities);

describe('Gemini Omni video', () => {
  it('offers Omni on the video service, with a length it chooses itself and sound it always makes', async () => {
    const models = await adapter(fakeFetch({}).fetch, ['gemini-omni-2']).listModels();
    expect(models.map((m) => [m.modelId, m.source])).toEqual([[MODEL, 'catalog'], ['gemini-omni-2', 'default']]);
    expect(videoOf(models[0]!.capabilities)).toMatchObject({ fixedLength: true, audio: 'always', firstFrame: true, lastFrame: false, resolutions: ['360p', '720p', '1080p', '4k'] });
    expect(models[0]!.capabilities.sizes).toMatchObject({ ratios: ['16:9', '9:16'] });
  });

  it('checks health with the models list and the key header', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /v1beta/models': () => jsonResponse({ models: [] }) });
    expect((await adapter(fetch).health()).ok).toBe(true);
    expect(calls[0]?.headers['x-goog-api-key']).toBe(KEY);
  });

  it('asks for a video by URI in one request, then waits for the file and downloads it with the key', async () => {
    let polls = 0;
    const { fetch, calls } = fakeFetch({
      'POST /v1beta/interactions': () => jsonResponse(clip({ uri: `${BASE}/v1beta/files/abc123:download?alt=media` })),
      'GET /v1beta/files/abc123': () => jsonResponse({ state: ++polls < 2 ? 'PROCESSING' : 'ACTIVE' }),
      'GET /v1beta/files/abc123:download': () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }),
    });
    const out = await events(adapter(fetch).generate(videoRequest({ model: MODEL, aspectRatio: '9:16', video: { seconds: 8, resolution: '1080p' } }, { audio: 'always' })));
    expect(calls[0]?.headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0]?.body).toEqual({ model: MODEL, input: 'a red lighthouse', store: false, response_format: { type: 'video', aspect_ratio: '9:16', resolution: '1080p', delivery: 'uri' } });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1beta/interactions', '/v1beta/files/abc123', '/v1beta/files/abc123', '/v1beta/files/abc123:download']);
    expect(calls.at(-1)?.url).toContain('alt=media');
    const video = out.find((e) => e.type === 'video');
    expect(video && 'bytes' in video && video.bytes?.byteLength).toBe(MP4.byteLength);
    expect(finishOf(out).reason).toBe('done');
  }, 15_000);

  it('takes a video that came inline as well', async () => {
    const { fetch } = fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse(clip({ data: Buffer.from(MP4).toString('base64') })) });
    const out = await events(adapter(fetch).generate(videoRequest({ model: MODEL })));
    const video = out.find((e) => e.type === 'video');
    expect(video && 'bytes' in video && video.bytes?.byteLength).toBe(MP4.byteLength);
  });

  it('starts from a picture as image to video, with the picture before the text', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse(clip({ data: Buffer.from(MP4).toString('base64') })) });
    await events(adapter(fetch).generate(videoRequest({ model: MODEL, video: { seconds: 8, firstFrame: { bytes: PNG, mime: 'image/png', name: 'f.png' } } })));
    expect(calls[0]?.body).toMatchObject({
      input: [{ type: 'image', data: Buffer.from(PNG).toString('base64'), mime_type: 'image/png' }, { type: 'text', text: 'a red lighthouse' }],
      generation_config: { video_config: { task: 'image_to_video' } },
    });
  });

  it('reads an answer without a video by its words: blocked is a refusal, failed an error', async () => {
    const blocked = fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse({ id: 'x', status: 'completed', steps: [] , errors: [{ code: 'SAFETY', message: 'Blocked by the safety policy' }] }) });
    expect(finishOf(await events(adapter(blocked.fetch).generate(videoRequest({ model: MODEL })))).reason).toBe('refused');
    const failed = fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse({ id: 'x', status: 'failed', errors: [{ code: 'INTERNAL', message: 'Something broke' }] }) });
    expect(finishOf(await events(adapter(failed.fetch).generate(videoRequest({ model: MODEL }))))).toMatchObject({ reason: 'error', error: { message: 'Service: Something broke' } });
    const empty = fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse({ id: 'x', status: 'completed', steps: [] }) });
    expect(finishOf(await events(adapter(empty.fetch).generate(videoRequest({ model: MODEL })))).error?.message).toContain('no video');
  });

  it('reports a file that failed, an HTTP refusal and a stop', async () => {
    const file = fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse(clip({ uri: `${BASE}/v1beta/files/abc123:download?alt=media` })), 'GET /v1beta/files/abc123': () => jsonResponse({ state: 'FAILED' }) });
    expect(finishOf(await events(adapter(file.fetch).generate(videoRequest({ model: MODEL })))).error?.message).toContain('could not prepare');
    const http = fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse({ error: { message: 'The prompt was blocked for safety reasons' } }, 400) });
    expect(finishOf(await events(adapter(http.fetch).generate(videoRequest({ model: MODEL })))).reason).toBe('refused');
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(videoRequest({ model: MODEL, signal: stopped() })))).reason).toBe('aborted');
  });

  it('finds a file’s id in either form of its address', () => {
    expect(fileIdOf(`${BASE}/v1beta/files/abc-123_X:download?alt=media`)).toBe('abc-123_X');
    expect(fileIdOf('files/abc123')).toBe('abc123');
    expect(fileIdOf('https://example.com/video.mp4')).toBeUndefined();
  });

  it('leaves a length asked for out, since the model chooses', async () => {
    const fit = fitVideo(await caps(), { seconds: 4 });
    expect(fit.seconds).toBe(8);
    expect(fit.notes).toContain('This model chooses how long the clip is, so the length asked for was left out.');
  });
});
