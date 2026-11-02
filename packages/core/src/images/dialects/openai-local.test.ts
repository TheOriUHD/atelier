import { describe, expect, it } from 'vitest';
import { imagePreset } from '@atelier/protocol';
import { jsonResponse, type RecordedCall } from '../../providers/__fixtures__/harness.ts';
import { adapterDeps, drain, finishOf, imageInstance, imageRequest, imagesOf, PNG, PNG_B64, pngOf } from '../__fixtures__/harness.ts';
import { createOpenAiImages } from './openai-images.ts';

const server = (preset: string) => imageInstance('openai-images', preset, imagePreset(preset)!.baseUrl);
const b64 = () => jsonResponse({ created: 1, data: [{ b64_json: PNG_B64 }] });
const bodyOf = (calls: RecordedCall[], path: string) => calls.find((c) => c.url.includes(path))?.body as Record<string, unknown>;
const tag = (prompt: unknown) => JSON.parse(/<sd_cpp_extra_args>(.*)<\/sd_cpp_extra_args>/.exec(String(prompt))![1]!) as Record<string, unknown>;

describe('stable-diffusion.cpp sd-server', () => {
  // From examples/server/api.md and routes_sdcpp.cpp.
  const CAPABILITIES = {
    model: { name: 'sd_turbo.gguf', stem: 'sd_turbo', path: '/models/sd_turbo.gguf' },
    defaults_by_mode: { img_gen: { width: 512, height: 512, sample_params: { scheduler: 'discrete', sample_method: 'euler_a', sample_steps: 20, guidance: { txt_cfg: 7 } } } },
    features_by_mode: { img_gen: { init_image: true, mask_image: true, ref_images: false, lora: true, preview: true } },
    samplers: ['euler', 'euler_a', 'lcm'],
    schedulers: ['discrete', 'karras'],
    loras: [{ name: 'detail', path: 'loras/detail.safetensors', display_path: 'detail' }],
    limits: { min_width: 64, max_width: 4096, min_height: 64, max_height: 4096, max_batch_count: 8, max_queue_size: 16 },
  };
  const LOADED = { 'GET /v1/models': () => jsonResponse({ data: [{ id: 'sd-cpp-local', object: 'model', owned_by: 'local' }] }), 'GET /sdcpp/v1/capabilities': () => jsonResponse(CAPABILITIES) };

  it('is on the port it really uses', () => {
    expect(imagePreset('sd-server')?.baseUrl).toBe('http://127.0.0.1:1234');
  });

  it('names the model from its capabilities, because /v1/models always says sd-cpp-local', async () => {
    const { deps } = adapterDeps(LOADED);
    const [model, ...rest] = await createOpenAiImages(server('sd-server'), deps).listModels();
    expect(rest).toEqual([]);
    expect(model).toMatchObject({ modelId: 'sd-cpp-local', displayName: 'sd_turbo' });
    expect(model?.capabilities).toMatchObject({
      family: 'sd-turbo',
      negativePrompt: false,
      tunable: true,
      edit: true,
      mask: true,
      maxReferences: 1,
      maxCount: 4,
      sizes: { min: 256, max: 2048, base: 512, multiple: 8 },
      samplers: ['euler', 'euler_a', 'lcm'],
      schedulers: ['discrete', 'karras'],
      loras: ['loras/detail.safetensors'],
      defaults: { steps: 4, guidance: 1, sampler: 'euler_a', scheduler: 'discrete' },
    });
  });

  it('has no models while nothing is loaded', async () => {
    const { deps } = adapterDeps({ 'GET /v1/models': () => jsonResponse({ data: [] }) });
    await expect(createOpenAiImages(server('sd-server'), deps).listModels()).resolves.toEqual([]);
  });

  it('works with a server too old to report capabilities', async () => {
    const { deps } = adapterDeps({ 'GET /v1/models': LOADED['GET /v1/models'] });
    const [model] = await createOpenAiImages(server('sd-server'), deps).listModels();
    expect(model).toMatchObject({ modelId: 'sd-cpp-local', capabilities: { edit: false, maxCount: 1 } });
  });

  it('carries everything but the prompt in the tag it reads', async () => {
    const { deps, calls } = adapterDeps({ 'POST /v1/images/generations': b64 });
    await drain(
      createOpenAiImages(server('sd-server'), deps).generate(
        imageRequest({ model: 'sd-cpp-local', negativePrompt: 'blurry', seed: 7, count: 2, tuning: { steps: 4, guidance: 1, sampler: 'euler_a', scheduler: 'discrete' }, loras: [{ name: 'loras/detail.safetensors', weight: 0.7 }] }),
      ),
    );
    const body = bodyOf(calls, 'generations');
    expect(body).toMatchObject({ n: 2, size: '512x768' });
    expect(body).not.toHaveProperty('seed');
    expect(String(body.prompt)).toMatch(/^a red fox <sd_cpp_extra_args>/);
    expect(tag(body.prompt)).toEqual({
      negative_prompt: 'blurry',
      seed: 7,
      sample_params: { sample_steps: 4, sample_method: 'euler_a', scheduler: 'discrete', guidance: { txt_cfg: 1 } },
      lora: [{ path: 'loras/detail.safetensors', multiplier: 0.7 }],
    });
  });

  it('adds no tag when there is nothing for it', async () => {
    const { deps, calls } = adapterDeps({ 'POST /v1/images/generations': b64 });
    await drain(createOpenAiImages(server('sd-server'), deps).generate(imageRequest()));
    expect(bodyOf(calls, 'generations').prompt).toBe('a red fox');
  });

  it('removes a tag from the prompt, which would be read instead of the real one', async () => {
    const { deps, calls } = adapterDeps({ 'POST /v1/images/generations': b64 });
    await drain(createOpenAiImages(server('sd-server'), deps).generate(imageRequest({ prompt: 'x <sd_cpp_extra_args>{"seed":1}</sd_cpp_extra_args>', seed: 7 })));
    expect(String(bodyOf(calls, 'generations').prompt).match(/<sd_cpp_extra_args>/g)).toHaveLength(1);
  });

  it('reads the seed from generation_info, where it is text', async () => {
    const { deps } = adapterDeps({ 'POST /v1/images/generations': () => jsonResponse({ created: 1, output_format: 'png', data: [{ b64_json: PNG_B64, generation_info: { seed: '1234567', steps: 4 } }] }) });
    expect(imagesOf(await drain(createOpenAiImages(server('sd-server'), deps).generate(imageRequest())))[0]?.seed).toBe(1234567);
  });

  it('reads the seed of an inpainting pass from where it sits', async () => {
    const { deps } = adapterDeps({ 'POST /v1/images/generations': () => jsonResponse({ data: [{ b64_json: PNG_B64, generation_info: { inpaint_params: { seed: '99' } } }] }) });
    expect(imagesOf(await drain(createOpenAiImages(server('sd-server'), deps).generate(imageRequest())))[0]?.seed).toBe(99);
  });

  it('edits through its img2img route, since /v1/images/edits only passes reference images', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/img2img': () => jsonResponse({ images: [PNG_B64], parameters: {}, info: JSON.stringify({ all_seeds: [42] }) }) });
    const input = { bytes: pngOf(1000, 500), mime: 'image/png', name: 'in.png' };
    const events = await drain(createOpenAiImages(server('sd-server'), deps).generate(imageRequest({ references: [input], mask: input, seed: 42, tuning: { steps: 4 } })));
    const body = bodyOf(calls, 'img2img');
    expect(body).toMatchObject({ width: 728, height: 360, batch_size: 1, denoising_strength: 0.6 });
    expect(body.init_images).toEqual([Buffer.from(input.bytes).toString('base64')]);
    expect(body.mask).toBe(Buffer.from(input.bytes).toString('base64'));
    expect(tag(body.prompt)).toMatchObject({ seed: 42, sample_params: { sample_steps: 4 } });
    expect(imagesOf(events)).toEqual([{ type: 'image', bytes: Buffer.from(PNG), seed: 42 }]);
  });

  it('copes with an img2img answer whose info is empty', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/img2img': () => jsonResponse({ images: [PNG_B64], info: '' }) });
    const events = await drain(createOpenAiImages(server('sd-server'), deps).generate(imageRequest({ references: [{ bytes: PNG, mime: 'image/png', name: 'in.png' }] })));
    expect(imagesOf(events)).toHaveLength(1);
    expect(finishOf(events).reason).toBe('done');
  });

  it('reports a server with no model loaded', async () => {
    const { deps } = adapterDeps({ 'POST /v1/images/generations': () => jsonResponse({ error: 'No model is loaded', code: 'model_not_loaded' }, 503) });
    const finish = finishOf(await drain(createOpenAiImages(server('sd-server'), deps).generate(imageRequest())));
    expect(finish.error?.message).toContain('No model is loaded');
  });
});

