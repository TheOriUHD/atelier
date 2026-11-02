/**
 * Runs the ComfyUI adapter against a real server. Skipped unless ATELIER_LIVE_COMFYUI_URL is set.
 *
 * That server is someone's working GPU, so: every job waits for an empty queue or doesn't start, prompts are plain
 * landscapes, results stay in its temp folder (`PreviewImage`) and in memory here, and the models are let go at the end.
 * Writing results out needs ATELIER_LIVE_COMFYUI_OUT, and only the general-purpose models ever do.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import type { ImageCapabilities, ImageWorkflow } from '@atelier/protocol';
import { imageSize } from '../providers/image-size.ts';
import { plainHttpFetch } from '../providers/plain-http.ts';
import { createComfyUi } from './dialects/comfyui/index.ts';
import { readWorkflow, pngTextChunks } from './dialects/comfyui/workflow.ts';
import { openSocket } from './socket.ts';
import type { ImageAdapter, ImageEvent, ImageInstance, ImageRequest, ImageSocket, ListedImageModel } from './types.ts';

const URL_ = process.env.ATELIER_LIVE_COMFYUI_URL;
const OUT = process.env.ATELIER_LIVE_COMFYUI_OUT;
const JOB_MS = 280_000;
const PROMPT = 'a lighthouse on a rocky coast at sunrise, soft watercolor painting';

const instance = (workflows: ImageWorkflow[] = []): ImageInstance => ({ id: 'live', type: 'comfyui', name: 'ComfyUI', baseUrl: URL_ ?? '', headers: {}, models: [], workflows });
// The same fetch the app uses for plain HTTP, since that's where a multipart body can go missing.
const httpFetch = plainHttpFetch((url, init) => fetch(url, init), { idleMs: 10 * 60_000 });
const deps = (socket: (url: string, signal: AbortSignal) => Promise<ImageSocket> = openSocket) => ({ fetch: httpFetch, socket });

const getJson = async (path: string): Promise<Record<string, unknown>> => (await (await fetch(`${URL_}${path}`)).json()) as Record<string, unknown>;

async function queue(): Promise<{ running: unknown[]; pending: unknown[] }> {
  const body = await getJson('/queue');
  return { running: body.queue_running as unknown[], pending: body.queue_pending as unknown[] };
}

function request(model: ListedImageModel, over: Partial<ImageRequest> = {}): ImageRequest {
  const capabilities: ImageCapabilities = model.capabilities;
  return { model: model.modelId, prompt: PROMPT, width: 512, height: 512, count: 1, quality: 'standard', references: [], tuning: capabilities.defaults ?? {}, loras: [], capabilities, signal: AbortSignal.timeout(JOB_MS), ...over };
}

interface Run {
  events: ImageEvent[];
  images: Extract<ImageEvent, { type: 'image' }>[];
  finish: Extract<ImageEvent, { type: 'finish' }>;
  ms: number;
  firstStepMs: number | null;
}

async function run(adapter: ImageAdapter, req: ImageRequest, onEvent?: (e: ImageEvent) => void): Promise<Run> {
  const started = Date.now();
  const events: ImageEvent[] = [];
  let firstStepMs: number | null = null;
  for await (const event of adapter.generate(req)) {
    events.push(event);
    if (event.type === 'progress' && firstStepMs === null) firstStepMs = Date.now() - started;
    onEvent?.(event);
  }
  return { events, images: events.filter((e): e is Run['images'][number] => e.type === 'image'), finish: events.at(-1) as Run['finish'], ms: Date.now() - started, firstStepMs };
}

const summary = (label: string, r: Run) => console.log(`[live] ${label}: ${(r.ms / 1000).toFixed(1)} s, first step at ${r.firstStepMs === null ? '-' : (r.firstStepMs / 1000).toFixed(1)} s, ${r.events.filter((e) => e.type === 'progress').length} progress, ${r.events.filter((e) => e.type === 'preview').length} previews, ${r.events.filter((e) => e.type === 'loading').length} loading, finish ${r.finish.reason}${r.finish.error ? `: ${r.finish.error.message}` : ''}`);

function keep(name: string, image: Run['images'][number]): void {
  if (!OUT || !image.bytes) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), image.bytes);
}

/** The owner's rule: a job only starts on an empty queue. */
async function idle(ctx: TestContext): Promise<void> {
  const { running, pending } = await queue();
  if (running.length + pending.length > 0) ctx.skip();
}

