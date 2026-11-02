import { describe, expect, it, vi } from 'vitest';
import { imageId, type ImageCapabilities, type ImageModelInfo, type Message, type RunEvent } from '@atelier/protocol';
import { openDatabase } from '../store/db.ts';
import { generatedImages, usageEvents } from '../store/schema.ts';
import type { ToolContext } from '../tools/types.ts';
import { HOSTED_DEFAULTS } from './catalog.ts';
import { ImageModelUnavailable, type ImageProviderRegistry } from './registry.ts';
import { ImageService, type ImageServiceDeps } from './service.ts';
import type { ImageEvent, ImageRequest } from './types.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 2, 0]);
const capabilities: ImageCapabilities = { ...HOSTED_DEFAULTS, sizes: { kind: 'free', min: 256, max: 2048, multiple: 8, base: 1024 }, maxCount: 4, edit: true, maxReferences: 2 };
const info = (over: Partial<ImageModelInfo> = {}): ImageModelInfo => ({ ref: 'img/m', providerId: 'img', modelId: 'm', displayName: 'Model', capabilities, source: 'detected', hidden: false, favorite: false, order: 0, ...over });

interface Setup {
  run?: (request: ImageRequest) => AsyncIterable<ImageEvent>;
  models?: ImageModelInfo[];
  settings?: Partial<ReturnType<ImageServiceDeps['settings']>['imageGeneration']>;
  history?: Message[];
  config?: Record<string, unknown>;
  /** What `resolve` adds for a person's own server. */
  personal?: { deviceId: string; fetch: () => Promise<Response> };
  userId?: string | null;
  /** The session's own choice of model. */
  imageModel?: string;
}

async function* images(n = 1): AsyncGenerator<ImageEvent> {
  yield { type: 'progress', step: 1, steps: 4 };
  for (let i = 0; i < n; i++) yield { type: 'image', bytes: PNG, seed: 7 };
  yield { type: 'finish', reason: 'done' };
}

function setup({ run = () => images(), models = [info()], settings = {}, history = [], config = {}, personal, userId = null, imageModel }: Setup = {}) {
  const db = openDatabase(':memory:');
  // Rows here point at sessions these tests don't need to make.
  db.$client.exec('PRAGMA foreign_keys = OFF');
  const requests: ImageRequest[] = [];
  const free = vi.fn(async () => {});
  const adapter = {
    type: 'openai-images' as const,
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
    generate: (request: ImageRequest) => (requests.push(request), run(request)),
    free,
  };
  const configured = { id: 'img', type: 'openai-images', name: 'Provider', baseUrl: 'https://images.example.com', headers: {}, enabled: true, ...config };
  const held: string[] = [];
  const released = vi.fn();
  const listedFor: unknown[] = [];
  const resolved: unknown[] = [];
  const registry = {
    listModels: async (user?: string | null) => (listedFor.push(user), models),
    resolve: async (ref: string, options: unknown) => {
      resolved.push(options);
      const found = models.find((m) => m.ref === ref);
      if (!found) throw new ImageModelUnavailable('gone');
      if (found.available === false) throw new ImageModelUnavailable(`${found.displayName} isn't connected.`);
      return { adapter, info: found, config: configured, ...(personal ? { personal } : {}) };
    },
    hold: async (model: { info: ImageModelInfo }) => (held.push(model.info.modelId), released),
    freeText: vi.fn(async () => {}),
  } as unknown as ImageProviderRegistry;
  const usage = vi.fn();
  const download = vi.fn(async (_url: string, _signal: AbortSignal, _through?: unknown) => ({ bytes: PNG, mime: 'image/png' as const }));
  const addGenerated = vi.fn(async () => {});
  const put = vi.fn(async () => ({ sha256: 'a'.repeat(64), size: PNG.length, mime: 'image/png', createdAt: 0 }));
  const service = new ImageService({
    registry,
    blobs: { put, read: async () => PNG },
    files: { addGenerated },
    db,
    settings: () => ({ imageGeneration: { enabled: true, maxImagesPerTurn: 8, ...settings }, imageModels: { overrides: {} }, imagePricing: {}, models: { defaults: {}, aliases: {}, overrides: {} } }) as never,
    session: async () => ({ userId, mode: 'chat', temporary: false, ...(imageModel ? { imageModel } : {}) }),
    preferred: async () => undefined,
    isAdmin: async () => false,
    history: async () => history,
    turnStart: async () => 1,
    download,
    recordUsage: usage,
    sleep: async () => {},
  });
  const events: RunEvent[] = [];
  const ctx = (signal = new AbortController().signal): ToolContext => ({ sessionId: 's', messageId: 'a', callId: 'c', signal, emit: (e) => events.push(e) });
  return { service, requests, events, ctx, usage, addGenerated, held, released, registry, db, free, listedFor, resolved, download };
}