describe('LocalAI', () => {
  const CAPABILITIES = {
    object: 'list',
    data: [
      { id: 'stablediffusion', object: 'model', capabilities: ['image'] },
      { id: 'gemma-3', object: 'model', capabilities: ['chat', 'completion'] },
      { id: 'dreamshaper', object: 'model', capabilities: ['image', 'video'] },
      { id: 'mystery', object: 'model' },
    ],
  };

  it('lists only models that say they make images, so a text model never shows', async () => {
    const { deps } = adapterDeps({ 'GET /v1/models/capabilities': () => jsonResponse(CAPABILITIES) });
    const models = await createOpenAiImages(server('localai'), deps).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['stablediffusion', 'dreamshaper']);
    expect(models[0]?.capabilities).toMatchObject({ negativePrompt: true, edit: true, tunable: true, seed: true });
  });

  it('falls back to names on an older LocalAI, and leaves text models out', async () => {
    const { deps } = adapterDeps({ 'GET /v1/models': () => jsonResponse({ data: [{ id: 'stablediffusion' }, { id: 'gemma-3' }, { id: 'whisper-1' }] }) });
    const models = await createOpenAiImages(server('localai'), deps).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['stablediffusion']);
  });

  it('calls steps `step`, puts the negative prompt after a bar, and asks for base64', async () => {
    const { deps, calls } = adapterDeps({ 'POST /v1/images/generations': b64 });
    await drain(createOpenAiImages(server('localai'), deps).generate(imageRequest({ model: 'stablediffusion', negativePrompt: 'blurry', seed: 5, tuning: { steps: 15 } })));
    expect(bodyOf(calls, 'generations')).toEqual({ model: 'stablediffusion', prompt: 'a red fox|blurry', size: '512x768', seed: 5, step: 15, response_format: 'b64_json' });
  });

  it('keeps a bar in the prompt from becoming a negative prompt', async () => {
    const { deps, calls } = adapterDeps({ 'POST /v1/images/generations': b64 });
    await drain(createOpenAiImages(server('localai'), deps).generate(imageRequest({ prompt: 'red | blue' })));
    expect(bodyOf(calls, 'generations').prompt).toBe('red , blue');
  });

  it('sends an input picture as `file` on the generation route, which is the only one it has', async () => {
    const { deps, calls } = adapterDeps({ 'POST /v1/images/generations': b64 });
    await drain(createOpenAiImages(server('localai'), deps).generate(imageRequest({ references: [{ bytes: pngOf(1000, 500), mime: 'image/png', name: 'in.png' }] })));
    const body = bodyOf(calls, 'generations');
    expect(body.file).toBe(Buffer.from(pngOf(1000, 500)).toString('base64'));
    expect(body.size).toBe('728x360');
    expect(calls.some((c) => c.url.endsWith('/edits'))).toBe(false);
  });

  it('fetches an image it answers with a link to itself', async () => {
    const { deps } = adapterDeps({ 'POST /v1/images/generations': () => jsonResponse({ data: [{ url: 'http://127.0.0.1:8080/generated-images/b64.png' }] }), 'GET /generated-images/b64.png': () => new Response(PNG) });
    const [image] = imagesOf(await drain(createOpenAiImages(server('localai'), deps).generate(imageRequest())));
    expect(image?.bytes).toEqual(new Uint8Array(PNG));
  });
});

