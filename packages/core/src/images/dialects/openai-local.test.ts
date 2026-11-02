import { describe, expect, it } from 'vitest';
import { imagePreset } from '@atelier/protocol';
import { jsonResponse, type RecordedCall } from '../../providers/__fixtures__/harness.ts';
import { adapterDeps, drain, imageInstance, imageRequest, imagesOf, PNG, PNG_B64, pngOf } from '../__fixtures__/harness.ts';
import { createOpenAiImages } from './openai-images.ts';

const server = (preset: string) => imageInstance('openai-images', preset, imagePreset(preset)!.baseUrl);
const b64 = () => jsonResponse({ created: 1, data: [{ b64_json: PNG_B64 }] });
const bodyOf = (calls: RecordedCall[], path: string) => calls.find((c) => c.url.includes(path))?.body as Record<string, unknown>;

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