describe('ImageService', () => {
  it('makes an image, keeps it and tells the model its id', async () => {
    const t = setup();
    const out = await t.service.generate({ prompt: 'a cat' }, t.ctx());
    expect(out.isError).toBeUndefined();
    const id = imageId('a'.repeat(64));
    expect(out.content[0]).toMatchObject({ type: 'text' });
    expect((out.content[0] as { text: string }).text).toContain(id);
    expect(out.content[1]).toEqual({ type: 'image', mime: 'image/png', blob: 'a'.repeat(64) });
    expect(out.generated?.[0]).toMatchObject({ id, prompt: 'a cat', seed: 7, modelName: 'Model', width: 512, height: 512 });
    expect(t.addGenerated).toHaveBeenCalledOnce();
    expect(t.db.select().from(generatedImages).all()).toHaveLength(1);
    expect(t.usage).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'img', images: 1, mode: 'chat' }));
    expect(t.released).toHaveBeenCalledOnce();
  });

  it('reports progress, with the final shape from the start', async () => {
    const t = setup();
    await t.service.generate({ prompt: 'a cat', aspect_ratio: '1:1' }, t.ctx());
    const first = t.events.find((e) => e.type === 'tool_progress');
    expect(first).toMatchObject({ callId: 'c', progress: { phase: 'queued', width: 1024, height: 1024, count: 1 } });
  });

  it('says how many are ahead when the server itself has a queue', async () => {
    const run = async function* (): AsyncGenerator<ImageEvent> {
      yield { type: 'queued', ahead: 2 };
      yield* images();
    };
    const t = setup({ run });
    await t.service.generate({ prompt: 'a cat' }, t.ctx());
    expect(t.events.some((e) => e.type === 'tool_progress' && e.progress.phase === 'queued' && e.progress.ahead === 2)).toBe(true);
  });

  it('says which models exist when asked for an unknown one', async () => {
    const t = setup();
    const out = await t.service.generate({ prompt: 'x', model: 'nope' }, t.ctx());
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain('img/m');
  });

  it('finds a model by its plain id too', async () => {
    const t = setup();
    expect((await t.service.generate({ prompt: 'x', model: 'M' }, t.ctx())).isError).toBeUndefined();
  });

  it('keeps hidden models from people who are not admins', async () => {
    const t = setup({ models: [info({ hidden: true })] });
    const out = await t.service.generate({ prompt: 'x' }, t.ctx());
    expect(out.isError).toBe(true);
    expect(t.requests).toHaveLength(0);
  });

  it('stops at the limit for one turn, counting calls running at once', async () => {
    const t = setup({ settings: { maxImagesPerTurn: 2 } });
    const results = await Promise.all([t.service.generate({ prompt: 'a' }, t.ctx()), t.service.generate({ prompt: 'b' }, t.ctx()), t.service.generate({ prompt: 'c' }, t.ctx())]);
    expect(results.filter((r) => r.isError)).toHaveLength(1);
    expect(t.requests).toHaveLength(2);
  });

  it('gives back the count of images that failed', async () => {
    let fail = true;
    const run = async function* (): AsyncGenerator<ImageEvent> {
      if (fail) {
        fail = false;
        yield { type: 'finish', reason: 'error', error: { code: 'x', message: 'broke' } };
      } else yield* images();
    };
    const t = setup({ run, settings: { maxImagesPerTurn: 1 } });
    expect((await t.service.generate({ prompt: 'a' }, t.ctx())).isError).toBe(true);
    expect((await t.service.generate({ prompt: 'b' }, t.ctx())).isError).toBeUndefined();
  });

  it('holds to the daily limit from usage, which outlives a deleted chat', async () => {
    const t = setup({ settings: { maxImagesPerUserPerDay: 3 } });
    (t.service as unknown as { deps: ImageServiceDeps }).deps.session = async () => ({ userId: 'u', mode: 'chat', temporary: false });
    t.db.insert(usageEvents).values({ id: '1', ts: Date.now(), userId: 'u', providerId: 'img', modelId: 'm', input: 0, output: 0, images: 3 }).run();
    const out = await t.service.generate({ prompt: 'a' }, t.ctx());
    expect((out.content[0] as { text: string }).text).toContain('limit of 3 images a day');
  });

  it('treats a refusal as final', async () => {
    const run = async function* (): AsyncGenerator<ImageEvent> {
      yield { type: 'finish', reason: 'refused', error: { code: 'provider_refused', message: 'Provider refused this.' } };
    };
    const t = setup({ run });
    const out = await t.service.generate({ prompt: 'x' }, t.ctx());
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain('final');
    expect(t.requests).toHaveLength(1);
  });

  it('retries a hiccup on a hosted service, but not on a local one', async () => {
    let calls = 0;
    const run = async function* (): AsyncGenerator<ImageEvent> {
      calls++;
      if (calls < 3) yield { type: 'finish', reason: 'error', error: { code: 'x', message: 'busy', retryable: true } };
      else yield* images();
    };
    const hosted = setup({ run });
    expect((await hosted.service.generate({ prompt: 'x' }, hosted.ctx())).isError).toBeUndefined();
    expect(calls).toBe(3);
    calls = 0;
    const local = setup({ run, config: { baseUrl: 'http://127.0.0.1:8188' } });
    expect((await local.service.generate({ prompt: 'x' }, local.ctx())).isError).toBe(true);
    expect(calls).toBe(1);
  });

  it('keeps what came back when a later image fails', async () => {
    const run = async function* (): AsyncGenerator<ImageEvent> {
      yield { type: 'image', bytes: PNG };
      yield { type: 'finish', reason: 'error', error: { code: 'x', message: 'out of memory' } };
    };
    const t = setup({ run });
    const out = await t.service.generate({ prompt: 'x', count: 2 }, t.ctx());
    expect(out.isError).toBeUndefined();
    expect((out.content[0] as { text: string }).text).toContain('out of memory');
  });

  it('only finds input images in its own conversation', async () => {
    const sha = 'b'.repeat(64);
    const message = { id: 'm', sessionId: 's', parentId: null, role: 'user', parts: [{ type: 'image', mime: 'image/png', blob: sha }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 } as Message;
    const t = setup({ history: [message] });
    const bad = await t.service.generate({ prompt: 'x', reference_images: ['img_00000000'] }, t.ctx());
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toContain(imageId(sha));
    await t.service.generate({ prompt: 'x', reference_images: [imageId(sha)] }, t.ctx());
    expect(t.requests[0]?.references).toHaveLength(1);
  });

  it('downloads what a hosted service only links to', async () => {
    const run = async function* (): AsyncGenerator<ImageEvent> {
      yield { type: 'image', url: 'https://cdn.example.com/a.png' };
      yield { type: 'finish', reason: 'done' };
    };
    const t = setup({ run });
    expect((await t.service.generate({ prompt: 'x' }, t.ctx())).generated).toHaveLength(1);
  });

  it('frees the GPU around a job on a shared card, and always lets go of the queue', async () => {
    const t = setup({ config: { sharesGpuWith: 'ollama', freeAfterRun: true } });
    await t.service.generate({ prompt: 'x' }, t.ctx());
    expect(t.registry.freeText).toHaveBeenCalledOnce();
    expect(t.free).toHaveBeenCalledOnce();
    expect(t.released).toHaveBeenCalledOnce();
  });

  it('lets a server that reports nothing work until it is done', async () => {
    const run = async function* (): AsyncGenerator<ImageEvent> {
      await new Promise((r) => setTimeout(r, 30));
      yield* images();
    };
    const t = setup({ run });
    (t.service as unknown as { deps: ImageServiceDeps }).deps.idleMs = 5;
    expect((await t.service.generate({ prompt: 'x' }, t.ctx())).isError).toBeUndefined();
  });

  it('gives up on a server that started talking and went quiet', async () => {
    const run = async function* (request: ImageRequest): AsyncGenerator<ImageEvent> {
      yield { type: 'progress', step: 1, steps: 4 };
      await new Promise((r) => request.signal.addEventListener('abort', r));
      yield { type: 'finish', reason: 'error', error: { code: 'provider_timeout', message: 'It went quiet.' } };
    };
    const t = setup({ run, config: { baseUrl: 'http://127.0.0.1:8188' } });
    (t.service as unknown as { deps: ImageServiceDeps }).deps.idleMs = 5;
    const out = await t.service.generate({ prompt: 'x' }, t.ctx());
    expect((out.content[0] as { text: string }).text).toContain('quiet');
    expect(t.released).toHaveBeenCalledOnce();
  });

  it('stops with the turn', async () => {
    const controller = new AbortController();
    const run = async function* (request: ImageRequest): AsyncGenerator<ImageEvent> {
      controller.abort(new Error('stopped'));
      yield { type: 'finish', reason: request.signal.aborted ? 'aborted' : 'done' };
    };
    const t = setup({ run });
    await expect(t.service.generate({ prompt: 'x' }, t.ctx(controller.signal))).rejects.toThrow('stopped');
    expect(t.released).toHaveBeenCalledOnce();
  });

  describe('a person’s own models', () => {
    const own = (over: Partial<ImageModelInfo> = {}) => info({ ref: 'u-aaaaaaaaaa/sdxl', providerId: 'u-aaaaaaaaaa', modelId: 'sdxl', displayName: 'SDXL', personal: { deviceId: 'laptop', deviceName: 'Laptop' }, available: true, ...over });

    it('lists and resolves models for the person the session belongs to', async () => {
      const t = setup({ userId: 'ada', models: [own()] });
      const out = await t.service.generate({ prompt: 'a cat', model: 'u-aaaaaaaaaa/sdxl' }, t.ctx());
      expect(out.isError).toBeUndefined();
      expect(t.listedFor).toContain('ada');
      expect(t.resolved).toEqual([{ admin: false, userId: 'ada' }]);
    });

    it('doesn’t offer the tool or the model while its computer is away', async () => {
      const t = setup({ userId: 'ada', models: [own({ available: false })] });
      const session = { userId: 'ada', mode: 'chat', temporary: false };
      expect(await t.service.available(session)).toBe(false);
      expect(await t.service.modelList(session)).toBe('');
      const both = setup({ userId: 'ada', models: [info(), own({ available: false })] });
      expect(await both.service.available(session)).toBe(true);
      expect(await both.service.modelList(session)).not.toContain('sdxl');
    });

    it('says the chosen one’s computer is away, rather than quietly using another model', async () => {
      const away = own({ available: false });
      const t = setup({ userId: 'ada', models: [info(), away], imageModel: away.ref });
      const out = await t.service.generate({ prompt: 'a cat' }, t.ctx());
      expect(out.isError).toBe(true);
      expect(out.content[0]).toMatchObject({ text: "SDXL isn't connected." });
      expect(t.requests).toEqual([]);
    });

    it('has the computer fetch a URL its server answers with: this server never goes there', async () => {
      async function* linked(): AsyncGenerator<ImageEvent> {
        yield { type: 'image', url: 'http://127.0.0.1:8080/generated/a.png' };
        yield { type: 'finish', reason: 'done' };
      }
      const through = async () => new Response(PNG);
      const t = setup({ userId: 'ada', models: [own()], personal: { deviceId: 'laptop', fetch: through }, run: () => linked() });
      await t.service.generate({ prompt: 'a cat' }, t.ctx());
      expect(t.download).toHaveBeenCalledWith('http://127.0.0.1:8080/generated/a.png', expect.anything(), through);
      // A shared provider's stays on the server, behind its address guard.
      const shared = setup({ run: () => linked() });
      await shared.service.generate({ prompt: 'a cat' }, shared.ctx());
      expect(shared.download).toHaveBeenCalledWith('http://127.0.0.1:8080/generated/a.png', expect.anything(), undefined);
    });

    it('costs nothing here, even if its model is named like a paid one', async () => {
      const paid = own({ ref: 'u-aaaaaaaaaa/gpt-image-1', modelId: 'gpt-image-1' });
      const t = setup({ userId: 'ada', models: [paid], personal: { deviceId: 'laptop', fetch: async () => new Response(PNG) } });
      await t.service.generate({ prompt: 'a cat' }, t.ctx());
      expect(t.usage).toHaveBeenCalledWith(expect.objectContaining({ costUsd: null, images: 1 }));
    });
  });

  it('lists models for the text model with the chosen one first', async () => {
    const t = setup({ models: [info({ ref: 'img/a', displayName: 'A' }), info({ ref: 'img/b', displayName: 'B', capabilities: { ...capabilities, promptStyle: 'tags', negativePrompt: true } })] });
    const list = await t.service.modelList({ userId: null, mode: 'chat', temporary: false, imageModel: 'img/b' });
    expect(list.split('\n')[0]).toContain('img/b');
    expect(list).toContain('comma-separated tags');
  });
});
