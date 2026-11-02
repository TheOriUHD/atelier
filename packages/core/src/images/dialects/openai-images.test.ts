import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { sse, streamResponse } from '../../providers/__fixtures__/harness.ts';
import { HOSTED_DEFAULTS, lookUp, OPENAI_MODELS, RECRAFT_MODELS, TOGETHER_MODELS, XAI_MODELS } from '../catalog.ts';
import { fitParams } from '../params.ts';
import { deps, events, fakeFetch, finishOf, formFields, formFile, imagesOf, INPUT, instance, jsonResponse, keepingBodies, KEY, MASK, PNG_B64, request, stopped } from './__fixtures__/images.ts';
import { createOpenAiImages } from './openai-images.ts';

const OPENAI = 'https://api.openai.com';
const gpt = lookUp(OPENAI_MODELS, 'gpt-image-2.5-sunburst');
const quiet = { ...gpt, previews: false };
const b64 = { created: 1, data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 10, output_tokens: 1056, total_tokens: 1066 } };
const adapter = (fetch: Parameters<typeof deps>[0], preset = 'openai', baseUrl = OPENAI, models: string[] = []) => createOpenAiImages(instance('openai-images', baseUrl, { preset, models }), deps(fetch));

describe('OpenAI', () => {
  it('sends a GPT image model what the reference lists, and no response_format', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse(b64) });
    const out = await events(adapter(fetch).generate(request({ model: 'gpt-image-1.5', capabilities: quiet, width: 1536, height: 1024, quality: 'high', count: 2 })));
    expect(calls[0]?.body).toEqual({ model: 'gpt-image-1.5', prompt: 'a red lighthouse', n: 2, size: '1536x1024', quality: 'high' });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(imagesOf(out)).toHaveLength(1);
    expect(out).toContainEqual({ type: 'usage', input: 10, output: 1056 });
    expect(finishOf(out).reason).toBe('done');
  });

  it('streams partial images and the finished image', async () => {
    const stream = sse([
      { event: 'image_generation.partial_image', data: { type: 'image_generation.partial_image', b64_json: PNG_B64, partial_image_index: 0, output_format: 'png' } },
      { event: 'image_generation.completed', data: { type: 'image_generation.completed', b64_json: PNG_B64, usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } },
    ]);
    const { fetch, calls } = fakeFetch({ 'POST /v1/images/generations': () => streamResponse(stream) });
    const out = await events(adapter(fetch).generate(request({ model: 'gpt-image-2.5-sunburst', capabilities: gpt, width: 1024, height: 1024 })));
    expect(calls[0]?.body).toMatchObject({ stream: true, partial_images: 2 });
    expect(out.map((e) => e.type)).toEqual(['preview', 'image', 'usage', 'finish']);
  });

  it('streams an edit too, with the edit events, as multipart', async () => {
    const stream = sse([{ data: { type: 'image_edit.partial_image', b64_json: PNG_B64 } }, { data: { type: 'image_edit.completed', b64_json: PNG_B64 } }]);
    const fake = fakeFetch({ 'POST /v1/images/edits': () => streamResponse(stream) });
    const { fetch, bodies } = keepingBodies(fake.fetch);
    const out = await events(adapter(fetch).generate(request({ model: 'gpt-image-2', capabilities: gpt, references: [INPUT] })));
    expect(out.map((e) => e.type)).toEqual(['preview', 'image', 'finish']);
    expect(formFields(bodies[0]!)).toMatchObject({ stream: 'true', partial_images: '2', image: 'file:input.png' });
  });

  it('sends several inputs as image[] and the mask beside them', async () => {
    const fake = fakeFetch({ 'POST /v1/images/edits': () => jsonResponse(b64) });
    const { fetch, bodies } = keepingBodies(fake.fetch);
    await events(adapter(fetch).generate(request({ model: 'gpt-image-2', capabilities: quiet, references: [INPUT, { ...INPUT, name: 'two.png' }], mask: MASK })));
    expect(fake.calls[0]?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(formFields(bodies[0]!)).toMatchObject({ 'image[]': ['file:input.png', 'file:two.png'], mask: 'file:mask.png', model: 'gpt-image-2' });
  });

  it('marks the area to change by making it transparent, which is how OpenAI reads a mask', async () => {
    const fake = fakeFetch({ 'POST /v1/images/edits': () => jsonResponse(b64) });
    const { fetch, bodies } = keepingBodies(fake.fetch);
    await events(adapter(fetch).generate(request({ model: 'gpt-image-2', capabilities: quiet, references: [INPUT], mask: MASK })));
    const sent = PNG.sync.read(Buffer.from(formFile(bodies[0]!, 'mask')));
    // The left column changes (white in the internal mask), the right stays.
    const alpha = (x: number, y: number) => sent.data[(y * sent.width + x) * 4 + 3];
    expect([alpha(0, 0), alpha(1, 0), alpha(0, 1), alpha(1, 1)]).toEqual([0, 255, 0, 255]);
  });

  it('asks for transparency the way the reference says', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse(b64) });
    await events(adapter(fetch).generate(request({ capabilities: quiet, transparent: true })));
    expect(calls[0]?.body).toMatchObject({ background: 'transparent', output_format: 'png' });
  });

  it('never asks for a size outside what OpenAI allows', () => {
    const sizes = gpt.sizes.kind === 'fixed' ? gpt.sizes.list : [];
    expect(sizes.length).toBeGreaterThan(20);
    for (const { width, height } of sizes) {
      expect(width % 16, `${width}x${height}`).toBe(0);
      expect(height % 16, `${width}x${height}`).toBe(0);
      expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3);
      expect(width * height).toBeGreaterThanOrEqual(655_360);
      expect(width * height).toBeLessThanOrEqual(2560 * 1440);
    }
    expect(fitParams(gpt, { aspectRatio: '16:9', size: 'small' })).toMatchObject({ width: 1136, height: 640 });
    expect(fitParams(gpt, { aspectRatio: '1:1' })).toMatchObject({ width: 1024, height: 1024 });
  });

  it('turns moderation_blocked into a final refusal', async () => {
    const body = { error: { message: 'Your request was rejected.', type: 'image_generation_user_error', code: 'moderation_blocked' } };
    const { fetch } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse(body, 400) });
    expect(finishOf(await events(adapter(fetch).generate(request({ capabilities: quiet }))))).toMatchObject({ reason: 'refused', error: { code: 'provider_refused', retryable: false } });
  });

  it('turns a moderation error inside a stream into a refusal', async () => {
    const stream = sse([{ event: 'error', data: { type: 'error', error: { code: 'moderation_blocked', message: 'Rejected.' } } }]);
    const { fetch } = fakeFetch({ 'POST /v1/images/generations': () => streamResponse(stream) });
    expect(finishOf(await events(adapter(fetch).generate(request({ capabilities: gpt })))).reason).toBe('refused');
  });

  it('keeps rate limits and server errors retryable', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse({ error: { message: 'Rate limit reached for images per minute', code: 'rate_limit_exceeded' } }, 429) });
    expect(finishOf(await events(adapter(fetch).generate(request())))).toMatchObject({ reason: 'error', error: { code: 'provider_busy', retryable: true } });
    const down = fakeFetch({ 'POST /v1/images/generations': () => new Response('bad gateway', { status: 502 }) });
    expect(finishOf(await events(adapter(down.fetch).generate(request())))).toMatchObject({ error: { retryable: true } });
  });

  it('never reads a rate limit as a refusal, whatever it says', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse({ error: { message: 'Too many requests to the safety system' } }, 429) });
    expect(finishOf(await events(adapter(fetch).generate(request()))).reason).toBe('error');
  });

  it('stops when told to', async () => {
    const { fetch } = fakeFetch({});
    expect(finishOf(await events(adapter(fetch).generate(request({ signal: stopped() })))).reason).toBe('aborted');
  });

  it('reports an answer it cannot read, and one with no image, as errors', async () => {
    const broken = fakeFetch({ 'POST /v1/images/generations': () => new Response('<html>', { status: 200 }) });
    expect(finishOf(await events(adapter(broken.fetch).generate(request()))).reason).toBe('error');
    const empty = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse({ data: [] }) });
    expect(finishOf(await events(adapter(empty.fetch).generate(request()))).reason).toBe('error');
  });

  it('calls a stream that ends without its image truncated, so the service tries again', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/images/generations': () => streamResponse(sse([{ data: { type: 'image_generation.partial_image', b64_json: PNG_B64 } }])) });
    expect(finishOf(await events(adapter(fetch).generate(request({ capabilities: gpt }))))).toMatchObject({ error: { code: 'stream_truncated', retryable: true } });
  });

  it('lists its image models and leaves the rest out', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/models': () => jsonResponse({ data: [{ id: 'gpt-image-2.5-flare' }, { id: 'gpt-5.5' }, { id: 'omni-moderation-latest' }] }) });
    const models = await adapter(fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['gpt-image-2.5-flare']);
    expect(models[0]?.capabilities).toMatchObject({ family: 'gpt-image', maxCount: 10, maxReferences: 16 });
  });
});

