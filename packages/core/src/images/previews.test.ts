/**
 * Previews from a real wire format all the way to what the page gets. AUTOMATIC1111 sends `current_image` in the
 * server's `samples_format`, which is a full-size PNG by default, so a live preview can be megabytes.
 */
import jpeg from 'jpeg-js';
import { PNG as PngFile } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { ImageCapabilities, ImageModelInfo, ImageProgress, RunEvent } from '@atelier/protocol';
import { jsonResponse } from '../providers/__fixtures__/harness.ts';
import { imageSize } from '../providers/image-size.ts';
import { toBase64 } from '../providers/util.ts';
import { openDatabase } from '../store/db.ts';
import type { ToolContext } from '../tools/types.ts';
import { adapterDeps, held, imageInstance, PNG, PNG_B64 } from './__fixtures__/harness.ts';
import { HOSTED_DEFAULTS } from './catalog.ts';
import { createA1111 } from './dialects/a1111.ts';
import type { ImageProviderRegistry } from './registry.ts';
import { ImageService } from './service.ts';

/** Noise, which is what a half-finished picture compresses like. */
function noise(width: number, height: number): { rgba: Buffer; width: number; height: number } {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = (i * 2654435761) % 251;
    rgba[i + 1] = (i * 40503) % 241;
    rgba[i + 2] = (i * 2166136261) % 239;
    rgba[i + 3] = 255;
  }
  return { rgba, width, height };
}

const pngNoise = (width: number, height: number) => {
  const { rgba } = noise(width, height);
  const png = new PngFile({ width, height });
  png.data = rgba;
  return toBase64(PngFile.sync.write(png));
};

const jpegNoise = (width: number, height: number) => toBase64(jpeg.encode({ data: noise(width, height).rgba, width, height }, 95).data);

/** A WebP header with a size in it, padded out: nothing here can decode one, so it can't be reduced. */
function webp(width: number, height: number, bytes: number): string {
  const file = new Uint8Array(bytes);
  file.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0]);
  const put = (at: number, value: number) => file.set([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff], at);
  put(24, width - 1);
  put(27, height - 1);
  return toBase64(file);
}

const capabilities: ImageCapabilities = { ...HOSTED_DEFAULTS, sizes: { kind: 'free', min: 256, max: 2048, multiple: 8, base: 1024 }, previews: true, tunable: true };
const info: ImageModelInfo = { ref: 'img/m', providerId: 'img', modelId: 'm', displayName: 'Model', capabilities, source: 'detected', hidden: false, favorite: false, order: 0 };

/** Runs one generation whose only progress is `preview`, and returns what the page would have been sent. */
async function previewsFor(preview: string): Promise<ImageProgress['preview'][]> {
  const pending = held();
  const { deps } = adapterDeps({
    'POST /sdapi/v1/txt2img': () => pending.promise,
    'GET /sdapi/v1/progress': () => {
      setTimeout(() => pending.release(jsonResponse({ images: [PNG_B64], info: '' })), 0);
      return jsonResponse({ progress: 0.5, eta_relative: 1, state: { job_count: 1, sampling_step: 2, sampling_steps: 4 }, current_image: preview });
    },
  });
  const adapter = createA1111(imageInstance('a1111', 'a1111'), deps, { pollMs: 1 });
  const db = openDatabase(':memory:');
  // Rows here point at sessions this test doesn't need to make.
  db.$client.exec('PRAGMA foreign_keys = OFF');
  const registry = {
    listModels: async () => [info],
    resolve: async () => ({ adapter, info, config: { id: 'img', type: 'a1111', name: 'Server', baseUrl: 'http://127.0.0.1:7860', headers: {}, enabled: true } }),
    hold: async () => () => undefined,
    freeText: async () => undefined,
  } as unknown as ImageProviderRegistry;
  const service = new ImageService({
    registry,
    blobs: { put: async () => ({ sha256: 'a'.repeat(64), size: PNG.length, mime: 'image/png', createdAt: 0 }), read: async () => PNG },
    files: { addGenerated: async () => undefined } as never,
    db,
    settings: () => ({ imageGeneration: { enabled: true, maxImagesPerTurn: 8 }, imageModels: { overrides: {} }, imagePricing: {}, models: { defaults: {}, aliases: {}, overrides: {} } }) as never,
    session: async () => ({ userId: null, mode: 'chat', temporary: false }),
    preferred: async () => undefined,
    isAdmin: async () => false,
    history: async () => [],
    turnStart: async () => 1,
    download: async () => ({ bytes: PNG, mime: 'image/png' }),
    recordUsage: () => undefined,
  });
  const events: RunEvent[] = [];
  const ctx: ToolContext = { sessionId: 's', messageId: 'a', callId: 'c', signal: new AbortController().signal, emit: (e: RunEvent) => events.push(e) } as never;
  const output = await service.generate({ prompt: 'a fox' }, ctx);
  expect(output.isError ?? false).toBe(false);
  return events.flatMap((e) => (e.type === 'tool_progress' && e.progress.preview ? [e.progress.preview] : []));
}

const LIMIT = 400_000;

describe('previews on their way to the page', () => {
  it('passes a small preview through untouched', async () => {
    const small = jpegNoise(64, 64);
    expect(await previewsFor(small)).toContainEqual({ mime: 'image/jpeg', data: small });
  });

  it('shrinks a full-size PNG, the default in AUTOMATIC1111, to something the event can carry', async () => {
    const big = pngNoise(1024, 1024);
    expect(big.length).toBeGreaterThan(1_000_000);
    const [preview] = await previewsFor(big);
    expect(preview?.data.length).toBeLessThan(LIMIT);
    const size = imageSize(Buffer.from(preview!.data, 'base64'))!;
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(512);
  });

  it('shrinks a large JPEG and keeps it a JPEG', async () => {
    const big = jpegNoise(1216, 832);
    expect(big.length).toBeGreaterThan(200_000);
    const [preview] = await previewsFor(big);
    expect(preview?.mime).toBe('image/jpeg');
    expect(preview?.data.length).toBeLessThan(LIMIT);
    const size = imageSize(Buffer.from(preview!.data, 'base64'))!;
    expect(size.width).toBeGreaterThan(size.height);
  });

  it('sends a small WebP as it is', async () => {
    const small = webp(256, 256, 2_000);
    expect(await previewsFor(small)).toContainEqual({ mime: 'image/webp', data: small });
  });

  it('leaves out a large WebP it cannot reduce, and the image still arrives', async () => {
    expect(await previewsFor(webp(1024, 1024, 600_000))).toEqual([]);
  });

  it('leaves out a preview too damaged to reduce, and the image still arrives', async () => {
    const whole = pngNoise(1024, 1024);
    expect(await previewsFor(whole.slice(0, 400_000))).toEqual([]);
  });
});
