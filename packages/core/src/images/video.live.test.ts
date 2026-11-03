/**
 * One short real clip from each video service. A clip costs real money and takes minutes, so each test is skipped unless
 * its key is set in the environment:
 *   ATELIER_LIVE_<SERVICE>_KEY    the service's API key
 *   ATELIER_LIVE_<SERVICE>_MODEL  optional, instead of the model named below
 *   ATELIER_LIVE_<SERVICE>_URL    optional, instead of the preset's address
 * The shortest length and the smallest resolution the model offers are used. Keys only go to the adapters.
 * Nothing here has run against a real service yet: every dialect is covered by fake servers until someone sets a key.
 */
import { describe, expect, it } from 'vitest';
import { imagePreset } from '@atelier/protocol';
import { downloadVideo } from './download.ts';
import { createImageAdapter } from './index.ts';
import type { ImageAdapterDeps, ImageEvent, ImageRequest } from './types.ts';
import { checkVideo } from './video.ts';
import { fitVideo } from './video-params.ts';

interface Service {
  name: string;
  preset: string;
  model: string;
}

const SERVICES: Service[] = [
  { name: 'OPENROUTER_VIDEO', preset: 'openrouter-video', model: 'alibaba/wan-3.0' },
  { name: 'XAI_VIDEO', preset: 'xai-video', model: 'grok-imagine-video-1.5-lite' },
  { name: 'FAL_VIDEO', preset: 'fal-video', model: 'alibaba/wan-3.0/text-to-video' },
  { name: 'REPLICATE_VIDEO', preset: 'replicate-video', model: 'alibaba/wan-3' },
  { name: 'BFL_VIDEO', preset: 'bfl-video', model: 'flux-3-video' },
  { name: 'GEMINI_VIDEO', preset: 'gemini-video', model: 'gemini-omni-1.1-flash' },
];

const env = (name: string) => process.env[name] || undefined;
const deps = (): ImageAdapterDeps => ({ fetch: (url, init) => fetch(url, init), socket: () => Promise.reject(new Error('Not used by cloud services.')) });

describe.each(SERVICES)('$name', (service) => {
  const key = env(`ATELIER_LIVE_${service.name}_KEY`);
  it.skipIf(!key)('makes one short clip', { timeout: 30 * 60_000 }, async () => {
    const preset = imagePreset(service.preset)!;
    const modelId = env(`ATELIER_LIVE_${service.name}_MODEL`) ?? service.model;
    const instance = { id: 'live', type: preset.type, preset: preset.id, name: preset.label, baseUrl: env(`ATELIER_LIVE_${service.name}_URL`) ?? preset.baseUrl, apiKey: key!, headers: {}, models: [modelId], workflows: [] };
    const adapter = createImageAdapter(instance, deps());
    const model = (await adapter.listModels(AbortSignal.timeout(60_000))).find((m) => m.modelId === modelId);
    expect(model, `${modelId} wasn't listed`).toBeDefined();
    const video = model!.capabilities.video!;
    const shortest = video.durations.kind === 'list' ? Math.min(...video.durations.seconds) : video.durations.min;
    const fit = fitVideo(model!.capabilities, { seconds: shortest, resolution: video.resolutions?.[0], audio: false });
    const request: ImageRequest = {
      model: modelId,
      prompt: 'A small red lighthouse on a rocky coast at sunrise, slow camera push-in, soft watercolor',
      count: 1,
      quality: 'draft',
      references: [],
      tuning: {},
      loras: [],
      capabilities: model!.capabilities,
      signal: AbortSignal.timeout(25 * 60_000),
      video: { seconds: fit.seconds, ...(fit.fps ? { fps: fit.fps } : {}), ...(fit.resolution ? { resolution: fit.resolution } : {}), ...(fit.audio !== undefined ? { audio: fit.audio } : {}) },
      ...(fit.width ? { width: fit.width } : {}),
      ...(fit.height ? { height: fit.height } : {}),
      ...(fit.aspectRatio ? { aspectRatio: fit.aspectRatio } : {}),
      ...(fit.sizeClass ? { sizeClass: fit.sizeClass } : {}),
    };
    const events: ImageEvent[] = [];
    for await (const event of adapter.generate(request)) events.push(event);
    const finish = events.at(-1);
    expect(finish, JSON.stringify(finish)).toMatchObject({ type: 'finish', reason: 'done' });
    const clip = events.find((e) => e.type === 'video');
    expect(clip).toBeDefined();
    const bytes = clip?.bytes ?? (await downloadVideo({ fetch: (url, init) => fetch(url, init) }, clip!.url!, request.signal)).bytes;
    expect(checkVideo(bytes)).toMatch(/^video\//);
  });
});