describe('Azure', () => {
  const AZURE = 'https://example.openai.azure.com';
  it('goes by deployment name, with its header and api-version', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /openai/deployments/my%20images/images/generations': () => jsonResponse(b64) });
    await events(adapter(fetch, 'azure', AZURE).generate(request({ model: 'my images' })));
    expect(calls[0]?.url).toBe(`${AZURE}/openai/deployments/my%20images/images/generations?api-version=2025-04-01-preview`);
    expect(calls[0]?.headers['api-key']).toBe(KEY);
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('treats a deployment with any name as a GPT image model', async () => {
    const models = await adapter(fakeFetch({}).fetch, 'azure', AZURE, ['team-pictures']).listModels();
    expect(models[0]?.capabilities).toMatchObject({ family: 'gpt-image', edit: true, previews: false });
  });

  it('reads its content filter as a refusal', async () => {
    const body = { error: { code: 'contentFilter', message: 'Your task failed as a result of our safety system.' } };
    const { fetch } = fakeFetch({ 'POST /openai/deployments/m/images/generations': () => jsonResponse(body, 400) });
    expect(finishOf(await events(adapter(fetch, 'azure', AZURE).generate(request()))).reason).toBe('refused');
  });
});

describe('xAI', () => {
  const XAI = 'https://api.x.ai';
  const caps = lookUp(XAI_MODELS, 'grok-imagine-image-2.0');
  it('sends a ratio and a resolution, not a size, and takes the cost it reports', async () => {
    const body = { data: [{ b64_json: PNG_B64, mime_type: 'image/png' }], usage: { cost_in_usd_ticks: 400000000 } };
    const { fetch, calls } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse(body) });
    const out = await events(adapter(fetch, 'xai', XAI).generate(request({ model: 'grok-imagine-image-2.0', capabilities: caps, aspectRatio: '19.5:9', sizeClass: '2k', count: 2 })));
    expect(calls[0]?.body).toEqual({ model: 'grok-imagine-image-2.0', prompt: 'a red lighthouse', n: 2, aspect_ratio: '19.5:9', resolution: '2k', response_format: 'b64_json' });
    expect(out).toContainEqual({ type: 'usage', costUsd: 0.04 });
  });

  it('edits with JSON, one image or several', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/images/edits': () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }) });
    const service = adapter(fetch, 'xai', XAI);
    await events(service.generate(request({ capabilities: caps, references: [INPUT] })));
    expect(calls[0]?.body).toMatchObject({ image: { url: `data:image/png;base64,${PNG_B64}`, type: 'image_url' } });
    await events(service.generate(request({ capabilities: caps, references: [INPUT, INPUT] })));
    expect((calls[1]?.body as { images: unknown[] }).images).toHaveLength(2);
  });

  it('counts an image left out by moderation as a refusal', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse({ data: [{ respect_moderation: false }] }) });
    expect(finishOf(await events(adapter(fetch, 'xai', XAI).generate(request({ capabilities: caps })))).reason).toBe('refused');
  });

  it('keeps its video models out of the list', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/models': () => jsonResponse({ data: [{ id: 'grok-imagine-video-1.5' }, { id: 'grok-imagine-image-3.0' }] }) });
    const ids = (await adapter(fetch, 'xai', XAI).listModels()).map((m) => m.modelId);
    expect(ids).toContain('grok-imagine-image-3.0');
    expect(ids).not.toContain('grok-imagine-video-1.5');
  });

  it('shows its known models even when its list fails', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/models': () => jsonResponse({}, 500) });
    expect((await adapter(fetch, 'xai', XAI).listModels()).map((m) => m.modelId)).toContain('grok-imagine-image-2.0');
  });
});

