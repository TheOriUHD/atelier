import { describe, expect, it } from 'vitest';
import { HUGGINGFACE_CAPABILITIES } from '../catalog.ts';
import { deps, events, fakeFetch, finishOf, imagesOf, instance, jsonResponse, KEY, PNG, PNG_B64, request, stopped } from './__fixtures__/images.ts';
import { createHuggingFace } from './huggingface.ts';

const ROUTER = 'https://router.huggingface.co';
const adapter = (fetch: Parameters<typeof deps>[0], models: string[] = []) => createHuggingFace(instance('huggingface', ROUTER, { models }), deps(fetch), { pollMs: 0 });
const generate = (over = {}) => request({ model: 'org/model', capabilities: HUGGINGFACE_CAPABILITIES, width: 1024, height: 768, ...over });
const HUB = 'GET /api/models/org/model';
const served = (mapping: Record<string, unknown>) => () => jsonResponse({ id: 'org/model', inferenceProviderMapping: mapping });
const live = (providerId: string, task = 'text-to-image') => ({ status: 'live', providerId, task, isModelAuthor: false });

describe('Hugging Face', () => {
  it('takes raw bytes back from HF Inference, with the settings in `parameters`', async () => {
    const { fetch, calls } = fakeFetch({ [HUB]: served({ 'hf-inference': live('org/model') }), 'POST /hf-inference/models/org/model': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }) });
    const out = await events(adapter(fetch).generate(generate({ negativePrompt: 'fog', seed: 7, tuning: { steps: 20, guidance: 3.5 } })));
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[1]?.body).toEqual({ inputs: 'a red lighthouse', parameters: { width: 1024, height: 768, negative_prompt: 'fog', seed: 7, num_inference_steps: 20, guidance_scale: 3.5 } });
    expect(imagesOf(out)[0]?.bytes).toEqual(PNG);
    expect(finishOf(out).reason).toBe('done');
  });

  it('reads the JSON some of its models answer with', async () => {
    const { fetch } = fakeFetch({ [HUB]: served({ 'hf-inference': live('org/model') }), 'POST /hf-inference/models/org/model': () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }) });
    expect(imagesOf(await events(adapter(fetch).generate(generate())))).toHaveLength(1);
  });

  it.each([['together', 'base64'], ['nscale', 'b64_json']])('asks %s for %s through the router', async (provider, format) => {
    const { fetch, calls } = fakeFetch({ [HUB]: served({ [provider]: live('Org/Model-Turbo') }), [`POST /${provider}/v1/images/generations`]: () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }) });
    const out = await events(adapter(fetch).generate(generate()));
    expect(calls[1]?.body).toMatchObject({ model: 'Org/Model-Turbo', prompt: 'a red lighthouse', response_format: format, width: 1024, height: 768 });
    expect(imagesOf(out)).toHaveLength(1);
  });

  it('goes through Replicate’s route, and links stay links', async () => {
    const { fetch, calls } = fakeFetch({ [HUB]: served({ replicate: live('black-forest-labs/flux-dev') }), 'POST /replicate/v1/models/black-forest-labs/flux-dev/predictions': () => jsonResponse({ output: ['https://replicate.delivery/a.png'] }) });
    const out = await events(adapter(fetch).generate(generate()));
    expect(calls[1]?.headers.prefer).toBe('wait');
    expect(calls[1]?.body).toEqual({ input: { prompt: 'a red lighthouse', width: 1024, height: 768 } });
    expect(imagesOf(out)[0]?.url).toBe('https://replicate.delivery/a.png');
  });

  it('names a community model on Replicate by its version', async () => {
    const { fetch, calls } = fakeFetch({ [HUB]: served({ replicate: live('someone/model:abc123') }), 'POST /replicate/v1/predictions': () => jsonResponse({ output: 'https://replicate.delivery/a.png' }) });
    await events(adapter(fetch).generate(generate()));
    expect(calls[1]?.body).toEqual({ input: { prompt: 'a red lighthouse', width: 1024, height: 768 }, version: 'abc123' });
  });

  it('asks again later when Replicate hasn’t finished by the end of the wait', async () => {
    const { fetch } = fakeFetch({ [HUB]: served({ replicate: live('o/m') }), 'POST /replicate/v1/models/o/m/predictions': () => jsonResponse({ status: 'processing', output: null }) });
    expect(finishOf(await events(adapter(fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { code: 'provider_timeout', retryable: true } });
  });

  it('follows fal’s queue through the router, by the path it answered with', async () => {
    const path = '/fal-ai/flux/requests/abc';
    let polls = 0;
    const { fetch, calls } = fakeFetch({
      [HUB]: served({ 'fal-ai': live('fal-ai/flux/dev') }),
      'POST /fal-ai/fal-ai/flux/dev': () => jsonResponse({ request_id: 'abc', status: 'IN_QUEUE', response_url: `https://queue.fal.run${path}` }),
      [`GET /fal-ai${path}/status`]: () => jsonResponse({ status: ++polls < 2 ? 'IN_PROGRESS' : 'COMPLETED' }),
      [`GET /fal-ai${path}`]: () => jsonResponse({ images: [{ url: 'https://v3.fal.media/a.png' }] }),
    });
    const out = await events(adapter(fetch).generate(generate()));
    expect(calls[1]?.url).toBe(`${ROUTER}/fal-ai/fal-ai/flux/dev?_subdomain=queue`);
    expect(calls[2]?.url).toBe(`${ROUTER}/fal-ai${path}/status?_subdomain=queue`);
    expect(imagesOf(out)[0]?.url).toBe('https://v3.fal.media/a.png');
    expect(finishOf(out).reason).toBe('done');
  });

  it('picks the fastest provider it can speak to, and obeys one named in the model id', async () => {
    const both = { replicate: live('o/m'), 'hf-inference': live('org/model') };
    const auto = fakeFetch({ [HUB]: served(both), 'POST /hf-inference/models/org/model': () => new Response(PNG) });
    await events(adapter(auto.fetch).generate(generate()));
    expect(auto.calls[1]?.url).toContain('/hf-inference/');
    const named = fakeFetch({ [HUB]: served(both), 'POST /replicate/v1/models/o/m/predictions': () => jsonResponse({ output: 'https://replicate.delivery/a.png' }) });
    await events(adapter(named.fetch).generate(generate({ model: 'org/model:replicate' })));
    expect(named.calls[1]?.url).toContain('/replicate/');
  });

  it('says who does serve a model it can’t reach', async () => {
    const elsewhere = fakeFetch({ [HUB]: served({ wavespeed: live('w/m'), deepinfra: { status: 'error', providerId: 'x' } }) });
    expect(finishOf(await events(adapter(elsewhere.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { message: expect.stringContaining('wavespeed') } });
    const nobody = fakeFetch({ [HUB]: served({}) });
    expect(finishOf(await events(adapter(nobody.fetch).generate(generate())))).toMatchObject({ error: { message: expect.stringContaining('No provider') } });
    const unknown = fakeFetch({ [HUB]: () => jsonResponse({}, 404) });
    expect(finishOf(await events(adapter(unknown.fetch).generate(generate()))).reason).toBe('error');
  });

  it('reads a safety block as a refusal, and keeps 429 and 503 retryable', async () => {
    const blocked = fakeFetch({ [HUB]: served({ 'hf-inference': live('org/model') }), 'POST /hf-inference/models/org/model': () => jsonResponse({ error: 'The prompt was flagged by the safety checker.' }, 400) });
    expect(finishOf(await events(adapter(blocked.fetch).generate(generate()))).reason).toBe('refused');
    const limited = fakeFetch({ [HUB]: served({ 'hf-inference': live('org/model') }), 'POST /hf-inference/models/org/model': () => jsonResponse({ error: 'Too many requests' }, 429) });
    expect(finishOf(await events(adapter(limited.fetch).generate(generate())))).toMatchObject({ error: { retryable: true } });
    const loading = fakeFetch({ [HUB]: served({ 'hf-inference': live('org/model') }), 'POST /hf-inference/models/org/model': () => jsonResponse({ error: 'Model is loading', estimated_time: 20 }, 503) });
    expect(finishOf(await events(adapter(loading.fetch).generate(generate())))).toMatchObject({ error: { retryable: true } });
  });

  it('stops when told to, mid-queue too', async () => {
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(generate({ signal: stopped() })))).reason).toBe('aborted');
    const controller = new AbortController();
    const { fetch } = fakeFetch({
      [HUB]: served({ 'fal-ai': live('fal-ai/flux/dev') }),
      'POST /fal-ai/fal-ai/flux/dev': () => jsonResponse({ response_url: 'https://queue.fal.run/fal-ai/flux/requests/abc' }),
      'GET /fal-ai/fal-ai/flux/requests/abc/status': () => {
        controller.abort();
        return jsonResponse({ status: 'IN_QUEUE' });
      },
    });
    expect(finishOf(await events(adapter(fetch).generate(generate({ signal: controller.signal })))).reason).toBe('aborted');
  });

  it('reports an answer it cannot use', async () => {
    const empty = fakeFetch({ [HUB]: served({ together: live('t/m') }), 'POST /together/v1/images/generations': () => jsonResponse({ data: [] }) });
    expect(finishOf(await events(adapter(empty.fetch).generate(generate()))).reason).toBe('error');
  });

  it('lists what was typed in and what its providers serve, asking the Hub without the key', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /api/models': () => jsonResponse([{ id: 'black-forest-labs/FLUX.1-schnell' }, { id: 'org/model' }]) });
    const models = await adapter(fetch, ['org/model']).listModels();
    expect(models.map((m) => [m.modelId, m.source])).toEqual([['org/model', 'default'], ['black-forest-labs/FLUX.1-schnell', 'detected']]);
    expect(calls[0]?.url).toContain('pipeline_tag=text-to-image');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });
});
