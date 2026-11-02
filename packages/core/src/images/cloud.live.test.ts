/**
 * One small real image from each cloud service. Each costs real money, so each is skipped unless its key is set in the
 * environment:
 *   ATELIER_LIVE_<SERVICE>_KEY    the service's API key
 *   ATELIER_LIVE_<SERVICE>_MODEL  optional, instead of the model named below
 *   ATELIER_LIVE_<SERVICE>_URL    optional, instead of the preset's address (Azure needs it)
 * ChatGPT Plan: ATELIER_LIVE_CHATGPT_KEY=<access token>:<account id>. Bedrock: an API key, or ACCESS_KEY:SECRET.
 * Keys are only passed to the adapters; nothing here prints them.
 */
import { describe, expect, it } from 'vitest';
import { imagePreset } from '@atelier/protocol';
import { checkImage, downloadImage } from './download.ts';
import { createImageAdapter } from './index.ts';
import { fitParams } from './params.ts';
import type { ImageAdapterDeps, ImageEvent, ImageRequest } from './types.ts';

interface Service {
  name: string;
  preset: string;
  model: string;
}

const SERVICES: Service[] = [
  { name: 'OPENAI', preset: 'openai', model: 'gpt-image-2.5-flare' },
  { name: 'AZURE', preset: 'azure', model: 'gpt-image-2' },
  { name: 'XAI', preset: 'xai', model: 'grok-imagine-image' },
  { name: 'TOGETHER', preset: 'together', model: 'black-forest-labs/FLUX.1-schnell' },
  { name: 'RECRAFT', preset: 'recraft', model: 'recraftv4_1_flash' },
  { name: 'GEMINI', preset: 'gemini', model: 'gemini-3.1-flash-lite-image' },
  { name: 'VERTEX', preset: 'vertex', model: 'gemini-2.5-flash-image' },
  { name: 'OPENROUTER', preset: 'openrouter', model: 'google/gemini-3.1-flash-lite-image' },
  { name: 'CHATGPT', preset: 'chatgpt', model: 'chatgpt-plan-image' },
  { name: 'BFL', preset: 'bfl', model: 'flux-2-klein-4b' },
  { name: 'STABILITY', preset: 'stability', model: 'stable-image-core' },
  { name: 'FAL', preset: 'fal', model: 'fal-ai/flux/schnell' },
  { name: 'REPLICATE', preset: 'replicate', model: 'black-forest-labs/flux-schnell' },
  { name: 'HUGGINGFACE', preset: 'huggingface', model: 'black-forest-labs/FLUX.1-schnell' },
  { name: 'IDEOGRAM', preset: 'ideogram', model: 'ideogram-4' },
  { name: 'BEDROCK', preset: 'bedrock', model: 'stability.stable-image-core-v1:1' },
];

const env = (name: string) => process.env[name] || undefined;

function depsFor(service: Service, key: string): ImageAdapterDeps {
  const [accessToken = '', accountId = ''] = key.split(':');
  return {
    fetch: (url, init) => fetch(url, init),
    socket: () => Promise.reject(new Error('Not used by cloud services.')),
    ...(service.name === 'CHATGPT' ? { chatgpt: { credentials: async () => ({ accessToken, accountId, installationId: 'atelier-live-test' }), observe: () => undefined } } : {}),
  };
}

describe.each(SERVICES)('$name', (service) => {
  const key = env(`ATELIER_LIVE_${service.name}_KEY`);
  it.skipIf(!key)('makes one small image', { timeout: 300_000 }, async () => {
    const preset = imagePreset(service.preset)!;
    const modelId = env(`ATELIER_LIVE_${service.name}_MODEL`) ?? service.model;
    const instance = { id: 'live', type: preset.type, preset: preset.id, name: preset.label, baseUrl: env(`ATELIER_LIVE_${service.name}_URL`) ?? preset.baseUrl, apiKey: key!, headers: {}, models: [modelId], workflows: [] };
    const adapter = createImageAdapter(instance, depsFor(service, key!));
    const model = (await adapter.listModels(AbortSignal.timeout(30_000))).find((m) => m.modelId === modelId);
    expect(model, `${modelId} wasn't listed`).toBeDefined();
    const fit = fitParams(model!.capabilities, { size: 'small', quality: 'draft' });
    const request: ImageRequest = { model: modelId, prompt: 'A small red lighthouse on a rocky coast at sunrise, soft watercolor', count: 1, quality: 'draft', references: [], tuning: fit.tuning, loras: [], capabilities: model!.capabilities, signal: AbortSignal.timeout(280_000), ...(fit.width ? { width: fit.width } : {}), ...(fit.height ? { height: fit.height } : {}), ...(fit.aspectRatio ? { aspectRatio: fit.aspectRatio } : {}), ...(fit.sizeClass ? { sizeClass: fit.sizeClass } : {}) };
    const events: ImageEvent[] = [];
    for await (const event of adapter.generate(request)) events.push(event);
    const finish = events.at(-1);
    expect(finish, JSON.stringify(finish)).toMatchObject({ type: 'finish', reason: 'done' });
    const image = events.find((e) => e.type === 'image');
    expect(image).toBeDefined();
    const bytes = image?.bytes ?? (await downloadImage({ fetch: (url, init) => fetch(url, init) }, image!.url!, request.signal)).bytes;
    expect(checkImage(bytes)).toMatch(/^image\//);
  });
});