describe('Together', () => {
  const TOGETHER = 'https://api.together.xyz';
  const caps = lookUp(TOGETHER_MODELS, 'black-forest-labs/FLUX.1-schnell');
  it('sends width and height rather than size, and asks for base64 its own way', async () => {
    const body = { id: 'x', model: 'm', object: 'list', data: [{ index: 0, b64_json: PNG_B64, type: 'b64_json' }] };
    const { fetch, calls } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse(body) });
    const out = await events(adapter(fetch, 'together', TOGETHER).generate(request({ model: 'black-forest-labs/FLUX.1-schnell', capabilities: caps, width: 1024, height: 768, seed: 7, count: 2, negativePrompt: 'fog', tuning: { steps: 4, guidance: 3 } })));
    expect(calls[0]?.body).toEqual({ model: 'black-forest-labs/FLUX.1-schnell', prompt: 'a red lighthouse', n: 2, width: 1024, height: 768, negative_prompt: 'fog', seed: 7, steps: 4, guidance_scale: 3, response_format: 'base64', output_format: 'png' });
    expect(imagesOf(out)).toHaveLength(1);
  });

  it('puts input images in the field each model family takes', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }) });
    const service = adapter(fetch, 'together', TOGETHER);
    await events(service.generate(request({ model: 'black-forest-labs/FLUX.1-kontext-pro', capabilities: caps, references: [INPUT] })));
    expect(calls[0]?.body).toMatchObject({ image_url: `data:image/png;base64,${PNG_B64}` });
    await events(service.generate(request({ model: 'black-forest-labs/FLUX.2-dev', capabilities: caps, references: [INPUT] })));
    expect(calls[1]?.body).toMatchObject({ reference_images: [`data:image/png;base64,${PNG_B64}`] });
  });

  it('reads its bare list of models by type', async () => {
    const list = [{ id: 'black-forest-labs/FLUX.1-schnell', type: 'image', display_name: 'FLUX.1 Schnell' }, { id: 'meta-llama/flux-of-words', type: 'chat' }];
    const { fetch } = fakeFetch({ 'GET /v1/models': () => jsonResponse(list) });
    const models = await adapter(fetch, 'together', TOGETHER).listModels();
    expect(models.map((m) => m.displayName)).toEqual(['FLUX.1 Schnell']);
    expect(models[0]?.capabilities.defaults).toEqual({ steps: 4 });
  });
});

