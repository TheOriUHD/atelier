import { describe, expect, it } from 'vitest';
import { BFL_MODELS, lookUp } from '../catalog.ts';
import { deps, events, fakeFetch, finishOf, imagesOf, INPUT, instance, jsonResponse, KEY, request, stopped } from './__fixtures__/images.ts';
import { createBfl } from './bfl.ts';

const BASE = 'https://api.bfl.ai';
const SUBMITTED = { id: 'task', polling_url: 'https://api.eu.bfl.ai/v1/get_result?id=task', cost: 4.5, input_mp: 0, output_mp: 1 };
const POLL = 'GET /v1/get_result?id=task';
const pro = lookUp(BFL_MODELS, 'flux-2-pro');
const adapter = (fetch: Parameters<typeof deps>[0]) => createBfl(instance('bfl', BASE), deps(fetch), { pollMs: 0 });
const generate = (over = {}) => request({ model: 'flux-2-pro', capabilities: pro, width: 1440, height: 2048, ...over });
const sequence = (...answers: unknown[]) => {
  let at = 0;
  return () => jsonResponse(answers[Math.min(at++, answers.length - 1)]);
};

describe('Black Forest Labs', () => {
  it('submits with x-key and polls the address it got, on the host it named', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse(SUBMITTED), [POLL]: sequence({ status: 'Pending', progress: 0.4 }, { status: 'Generating' }, { status: 'Ready', result: { sample: 'https://delivery.eu.bfl.ai/a.png', seed: 42 } }) });
    const out = await events(adapter(fetch).generate(generate({ seed: 42 })));
    expect(calls[0]?.headers['x-key']).toBe(KEY);
    expect(calls[0]?.body).toEqual({ prompt: 'a red lighthouse', width: 1440, height: 2048, seed: 42, output_format: 'png' });
    expect(calls[1]?.url).toBe(SUBMITTED.polling_url);
    expect(calls[1]?.headers['x-key']).toBe(KEY);
    expect(out).toContainEqual({ type: 'progress', fraction: 0.4 });
    expect(out).toContainEqual({ type: 'usage', costUsd: 0.045 });
    expect(imagesOf(out)).toEqual([{ type: 'image', url: 'https://delivery.eu.bfl.ai/a.png', seed: 42 }]);
    expect(finishOf(out).reason).toBe('done');
  });

  it('numbers input images the way FLUX.2 names them, and sends Flex its settings', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/flux-2-flex': () => jsonResponse(SUBMITTED), [POLL]: sequence({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/a.png' } }) });
    await events(adapter(fetch).generate(generate({ model: 'flux-2-flex', references: [INPUT, INPUT], tuning: { steps: 30, guidance: 4 } })));
    expect(calls[0]?.body).toMatchObject({ input_image: expect.any(String), input_image_2: expect.any(String), steps: 30, guidance: 4 });
  });

  it('speaks FLUX 3’s stricter request, and keeps the prompt it expanded', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/flux-3-image': () => jsonResponse(SUBMITTED), [POLL]: sequence({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/a.png', prompt: 'A red lighthouse, expanded', duration: 2 } }) });
    const out = await events(adapter(fetch).generate(request({ model: 'flux-3-image', capabilities: lookUp(BFL_MODELS, 'flux-3-image'), aspectRatio: '16:9', sizeClass: '2k', references: [INPUT] })));
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual(['aspect_ratio', 'images', 'prompt', 'resolution']);
    expect(imagesOf(out)[0]?.revisedPrompt).toBe('A red lighthouse, expanded');
  });

  it.each(['Request Moderated', 'Content Moderated'])('turns %s into a final refusal, with the reasons', async (status) => {
    const answer = { id: 'task', status, result: null, progress: null, details: { 'Moderation Reasons': ['Violence'] }, preview: null };
    const { fetch } = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse(SUBMITTED), [POLL]: sequence(answer) });
    const finish = finishOf(await events(adapter(fetch).generate(generate())));
    expect(finish).toMatchObject({ reason: 'refused', error: { code: 'provider_refused', retryable: false } });
    expect(finish.error?.message).toContain('Violence');
  });

  it('reports a failed task, and lets an expired one be tried again', async () => {
    const failed = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse(SUBMITTED), [POLL]: sequence({ status: 'Error' }) });
    expect(finishOf(await events(adapter(failed.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { retryable: false } });
    const lost = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse(SUBMITTED), [POLL]: sequence({ status: 'Task not found' }) });
    expect(finishOf(await events(adapter(lost.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { retryable: true } });
  });

  it('reads a failed task out of a 503', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse(SUBMITTED), [POLL]: () => jsonResponse({ status: 'Error' }, 503) });
    expect(finishOf(await events(adapter(fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { message: expect.stringContaining('Error') } });
  });

  it('rides out a moment of trouble while polling', async () => {
    let polls = 0;
    const { fetch } = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse(SUBMITTED), [POLL]: () => (++polls < 3 ? new Response('busy', { status: 502 }) : jsonResponse({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/a.png' } })) });
    expect(finishOf(await events(adapter(fetch).generate(generate()))).reason).toBe('done');
  });

  it('keeps a 429 on submit retryable, and calls 402 out of credit', async () => {
    const limited = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse({ detail: 'Too many active tasks' }, 429) });
    expect(finishOf(await events(adapter(limited.fetch).generate(generate())))).toMatchObject({ error: { code: 'provider_busy', retryable: true } });
    const broke = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse({ detail: 'Insufficient credits' }, 402) });
    expect(finishOf(await events(adapter(broke.fetch).generate(generate())))).toMatchObject({ error: { code: 'provider_quota', retryable: false } });
  });

  it('refuses to send the key to a host that isn’t Black Forest Labs', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse({ id: 'x', polling_url: 'https://evil.example.com/steal' }) });
    expect(finishOf(await events(adapter(fetch).generate(generate()))).reason).toBe('error');
    expect(calls).toHaveLength(1);
  });

  it('stops when told to, mid-poll too', async () => {
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(generate({ signal: stopped() })))).reason).toBe('aborted');
    const controller = new AbortController();
    const { fetch } = fakeFetch({
      'POST /v1/flux-2-pro': () => jsonResponse(SUBMITTED),
      [POLL]: () => {
        controller.abort();
        return jsonResponse({ status: 'Pending' });
      },
    });
    expect(finishOf(await events(adapter(fetch).generate(generate({ signal: controller.signal })))).reason).toBe('aborted');
  });

  it('reports an answer it cannot use', async () => {
    const empty = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse({ id: 'x' }) });
    expect(finishOf(await events(adapter(empty.fetch).generate(generate()))).reason).toBe('error');
    const noSample = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse(SUBMITTED), [POLL]: sequence({ status: 'Ready', result: {} }) });
    expect(finishOf(await events(adapter(noSample.fetch).generate(generate()))).reason).toBe('error');
    const garbled = fakeFetch({ 'POST /v1/flux-2-pro': () => jsonResponse(SUBMITTED), [POLL]: () => new Response('<html>') });
    expect(finishOf(await events(adapter(garbled.fetch).generate(generate()))).reason).toBe('error');
  });

  it('lists its catalog, and any model typed in', async () => {
    const service = createBfl(instance('bfl', BASE, { models: ['flux-kontext-pro'] }), deps(fakeFetch({}).fetch));
    const models = await service.listModels();
    expect(models.map((m) => m.modelId)).toEqual(expect.arrayContaining(['flux-3-image', 'flux-2-pro', 'flux-kontext-pro']));
    expect(models.find((m) => m.modelId === 'flux-2-klein-4b')?.capabilities.maxReferences).toBe(4);
    expect(models.find((m) => m.modelId === 'flux-2-flex')?.capabilities).toMatchObject({ tunable: true, defaults: { steps: 50, guidance: 5 } });
    expect((await service.health()).ok).toBe(true);
    expect((await createBfl(instance('bfl', BASE, { apiKey: undefined }), deps(fakeFetch({}).fetch)).health()).ok).toBe(false);
  });
});