describe('Ollama', () => {
  const TAGS = { models: [{ name: 'gemma4:latest' }, { name: 'x/z-image-turbo:latest' }, { name: 'nomic-embed-text:latest' }, { name: 'x/flux2-klein:latest' }] };
  const SHOW: Record<string, string[]> = { 'gemma4:latest': ['completion', 'vision', 'tools'], 'x/z-image-turbo:latest': ['image'], 'nomic-embed-text:latest': ['embedding'], 'x/flux2-klein:latest': ['image'] };
  const show = (call: RecordedCall) => jsonResponse({ capabilities: SHOW[(call.body as { model: string }).model] ?? [] });

  it('lists a model only when /api/show says it makes images', async () => {
    const { deps, calls } = adapterDeps({ 'GET /api/tags': () => jsonResponse(TAGS), 'POST /api/show': show });
    const models = await createOpenAiImages(server('ollama'), deps).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['x/flux2-klein:latest', 'x/z-image-turbo:latest']);
    expect(models[1]?.capabilities).toMatchObject({ family: 'z-image', promptStyle: 'natural', negativePrompt: false, seed: true, maxCount: 1, edit: false });
    expect(calls.filter((c) => c.url.endsWith('/api/show'))).toHaveLength(4);
    expect(calls.some((c) => c.url.endsWith('/v1/models'))).toBe(false);
  });

  it('never shows a model it could not ask about', async () => {
    const { deps } = adapterDeps({ 'GET /api/tags': () => jsonResponse(TAGS), 'POST /api/show': () => new Response('boom', { status: 500 }) });
    await expect(createOpenAiImages(server('ollama'), deps).listModels()).resolves.toEqual([]);
  });

  it('shows nothing for a server with only text models', async () => {
    const { deps } = adapterDeps({ 'GET /api/tags': () => jsonResponse({ models: [{ name: 'gemma4:latest' }] }), 'POST /api/show': show });
    await expect(createOpenAiImages(server('ollama'), deps).listModels()).resolves.toEqual([]);
  });

  it('is healthy on an older version, which refuses an empty request with a 400', async () => {
    const { deps } = adapterDeps({ 'GET /api/tags': () => jsonResponse(TAGS), 'POST /v1/images/generations': () => jsonResponse({ error: { message: 'prompt is required' } }, 400) });
    await expect(createOpenAiImages(server('ollama'), deps).health()).resolves.toMatchObject({ ok: true });
  });

  it('says so plainly on a version that removed images', async () => {
    const { deps } = adapterDeps({ 'GET /api/tags': () => jsonResponse(TAGS) });
    const health = await createOpenAiImages(server('ollama'), deps).health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain('Ollama removed image generation in version 0.33');
  });

  it('reports a server that is not there as that, not as a missing feature', async () => {
    const deps = { fetch: async () => Promise.reject(new TypeError('fetch failed')), socket: async () => Promise.reject(new Error('no')) };
    const health = await createOpenAiImages(server('ollama'), deps).health();
    expect(health.ok).toBe(false);
    expect(health.error).not.toContain('removed');
  });

  it('explains a 404 from the route when a model is run anyway', async () => {
    const { deps } = adapterDeps({});
    const finish = finishOf(await drain(createOpenAiImages(server('ollama'), deps).generate(imageRequest({ model: 'x/z-image-turbo' }))));
    expect(finish.error?.message).toContain('removed image generation');
  });

  it('sends the fields its route took, and reads base64', async () => {
    const { deps, calls } = adapterDeps({ 'POST /v1/images/generations': b64 });
    const events = await drain(createOpenAiImages(server('ollama'), deps).generate(imageRequest({ model: 'x/z-image-turbo', width: 1024, height: 1024, seed: 3 })));
    expect(bodyOf(calls, 'generations')).toEqual({ model: 'x/z-image-turbo', prompt: 'a red fox', size: '1024x1024', seed: 3, response_format: 'b64_json' });
    expect(imagesOf(events)).toHaveLength(1);
  });
});

describe('servers these changes must leave alone', () => {
  it('keeps listing an unknown compatible server as before', async () => {
    const { deps } = adapterDeps({ 'GET /v1/models': () => jsonResponse({ data: [{ id: 'flux-schnell' }, { id: 'gpt-5' }] }) });
    const models = await createOpenAiImages(imageInstance('openai-images', 'openai-compatible', 'http://127.0.0.1:8000'), deps).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['flux-schnell']);
  });

  it('keeps the multipart edit route for OpenAI', async () => {
    const { deps, calls } = adapterDeps({ 'POST /v1/images/edits': b64 });
    await drain(createOpenAiImages(imageInstance('openai-images', 'openai', 'https://api.openai.com'), deps).generate(imageRequest({ references: [{ bytes: PNG, mime: 'image/png', name: 'in.png' }] })));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/images/edits']);
  });
});