describe('Recraft', () => {
  const RECRAFT = 'https://external.api.recraft.ai';
  const caps = lookUp(RECRAFT_MODELS, 'recraftv3');
  it('words its request its own way', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }) });
    await events(adapter(fetch, 'recraft', RECRAFT).generate(request({ model: 'recraftv3', capabilities: caps, aspectRatio: '16:9', seed: 3, negativePrompt: 'fog' })));
    expect(calls[0]?.body).toEqual({ model: 'recraftv3', prompt: 'a red lighthouse', size: '16:9', negative_prompt: 'fog', random_seed: 3, response_format: 'b64_json', image_format: 'png' });
  });

  it('lists what it knows, with no vector model among them', async () => {
    const service = adapter(fakeFetch({}).fetch, 'recraft', RECRAFT);
    const models = await service.listModels();
    expect(models.map((m) => m.modelId)).toContain('recraftv4_1');
    expect(models.some((m) => m.modelId.includes('vector'))).toBe(false);
    expect((await service.health()).ok).toBe(true);
  });
});

describe('servers that copy OpenAI', () => {
  it('asks them for base64, and folds a negative prompt in for LocalAI', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/images/generations': () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }) });
    await events(adapter(fetch, 'localai', 'http://127.0.0.1:8080').generate(request({ capabilities: HOSTED_DEFAULTS, negativePrompt: 'fog', width: 512, height: 512 })));
    expect(calls[0]?.body).toEqual({ model: 'm', prompt: 'a red lighthouse|fog', size: '512x512', response_format: 'b64_json' });
  });

  it('fetches a local server’s own file itself, with the key, and leaves other hosts to the service', async () => {
    const base = 'http://127.0.0.1:8080';
    const { fetch, calls } = fakeFetch({
      'POST /v1/images/generations': () => jsonResponse({ data: [{ url: `${base}/files/a.png` }, { url: 'https://cdn.example.com/b.png' }] }),
      'GET /files/a.png': () => new Response(new Uint8Array([1, 2, 3])),
    });
    const out = await events(adapter(fetch, 'localai', base).generate(request()));
    expect(imagesOf(out).map((e) => e.url ?? 'bytes')).toEqual(['bytes', 'https://cdn.example.com/b.png']);
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});
