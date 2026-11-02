import { describe, expect, it } from 'vitest';
import { sse, streamResponse } from '../../providers/__fixtures__/harness.ts';
import { HOSTED_DEFAULTS } from '../catalog.ts';
import { deps, events, fakeFetch, finishOf, imagesOf, INPUT, instance, jsonResponse, KEY, PNG_B64, request, stopped } from './__fixtures__/images.ts';
import { createChatImages } from './chat-images.ts';

const BASE = 'https://openrouter.ai/api';
const adapter = (fetch: Parameters<typeof deps>[0], models: string[] = []) => createChatImages(instance('chat-images', BASE, { preset: 'openrouter', models }), deps(fetch));
const aspect = { ...HOSTED_DEFAULTS, sizes: { kind: 'aspect' as const, ratios: ['1:1', '16:9'], classes: ['1K', '2K'] } };
const done = { created: 1, data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175, cost: 0.04 } };

describe('OpenRouter images route', () => {
  it('sends the Images API fields with attribution, and takes the cost it reports', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /api/v1/images': () => jsonResponse(done) });
    const out = await events(adapter(fetch).generate(request({ model: 'google/gemini-nano-banana-2.1', capabilities: aspect, aspectRatio: '16:9', sizeClass: '1K', count: 2, seed: 4, transparent: true })));
    expect(calls[0]?.body).toEqual({ model: 'google/gemini-nano-banana-2.1', prompt: 'a red lighthouse', n: 2, aspect_ratio: '16:9', resolution: '1K', seed: 4, background: 'transparent', output_format: 'png' });
    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'http-referer': 'https://atelierhq.dev', 'x-title': 'Atelier', 'x-openrouter-title': 'Atelier' });
    expect(imagesOf(out)).toHaveLength(1);
    expect(out).toContainEqual({ type: 'usage', costUsd: 0.04 });
  });

  it('sends input images as references', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /api/v1/images': () => jsonResponse(done) });
    await events(adapter(fetch).generate(request({ capabilities: aspect, references: [INPUT] })));
    expect(calls[0]?.body).toMatchObject({ input_references: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }] });
  });

  it('streams only one image at a time, which is all it allows', async () => {
    const stream = sse([{ event: 'image_generation.partial_image', data: { type: 'image_generation.partial_image', b64_json: PNG_B64 } }, { event: 'image_generation.completed', data: { type: 'image_generation.completed', b64_json: PNG_B64, usage: { cost: 0.02 } } }], true);
    const { fetch, calls } = fakeFetch({ 'POST /api/v1/images': (call) => ((call.body as { stream?: boolean }).stream ? streamResponse(stream) : jsonResponse(done)) });
    const service = adapter(fetch);
    const out = await events(service.generate(request({ capabilities: { ...aspect, previews: true } })));
    expect(out.map((e) => e.type)).toEqual(['preview', 'image', 'usage', 'finish']);
    await events(service.generate(request({ capabilities: { ...aspect, previews: true }, count: 2 })));
    expect(calls[1]?.body).not.toHaveProperty('stream');
  });

  it('reads a 403 for moderation as a refusal', async () => {
    const body = { error: { code: 403, message: 'Your input was flagged', metadata: { reasons: ['violence'], flagged_input: 'x' } } };
    const { fetch } = fakeFetch({ 'POST /api/v1/images': () => jsonResponse(body, 403) });
    expect(finishOf(await events(adapter(fetch).generate(request({ capabilities: aspect }))))).toMatchObject({ reason: 'refused', error: { code: 'provider_refused' } });
  });

  it('keeps 429 and 502 retryable, and stops when told to', async () => {
    const limited = fakeFetch({ 'POST /api/v1/images': () => jsonResponse({ error: { code: 429, message: 'Rate limited' } }, 429) });
    expect(finishOf(await events(adapter(limited.fetch).generate(request())))).toMatchObject({ error: { retryable: true } });
    const down = fakeFetch({ 'POST /api/v1/images': () => jsonResponse({ error: { code: 502, message: 'Model is down' } }, 502) });
    expect(finishOf(await events(adapter(down.fetch).generate(request())))).toMatchObject({ error: { retryable: true } });
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(request({ signal: stopped() })))).reason).toBe('aborted');
  });

  it('reports an answer with no image as an error', async () => {
    const { fetch } = fakeFetch({ 'POST /api/v1/images': () => jsonResponse({ data: [] }) });
    expect(finishOf(await events(adapter(fetch).generate(request()))).reason).toBe('error');
    const broken = fakeFetch({ 'POST /api/v1/images': () => new Response('<html>') });
    expect(finishOf(await events(adapter(broken.fetch).generate(request()))).reason).toBe('error');
  });
});

