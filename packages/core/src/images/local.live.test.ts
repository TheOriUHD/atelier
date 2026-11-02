/**
 * Real local image servers. Skipped unless the address is set, through the environment or a gitignored `.env.local` at
 * the repo root:
 *   ATELIER_LIVE_A1111_URL     [ATELIER_LIVE_A1111_PRESET=a1111|forge|sdnext|koboldcpp|drawthings] [ATELIER_LIVE_A1111_MODEL]
 *   ATELIER_LIVE_SDSERVER_URL  stable-diffusion.cpp's sd-server
 *   ATELIER_LIVE_SWARMUI_URL   [ATELIER_LIVE_SWARMUI_MODEL]
 *   ATELIER_LIVE_INVOKEAI_URL  [ATELIER_LIVE_INVOKEAI_MODEL]
 *   ATELIER_LIVE_LOCALAI_URL   [ATELIER_LIVE_LOCALAI_MODEL]
 * Each image is small and has few steps, so these work on a CPU, slowly: ATELIER_LIVE_IMAGE_TIMEOUT_MS sets how long.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imagePreset, type ImageProviderType } from '@atelier/protocol';
import { imageSize } from '../providers/image-size.ts';
import { plainHttpFetch } from '../providers/plain-http.ts';
import { sniffMime } from '../providers/images.ts';
import { fitParams } from './params.ts';
import { createImageAdapter } from './index.ts';
import { openSocket } from './socket.ts';
import type { ImageAdapter, ImageEvent, ImageRequest, ListedImageModel } from './types.ts';

const envFile = join(import.meta.dirname, '../../../../.env.local');
const fileEnv: Record<string, string> = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2')]),
    )
  : {};
const env = (name: string): string | undefined => process.env[name] || fileEnv[name] || undefined;

const TIMEOUT_MS = Number(env('ATELIER_LIVE_IMAGE_TIMEOUT_MS')) || 15 * 60_000;

interface Target {
  name: string;
  type: ImageProviderType;
  preset: string;
  url: string | undefined;
  model: string | undefined;
  /** It can report steps while it works. */
  progress: boolean;
  /** Not every server has a seed that survives, or stops mid-job. */
  repeatable: boolean;
  stops: boolean;
}

const a1111Preset = env('ATELIER_LIVE_A1111_PRESET') ?? 'a1111';
const targets: Target[] = [
  { name: `A1111 family (${a1111Preset})`, type: 'a1111', preset: a1111Preset, url: env('ATELIER_LIVE_A1111_URL'), model: env('ATELIER_LIVE_A1111_MODEL'), progress: a1111Preset !== 'drawthings', repeatable: true, stops: a1111Preset !== 'drawthings' },
  { name: 'sd-server', type: 'openai-images', preset: 'sd-server', url: env('ATELIER_LIVE_SDSERVER_URL'), model: undefined, progress: false, repeatable: true, stops: false },
  { name: 'SwarmUI', type: 'swarmui', preset: 'swarmui', url: env('ATELIER_LIVE_SWARMUI_URL'), model: env('ATELIER_LIVE_SWARMUI_MODEL'), progress: true, repeatable: true, stops: true },
  { name: 'InvokeAI', type: 'invokeai', preset: 'invokeai', url: env('ATELIER_LIVE_INVOKEAI_URL'), model: env('ATELIER_LIVE_INVOKEAI_MODEL'), progress: false, repeatable: true, stops: true },
  { name: 'LocalAI', type: 'openai-images', preset: 'localai', url: env('ATELIER_LIVE_LOCALAI_URL'), model: env('ATELIER_LIVE_LOCALAI_MODEL'), progress: false, repeatable: true, stops: false },
];

function adapterFor(target: Pick<Target, 'name' | 'type' | 'preset' | 'url'>): ImageAdapter {
  return createImageAdapter(
    { id: 'live', type: target.type, preset: target.preset, name: target.name, baseUrl: target.url!.replace(/\/+$/, ''), headers: {}, models: [], workflows: [] },
    { fetch: plainHttpFetch(fetch, { idleMs: TIMEOUT_MS }), socket: openSocket },
  );
}

async function pick(adapter: ImageAdapter, wanted: string | undefined): Promise<ListedImageModel> {
  const models = await adapter.listModels(AbortSignal.timeout(60_000));
  const model = wanted ? models.find((m) => m.modelId === wanted || m.displayName === wanted) : models[0];
  if (!model) throw new Error(`No model${wanted ? ` "${wanted}"` : ''}: ${models.map((m) => m.modelId).join(', ') || 'the server lists none'}.`);
  return model;
}