describe.skipIf(!URL_)('ComfyUI, on a real server', () => {
  const adapter = createComfyUi(instance(), deps());
  let models: ListedImageModel[] = [];
  let freed = false;
  const family = (id: string, match: RegExp = /./) => models.find((m) => m.capabilities.family === id && match.test(m.modelId));

  beforeEach(async (ctx) => {
    await idle(ctx);
    if (models.length === 0) models = await adapter.listModels(AbortSignal.timeout(60_000));
  }, 90_000);

  afterAll(async () => {
    if (URL_ && !freed) await adapter.free?.(AbortSignal.timeout(20_000));
  }, 30_000);

  it('checks health, and finds models without the full /object_info', { timeout: 90_000 }, async () => {
    const started = Date.now();
    const health = await adapter.health(AbortSignal.timeout(20_000));
    const found = await adapter.listModels(AbortSignal.timeout(60_000));
    console.log(`[live] health ${health.latencyMs} ms, ${found.length} models in ${Date.now() - started} ms: ${found.map((m) => m.capabilities.family).join(', ')}`);
    expect(health.ok).toBe(true);
    expect(found.some((m) => m.capabilities.family === 'z-image')).toBe(true);
    expect(found.find((m) => m.capabilities.family === 'z-image')?.capabilities).toMatchObject({ previews: true, seed: true, tunable: true, defaults: { steps: 8, guidance: 1, sampler: 'res_multistep', scheduler: 'simple' } });
  });

  it('refuses a missing model in plain words, without queueing anything', { timeout: 60_000 }, async () => {
    const model = family('sdxl') ?? family('z-image')!;
    const wrong = createComfyUi({ ...instance(), workflows: [{ id: 'broken', name: 'Broken', map: { prompt: { node: '2', input: 'text' }, output: '4' }, graph: { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'no-such-model.safetensors' } }, 2: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: '' } }, 3: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['5', 0], seed: 1, steps: 1, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } }, 5: { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 64, batch_size: 1 } }, 6: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 2] } }, 4: { class_type: 'PreviewImage', inputs: { images: ['6', 0] } } } }] }, deps());
    const result = await run(wrong, request(model, { model: 'workflow:broken', tuning: {} }));
    summary('missing model', result);
    expect(result.finish).toMatchObject({ reason: 'error' });
    expect(result.finish.error?.message).toContain('Missing model no-such-model.safetensors');
    expect(await queue()).toEqual({ running: [], pending: [] });
  });

  let lighthouse: Uint8Array | undefined;

  it('makes a Z-Image Turbo picture with steps, previews and the seed', { timeout: JOB_MS }, async () => {
    const model = family('z-image')!;
    const result = await run(adapter, request(model, { width: 1024, height: 1024, seed: 12345 }));
    summary('z-image 1024', result);
    expect(result.finish.reason).toBe('done');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.seed).toBe(12345);
    expect(imageSize(result.images[0]!.bytes!)).toEqual({ width: 1024, height: 1024 });
    expect(result.events.filter((e) => e.type === 'progress').at(-1)).toMatchObject({ step: 8, steps: 8 });
    expect(result.events.filter((e) => e.type === 'preview').length).toBeGreaterThan(0);
    expect(result.events.some((e) => e.type === 'preview' && e.mime === 'image/jpeg')).toBe(true);
    lighthouse = result.images[0]!.bytes!;
    keep('z-image.png', result.images[0]!);
  });

  it('comes back warm, and the result holds its own workflow', { timeout: JOB_MS }, async () => {
    expect(lighthouse).toBeDefined();
    const chunks = pngTextChunks(lighthouse!);
    expect(Object.keys(chunks)).toContain('prompt');
    const workflow = await readWorkflow({ pngBase64: Buffer.from(lighthouse!).toString('base64') });
    expect(workflow.map).toMatchObject({ steps: expect.anything(), seed: expect.anything(), width: expect.anything() });
    const again = createComfyUi(instance([workflow]), deps());
    const listed = (await again.listModels(AbortSignal.timeout(60_000))).find((m) => m.capabilities.family === 'workflow')!;
    const result = await run(again, request(listed, { prompt: 'a calm harbour at dusk, soft watercolor painting', width: 512, height: 512, seed: 777, tuning: listed.capabilities.defaults ?? {} }));
    summary('workflow from PNG', result);
    expect(result.finish.reason).toBe('done');
    expect(imageSize(result.images[0]!.bytes!)).toEqual({ width: 512, height: 512 });
    keep('workflow.png', result.images[0]!);
  });

  it('makes a batch of two', { timeout: JOB_MS }, async () => {
    const result = await run(adapter, request(family('z-image')!, { count: 2 }));
    summary('z-image batch of 2', result);
    expect(result.images).toHaveLength(2);
  });

  it('edits an image, and only inside a mask', { timeout: JOB_MS }, async () => {
    expect(lighthouse).toBeDefined();
    const model = family('z-image')!;
    const reference = { bytes: lighthouse!, mime: 'image/png', name: 'input-live-test.png' };
    const edited = await run(adapter, request(model, { prompt: 'the same lighthouse under a dark stormy sky', width: 768, height: 768, references: [reference] }));
    summary('z-image edit', edited);
    expect(edited.finish.reason).toBe('done');
    expect(imageSize(edited.images[0]!.bytes!)).toEqual({ width: 768, height: 768 });
    keep('edit.png', edited.images[0]!);
    const { PNG } = await import('pngjs');
    const mask = new PNG({ width: 64, height: 64 });
    for (let i = 0; i < mask.data.length; i += 4) {
      const y = Math.floor(i / 4 / 64);
      mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = y < 32 ? 255 : 0;
      mask.data[i + 3] = 255;
    }
    const masked = await run(adapter, request(model, { prompt: 'a dark stormy sky', width: 768, height: 768, references: [reference], mask: { bytes: PNG.sync.write(mask), mime: 'image/png', name: 'mask-live-test.png' } }));
    summary('z-image mask', masked);
    expect(masked.finish.reason).toBe('done');
    keep('mask.png', masked.images[0]!);
  });

  it('carries on by polling when the socket drops mid job', { timeout: JOB_MS }, async () => {
    let cut: (() => void) | undefined;
    const dropping = createComfyUi(instance(), deps(async (url, signal) => {
      const socket = await openSocket(url, signal);
      cut = () => socket.close();
      return socket;
    }));
    let once = false;
    const result = await run(dropping, request(family('z-image')!, { seed: 555 }), (event) => {
      if (event.type === 'progress' && event.step !== undefined && !once) {
        once = true;
        cut?.();
      }
    });
    summary('socket dropped', result);
    expect(once).toBe(true);
    expect(result.finish.reason).toBe('done');
    expect(result.images).toHaveLength(1);
  });

  it('polls from the start when the socket never opens', { timeout: JOB_MS }, async () => {
    const closed = createComfyUi(instance(), deps(async () => {
      throw new Error('no sockets here');
    }));
    const result = await run(closed, request(family('z-image')!, { seed: 556 }));
    summary('no socket', result);
    expect(result.finish.reason).toBe('done');
    expect(result.images).toHaveLength(1);
    expect(result.events.some((e) => e.type === 'preview')).toBe(false);
  });

  it('interrupts its own running job, and leaves the queue empty', { timeout: JOB_MS }, async () => {
    const stop = new AbortController();
    const result = await run(adapter, request(family('z-image')!, { width: 1024, height: 1024, seed: 991, signal: stop.signal }), (event) => {
      if (event.type === 'progress' && event.step !== undefined && event.step >= 2) stop.abort(new Error('stopped'));
    });
    summary('interrupted', result);
    expect(result.finish.reason).toBe('aborted');
    // The server needs a moment to wind the job down after it answers.
    await expect.poll(queue, { timeout: 30_000, interval: 300 }).toEqual({ running: [], pending: [] });
  });

  it('takes its job off the queue when another is running, and leaves that one alone', { timeout: JOB_MS }, async () => {
    const model = family('z-image')!;
    // The job ahead stands for someone else's: it must finish whatever happens to ours.
    const ahead = run(adapter, request(model, { width: 1024, height: 1024, seed: 601 }));
    await expect.poll(async () => (await queue()).running.length, { timeout: 30_000, interval: 300 }).toBe(1);
    const stop = new AbortController();
    const waiting = run(adapter, request(model, { seed: 602, signal: stop.signal }), () => undefined);
    await expect.poll(async () => (await queue()).pending.length, { timeout: 30_000, interval: 300 }).toBe(1);
    stop.abort(new Error('stopped'));
    const stopped = await waiting;
    const finished = await ahead;
    summary('queue delete: ours', stopped);
    summary('queue delete: job ahead', finished);
    expect(stopped.finish.reason).toBe('aborted');
    expect(finished.finish.reason).toBe('done');
    expect(finished.images).toHaveLength(1);
    expect(await queue()).toEqual({ running: [], pending: [] });
  });

  it('runs one SDXL checkpoint, with the second pass and FaceDetailer', { timeout: JOB_MS }, async (ctx) => {
    const model = family('sdxl');
    if (!model) return ctx.skip();
    const result = await run(adapter, request(model, { prompt: 'lighthouse, rocky coast, sunrise, watercolor', width: 832, height: 1216, quality: 'high', seed: 4242 }));
    summary('sdxl high', result);
    expect(result.finish.reason).toBe('done');
    // These are adult checkpoints: the picture is measured here and goes no further.
    expect(imageSize(result.images[0]!.bytes!)).toEqual({ width: 1248, height: 1824 });
  });

  it('runs one distilled SDXL checkpoint', { timeout: JOB_MS }, async (ctx) => {
    const model = family('sdxl-distilled');
    if (!model) return ctx.skip();
    const result = await run(adapter, request(model, { prompt: 'lighthouse, rocky coast, sunrise, watercolor', width: 1024, height: 1024, seed: 4243 }));
    summary('sdxl distilled', result);
    expect(result.finish.reason).toBe('done');
    expect(result.events.filter((e) => e.type === 'progress').at(-1)).toMatchObject({ steps: 8 });
  });

  it('runs FLUX.2 Klein, with a reference image', { timeout: JOB_MS }, async (ctx) => {
    const model = family('flux2');
    if (!model || !lighthouse) return ctx.skip();
    const reference = { bytes: lighthouse, mime: 'image/png', name: 'input-live-test.png' };
    const result = await run(adapter, request(model, { prompt: 'the same lighthouse at night under a starry sky', width: 768, height: 768, seed: 4244, references: [reference] }));
    summary('flux2 klein', result);
    expect(result.finish.reason).toBe('done');
    expect(imageSize(result.images[0]!.bytes!)).toEqual({ width: 768, height: 768 });
    keep('klein.png', result.images[0]!);
  });

  // Last, and right after a job, so the models are still loaded: `POST /free` wedged a server in exactly this state.
  it('frees the GPU, and the server still takes jobs after', { timeout: JOB_MS }, async () => {
    const model = family('z-image')!;
    await run(adapter, request(model, { width: 1024, height: 1024, seed: 7001 }));
    const stats = async () => {
      const { devices, system } = (await getJson('/system_stats')) as { devices: { vram_free: number }[]; system: { ram_free: number } };
      return { vram: devices[0]?.vram_free ?? 0, ram: system.ram_free };
    };
    const before = await stats();
    await adapter.free?.(AbortSignal.timeout(20_000));
    freed = true;
    await expect.poll(async () => (await stats()).vram, { timeout: 30_000, interval: 1_000 }).toBeGreaterThan(before.vram + 2 ** 30);
    const after = await stats();
    console.log(`[live] free VRAM ${(before.vram / 2 ** 30).toFixed(1)} GB -> ${(after.vram / 2 ** 30).toFixed(1)} GB, free RAM ${(before.ram / 2 ** 30).toFixed(1)} GB -> ${(after.ram / 2 ** 30).toFixed(1)} GB`);
    expect(after.ram).toBeGreaterThan(before.ram - 2 ** 30);
    const again = await run(adapter, request(model, { width: 1024, height: 1024, seed: 7002 }));
    summary('z-image after freeing', again);
    expect(again.finish.reason).toBe('done');
  });
});