describe('OpenRouter chat route', () => {
  const chat = { ...aspect, family: 'chat-completions' };
  const reply = (message: unknown, finish_reason = 'stop') => ({ choices: [{ message, finish_reason }], usage: { cost: 0.01 } });

  it('asks for image and text, and reads message.images', async () => {
    const message = { role: 'assistant', content: 'Here it is.', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }] };
    const { fetch, calls } = fakeFetch({ 'POST /api/v1/chat/completions': () => jsonResponse(reply(message)) });
    const out = await events(adapter(fetch).generate(request({ model: 'openai/gpt-5-image', capabilities: chat, aspectRatio: '16:9', references: [INPUT] })));
    expect(calls[0]?.body).toMatchObject({ model: 'openai/gpt-5-image', modalities: ['image', 'text'], image_config: { aspect_ratio: '16:9' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'a red lighthouse' }, { type: 'image_url' }] }] });
    expect(imagesOf(out)[0]?.bytes).toBeDefined();
    expect(out).toContainEqual({ type: 'usage', costUsd: 0.01 });
  });

  it('passes on a hosted link as a link', async () => {
    const message = { images: [{ image_url: { url: 'https://cdn.example.com/a.png' } }] };
    const { fetch } = fakeFetch({ 'POST /api/v1/chat/completions': () => jsonResponse(reply(message)) });
    expect(imagesOf(await events(adapter(fetch).generate(request({ capabilities: chat }))))[0]?.url).toBe('https://cdn.example.com/a.png');
  });

  it('reads content_filter as a refusal, and words alone as no image', async () => {
    const filtered = fakeFetch({ 'POST /api/v1/chat/completions': () => jsonResponse(reply({ content: '' }, 'content_filter')) });
    expect(finishOf(await events(adapter(filtered.fetch).generate(request({ capabilities: chat })))).reason).toBe('refused');
    const words = fakeFetch({ 'POST /api/v1/chat/completions': () => jsonResponse(reply({ content: 'A lighthouse is a tower.' })) });
    expect(finishOf(await events(adapter(words.fetch).generate(request({ capabilities: chat }))))).toMatchObject({ reason: 'error', error: { message: expect.stringContaining('A lighthouse is a tower.') } });
  });
});

describe('OpenRouter models', () => {
  const direct = {
    data: [
      { id: 'sourceful/riverflow-v2.6-pro', name: 'Riverflow', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] }, supports_streaming: false, supported_parameters: { resolution: { type: 'enum', values: ['1K', '2K', '4K'] }, aspect_ratio: { type: 'enum', values: ['1:1', '16:9', 'auto'] }, n: { type: 'range', min: 1, max: 4 }, input_references: { type: 'range', min: 0, max: 10 }, background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] }, seed: { type: 'boolean' } } },
      { id: 'recraft/recraft-v4.1-vector', name: 'Vector', supported_parameters: {} },
      { id: 'openai/gpt-image-2', name: 'GPT Image 2', supports_streaming: true, supported_parameters: {} },
    ],
  };
  const listing = { data: [{ id: 'openai/gpt-image-2', name: 'GPT Image 2' }, { id: 'openai/gpt-5-image', name: 'GPT-5 Image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] } }] };

  it('reads capabilities from the image route, and marks models only chat can reach', async () => {
    const { fetch } = fakeFetch({ 'GET /api/v1/images/models': () => jsonResponse(direct), 'GET /api/v1/models?output_modalities=image': () => jsonResponse(listing) });
    const models = await adapter(fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['sourceful/riverflow-v2.6-pro', 'openai/gpt-image-2', 'openai/gpt-5-image']);
    expect(models[0]?.capabilities).toMatchObject({ sizes: { kind: 'aspect', ratios: ['1:1', '16:9'], classes: ['1K', '2K'] }, maxCount: 4, edit: true, maxReferences: 10, transparent: true, seed: true, previews: false });
    expect(models[1]?.capabilities).toMatchObject({ previews: true, sizes: { kind: 'fixed' } });
    expect(models[2]?.capabilities).toMatchObject({ family: 'chat-completions', edit: true });
  });

  it('keeps the image route’s models when the wider list fails', async () => {
    const { fetch } = fakeFetch({ 'GET /api/v1/images/models': () => jsonResponse(direct) });
    expect(await adapter(fetch).listModels()).toHaveLength(2);
  });
});