/** The smallest request the model takes, with as few steps as it was made for. */
function smallRequest(model: ListedImageModel, over: Partial<ImageRequest> = {}): ImageRequest {
  const fit = fitParams(model.capabilities, { size: 'small' });
  return {
    model: model.modelId,
    prompt: 'a small red lighthouse on a rocky coast, watercolor',
    count: 1,
    quality: 'draft',
    references: [],
    tuning: { ...fit.tuning, steps: Math.min(fit.tuning.steps ?? 4, 4) },
    loras: [],
    capabilities: model.capabilities,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(fit.width ? { width: fit.width } : {}),
    ...(fit.height ? { height: fit.height } : {}),
    ...over,
  };
}

async function run(adapter: ImageAdapter, request: ImageRequest): Promise<ImageEvent[]> {
  const events: ImageEvent[] = [];
  for await (const event of adapter.generate(request)) events.push(event);
  return events;
}

const finished = (events: ImageEvent[]) => events.find((e): e is Extract<ImageEvent, { type: 'finish' }> => e.type === 'finish');
const imagesIn = (events: ImageEvent[]) => events.filter((e): e is Extract<ImageEvent, { type: 'image' }> => e.type === 'image');

for (const t of targets) {
  describe.skipIf(!t.url)(`live: ${t.name}`, { timeout: TIMEOUT_MS * 3 }, () => {
    let created: ImageAdapter | undefined;
    const live = () => (created ??= adapterFor(t));

    it('is healthy and lists an image model', async () => {
      expect(await live().health(AbortSignal.timeout(30_000))).toMatchObject({ ok: true });
      expect((await live().listModels(AbortSignal.timeout(60_000))).length).toBeGreaterThan(0);
    });

    it('makes an image of the size asked for', async () => {
      const model = await pick(live(), t.model);
      const request = smallRequest(model);
      const events = await run(live(), request);
      expect(finished(events)).toMatchObject({ reason: 'done' });
      const [image] = imagesIn(events);
      expect(image?.bytes).toBeDefined();
      expect(sniffMime(image!.bytes!)).not.toBeNull();
      expect(imageSize(image!.bytes!)).toMatchObject({ width: request.width, height: request.height });
      if (t.progress) expect(events.some((e) => e.type === 'progress' || e.type === 'loading')).toBe(true);
    });

    it.skipIf(!t.repeatable)('repeats an image from its seed', async () => {
      const model = await pick(live(), t.model);
      const first = imagesIn(await run(live(), smallRequest(model, { seed: 1234 })))[0];
      const second = imagesIn(await run(live(), smallRequest(model, { seed: 1234 })))[0];
      expect(first?.seed ?? 1234).toBe(1234);
      expect(Buffer.from(second!.bytes!).equals(Buffer.from(first!.bytes!))).toBe(true);
    });

    it('changes an image it is given', async () => {
      const model = await pick(live(), t.model);
      if (!model.capabilities.edit) return;
      const [source] = imagesIn(await run(live(), smallRequest(model, { seed: 7 })));
      const events = await run(live(), smallRequest(model, { prompt: 'the same lighthouse at night', seed: 8, references: [{ bytes: source!.bytes!, mime: sniffMime(source!.bytes!)!, name: 'in.png' }] }));
      expect(finished(events)).toMatchObject({ reason: 'done' });
      expect(Buffer.from(imagesIn(events)[0]!.bytes!).equals(Buffer.from(source!.bytes!))).toBe(false);
    });

    it.skipIf(!t.stops)('stops when told to', async () => {
      const model = await pick(live(), t.model);
      const controller = new AbortController();
      const events: ImageEvent[] = [];
      // Enough steps to still be running when the first sign of life comes.
      const request = smallRequest(model, { signal: controller.signal, tuning: { ...smallRequest(model).tuning, steps: 40 } });
      for await (const event of live().generate(request)) {
        events.push(event);
        if (event.type === 'progress' || event.type === 'loading') controller.abort();
      }
      expect(finished(events)?.reason).toBe('aborted');
      // The server must be free again: this only finishes if the job really ended.
      expect(finished(await run(live(), smallRequest(model)))).toMatchObject({ reason: 'done' });
    });

    it('frees its memory when asked', async () => {
      await expect(live().free?.(AbortSignal.timeout(30_000))).resolves.toBeUndefined();
    });
  });
}

it('has a preset for every target, so these run the way people run them', () => {
  for (const t of targets) expect(imagePreset(t.preset)?.type).toBe(t.type);
});
