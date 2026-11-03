import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { imageId, videoId, type ImageCapabilities, type ImageModelInfo, type Message, type RunEvent } from '@atelier/protocol';
import { openDatabase } from '../store/db.ts';
import { generatedImages, usageEvents } from '../store/schema.ts';
import type { ToolContext } from '../tools/types.ts';
import { HOSTED_DEFAULTS } from './catalog.ts';
import { ImageModelUnavailable, type ImageProviderRegistry } from './registry.ts';
import { ImageService } from './service.ts';
import type { ImageEvent, ImageRequest } from './types.ts';
import { VideoService, type VideoServiceDeps } from './video-service.ts';

const clip = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));
const MP4 = clip('tiny.mp4');
const WEBM = clip('tiny.webm');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 2, 0]);

const videoCaps: ImageCapabilities = {
  ...HOSTED_DEFAULTS,
  family: 'test-video',
  output: 'video',
  sizes: { kind: 'aspect', ratios: ['16:9', '9:16'], classes: ['480p', '720p'] },
  seed: true,
  video: { durations: { kind: 'list', seconds: [4, 6, 8] }, defaultSeconds: 6, resolutions: ['480p', '720p'], firstFrame: true, lastFrame: false, audio: 'optional' },
};
const info = (over: Partial<ImageModelInfo> = {}): ImageModelInfo => ({ ref: 'vid/m', providerId: 'vid', modelId: 'm', displayName: 'Clip Model', capabilities: videoCaps, source: 'detected', hidden: false, favorite: false, order: 0, ...over });
const imageInfo = (): ImageModelInfo => ({ ...info({ ref: 'img/p', providerId: 'img', modelId: 'p', displayName: 'Pic Model' }), capabilities: { ...HOSTED_DEFAULTS } });

interface Setup {
  run?: (request: ImageRequest) => AsyncIterable<ImageEvent>;
  models?: ImageModelInfo[];
  settings?: Record<string, unknown>;
  history?: Message[];
  personal?: { deviceId: string; fetch: () => Promise<Response> };
  userId?: string | null;
  admin?: boolean;
  preferred?: string;
  overrides?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
}

async function* done(bytes: Uint8Array = MP4): AsyncGenerator<ImageEvent> {
  yield { type: 'queued', ahead: 1 };
  yield { type: 'progress', fraction: 0.5 };
  yield { type: 'video', bytes, seed: 9 };
  yield { type: 'finish', reason: 'done' };
}

function setup({ run = () => done(), models = [info()], settings = {}, history = [], personal, userId = null, admin = false, preferred, overrides = {}, pricing = {} }: Setup = {}) {
  const db = openDatabase(':memory:');
  db.$client.exec('PRAGMA foreign_keys = OFF');
  const requests: ImageRequest[] = [];
  const free = vi.fn(async () => {});
  const adapter = {
    type: 'fal' as const,
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
    generate: (request: ImageRequest) => (requests.push(request), run(request)),
    free,
  };
  const config = { id: 'vid', type: 'fal', name: 'Video Provider', baseUrl: 'https://video.example.com', headers: {}, enabled: true };
  const released = vi.fn();
  const registry = {
    listModels: async () => models,
    resolve: async (ref: string) => {
      const found = models.find((m) => m.ref === ref);
      if (!found) throw new ImageModelUnavailable('gone');
      if (found.available === false) throw new ImageModelUnavailable(`${found.displayName} isn't connected.`);
      return { adapter, info: found, config, ...(personal ? { personal } : {}) };
    },
    hold: async () => released,
    freeText: vi.fn(async () => {}),
  } as unknown as ImageProviderRegistry;
  const usage = vi.fn();
  const download = vi.fn(async (_url: string, _signal: AbortSignal, _through?: unknown) => ({ bytes: WEBM, mime: 'video/webm' as const }));
  const addGenerated = vi.fn(async () => {});
  const put = vi.fn(async (bytes: Uint8Array, mime: string) => ({ sha256: (bytes === WEBM ? 'b' : 'a').repeat(64), size: bytes.length, mime, createdAt: 0 }));
  const deps: VideoServiceDeps = {
    registry,
    blobs: { put, read: async () => PNG },
    files: { addGenerated },
    db,
    settings: () => ({ imageGeneration: { enabled: true, videoEnabled: true, maxVideosPerTurn: 2, ...settings }, imageModels: { overrides }, imagePricing: pricing, models: { defaults: {}, aliases: {}, overrides: {} } }) as never,
    session: async () => ({ userId, mode: 'chat', temporary: false }),
    preferred: async () => preferred,
    isAdmin: async () => admin,
    history: async () => history,
    turnStart: async () => 1,
    download,
    recordUsage: usage,
    idleMs: 40,
  };
  const service = new VideoService(deps);
  const events: RunEvent[] = [];
  const ctx = (signal = new AbortController().signal): ToolContext => ({ sessionId: 's', messageId: 'a', callId: 'c', signal, emit: (e) => events.push(e) });
  return { service, requests, events, ctx, usage, addGenerated, released, registry, db, free, download, put };
}

const text = (out: { content: { type: string; text?: string }[] }) => (out.content[0] as { text: string }).text;

describe('VideoService', () => {
  it('makes a clip, keeps it and tells the model its id without handing it the bytes', async () => {
    const t = setup();
    const out = await t.service.generate({ prompt: 'a lighthouse at dusk' }, t.ctx());
    expect(out.isError).toBeUndefined();
    const id = videoId('a'.repeat(64));
    expect(out.content).toHaveLength(1);
    expect(text(out)).toContain(id);
    expect(text(out)).toContain('with sound');
    expect(out.generated?.[0]).toMatchObject({ id, kind: 'video', mime: 'video/mp4', width: 160, height: 90, seconds: 1, fps: 12, audio: true, seed: 9, modelName: 'Clip Model' });
    expect(t.addGenerated).toHaveBeenCalledWith(expect.objectContaining({ mime: 'video/mp4', name: expect.stringMatching(/^a-lighthouse-at-dusk-aaaaaa\.mp4$/) }));
    expect(t.db.select().from(generatedImages).all()).toMatchObject([{ kind: 'video', mime: 'video/mp4', mediaSeconds: 1, fps: 12, audio: true, width: 160, height: 90 }]);
    expect(t.usage).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'vid', videos: 1, videoSeconds: 1, mode: 'chat' }));
    expect(t.released).toHaveBeenCalledOnce();
  });

  it('sends the adapter a request fitted to the model', async () => {
    const t = setup();
    await t.service.generate({ prompt: 'x', seconds: 5, aspect_ratio: '9:16', resolution: '480p', audio: true, seed: 3 }, t.ctx());
    expect(t.requests[0]).toMatchObject({ model: 'm', count: 1, aspectRatio: '9:16', sizeClass: '480p', seed: 3, video: { seconds: 4, resolution: '480p', audio: true } });
    const out = await t.service.generate({ prompt: 'x', seconds: 5 }, t.ctx());
    expect(text(out)).toContain('so the clip is 4 seconds');
  });

  it('sends silent unless sound was asked for, to a model that can switch it', async () => {
    const t = setup();
    await t.service.generate({ prompt: 'x' }, t.ctx());
    expect(t.requests[0]!.video).toMatchObject({ seconds: 6, resolution: '720p', audio: false });
  });

  it('uses the length and frame rate a person set for the model', async () => {
    const t = setup({ overrides: { 'vid/m': { video: { seconds: 8 } } } });
    await t.service.generate({ prompt: 'x' }, t.ctx());
    expect(t.requests[0]!.video!.seconds).toBe(8);
  });

  it('reports progress with the clip’s shape and length from the start', async () => {
    const t = setup();
    await t.service.generate({ prompt: 'x', aspect_ratio: '9:16' }, t.ctx());
    const first = t.events.find((e) => e.type === 'tool_progress');
    expect(first).toMatchObject({ callId: 'c', progress: { phase: 'queued', kind: 'video', seconds: 6, count: 1, width: 563, height: 1000 } });
    expect(t.events.some((e) => e.type === 'tool_progress' && e.progress.phase === 'queued' && e.progress.ahead === 1)).toBe(true);
    expect(t.events.some((e) => e.type === 'tool_progress' && e.progress.fraction === 0.5)).toBe(true);
    const last = t.events.findLast((e) => e.type === 'tool_progress');
    expect(last).toMatchObject({ progress: { phase: 'finishing', images: [expect.objectContaining({ kind: 'video' })] } });
  });

  it('downloads a clip given by URL, and checks what came back', async () => {
    const t = setup({ run: async function* () {
      yield { type: 'video', url: 'https://cdn.example.com/v.webm' };
      yield { type: 'finish', reason: 'done' };
    } });
    const out = await t.service.generate({ prompt: 'x' }, t.ctx());
    expect(t.download).toHaveBeenCalledWith('https://cdn.example.com/v.webm', expect.any(AbortSignal), undefined);
    expect(out.generated?.[0]).toMatchObject({ mime: 'video/webm', width: 160, height: 90, audio: false });
  });

  it('fetches a person’s own server’s clip through their computer', async () => {
    const through = vi.fn(async () => new Response());
    const t = setup({ personal: { deviceId: 'd', fetch: through }, run: async function* () {
      yield { type: 'video', url: 'http://127.0.0.1:8188/view?filename=a.webm' };
      yield { type: 'finish', reason: 'done' };
    } });
    await t.service.generate({ prompt: 'x' }, t.ctx());
    expect(t.download.mock.calls[0]![2]).toBe(through);
  });

  it('refuses bytes that are not a video, and stores nothing', async () => {
    const t = setup({ run: () => done(PNG) });
    await expect(t.service.generate({ prompt: 'x' }, t.ctx())).rejects.toThrow("isn't an MP4 or WebM");
    expect(t.db.select().from(generatedImages).all()).toHaveLength(0);
    expect(t.usage).not.toHaveBeenCalled();
  });

  it('keeps a refusal final and hands a failure to the model', async () => {
    const refused = setup({ run: async function* () {
      yield { type: 'finish', reason: 'refused', error: { code: 'provider_refused', message: 'Video Provider refused this: policy.', retryable: false } };
    } });
    const out = await refused.service.generate({ prompt: 'x' }, refused.ctx());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("don't reword the prompt");
    const failed = setup({ run: async function* () {
      yield { type: 'finish', reason: 'error', error: { code: 'provider_error', message: 'The server is busy.', retryable: true } };
    } });
    const out2 = await failed.service.generate({ prompt: 'x' }, failed.ctx());
    expect(out2).toMatchObject({ isError: true });
    expect(text(out2)).toBe('The server is busy.');
  });

  it('does not retry a failure on its own: a second job would be billed again', async () => {
    const run = vi.fn(async function* (): AsyncGenerator<ImageEvent> {
      yield { type: 'finish', reason: 'error', error: { code: 'provider_error', message: 'busy', retryable: true } };
    });
    const t = setup({ run });
    await t.service.generate({ prompt: 'x' }, t.ctx());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops when the adapter goes quiet after it started', async () => {
    const t = setup({ run: async function* (request) {
      yield { type: 'progress', fraction: 0.1 };
      await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    } });
    await expect(t.service.generate({ prompt: 'x' }, t.ctx())).rejects.toThrow('sent nothing for too long');
  });

  it('ends when the person stops it', async () => {
    const controller = new AbortController();
    const t = setup({ run: async function* () {
      yield { type: 'progress', fraction: 0.1 };
      controller.abort(new Error('Stopped.'));
      yield { type: 'finish', reason: 'aborted' };
    } });
    await expect(t.service.generate({ prompt: 'x' }, t.ctx(controller.signal))).rejects.toThrow('Stopped.');
    expect(t.released).toHaveBeenCalledOnce();
  });

  describe('frames', () => {
    const history: Message[] = [{ id: 'm', sessionId: 's', parentId: null, role: 'user', parts: [{ type: 'image', blob: 'c'.repeat(64), mime: 'image/png' }], createdAt: 0 } as unknown as Message];

    it('starts from an image of the conversation, given by its id only', async () => {
      const t = setup({ history });
      const bad = await t.service.generate({ prompt: 'x', first_frame: '/etc/passwd' }, t.ctx());
      expect(bad).toMatchObject({ isError: true });
      expect(text(bad)).toContain("isn't an image id");
      const missing = await t.service.generate({ prompt: 'x', first_frame: 'img_00000000' }, t.ctx());
      expect(text(missing)).toContain(`There's no image img_00000000 in this conversation. Images here: ${imageId('c'.repeat(64))}.`);
      const ok = await t.service.generate({ prompt: 'x', first_frame: imageId('c'.repeat(64)) }, t.ctx());
      expect(ok.isError).toBeUndefined();
      expect(t.requests.at(-1)!.video!.firstFrame).toMatchObject({ mime: 'image/png' });
    });

    it('leaves a last frame out of a model that cannot end on one, and says so', async () => {
      const t = setup({ history });
      const id = imageId('c'.repeat(64));
      const out = await t.service.generate({ prompt: 'x', first_frame: id, last_frame: id }, t.ctx());
      expect(t.requests[0]!.video!.lastFrame).toBeUndefined();
      expect(text(out)).toContain("can't end on an image");
    });
  });

  describe('models that need a picture', () => {
    const needsPicture = () => info({ capabilities: { ...videoCaps, video: { ...videoCaps.video!, firstFrameRequired: true } } });

    it('says so before using a slot, a limit or any money', async () => {
      const t = setup({ models: [needsPicture()], settings: { maxVideosPerTurn: 1 } });
      const out = await t.service.generate({ prompt: 'x' }, t.ctx());
      expect(out.isError).toBe(true);
      expect(text(out)).toBe('Clip Model makes video only from a picture. Pass the id of one in first_frame, or choose another model.');
      expect(t.requests).toHaveLength(0);
      // The turn's one video is still there to use.
      expect((await setup({ models: [info()], settings: { maxVideosPerTurn: 1 } }).service.generate({ prompt: 'x' }, t.ctx())).isError).toBeUndefined();
    });

    it('tells the model in the list, and about a length it cannot choose', async () => {
      const t = setup({ models: [info({ capabilities: { ...videoCaps, video: { ...videoCaps.video!, firstFrameRequired: true, fixedLength: true } } })] });
      expect(await t.service.modelList({ userId: null, mode: 'chat', temporary: false })).toContain('the model chooses the length; 480p/720p; 16:9 or 9:16; sound optional; needs a picture to start from, in first_frame');
    });
  });

  describe('limits', () => {
    it('allows two clips a turn and then says to stop', async () => {
      const t = setup();
      expect((await t.service.generate({ prompt: 'a' }, t.ctx())).isError).toBeUndefined();
      expect((await t.service.generate({ prompt: 'b' }, t.ctx())).isError).toBeUndefined();
      const third = await t.service.generate({ prompt: 'c' }, t.ctx());
      expect(third.isError).toBe(true);
      expect(text(third)).toContain('limit of 2 videos in one turn');
      expect(t.requests).toHaveLength(2);
    });

    it('counts parallel calls, and hands a failed one’s place back', async () => {
      const t = setup({ settings: { maxVideosPerTurn: 1 } });
      const [a, b] = await Promise.all([t.service.generate({ prompt: 'a' }, t.ctx()), t.service.generate({ prompt: 'b' }, t.ctx())]);
      expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1);
      const failing = setup({ settings: { maxVideosPerTurn: 1 }, run: async function* () {
        yield { type: 'finish', reason: 'error', error: { code: 'x', message: 'busy', retryable: false } };
      } });
      await failing.service.generate({ prompt: 'a' }, failing.ctx());
      await failing.service.generate({ prompt: 'b' }, failing.ctx());
      expect(failing.requests).toHaveLength(2);
    });

    it('counts a person’s clips today from usage, and their spend', async () => {
      const t = setup({ userId: 'ada', settings: { maxVideosPerUserPerDay: 1 } });
      await t.db.insert(usageEvents).values({ id: 'u1', ts: Date.now(), userId: 'ada', providerId: 'vid', modelId: 'm', input: 0, output: 0, videos: 1, videoSeconds: 6, costUsd: 0.3 });
      const out = await t.service.generate({ prompt: 'x' }, t.ctx());
      expect(out.isError).toBe(true);
      expect(text(out)).toContain('limit of 1 videos a day');
      const spend = setup({ userId: 'ada', settings: { maxVideoSpendPerUserPerDayUsd: 0.25 } });
      await spend.db.insert(usageEvents).values({ id: 'u1', ts: Date.now(), userId: 'ada', providerId: 'vid', modelId: 'm', input: 0, output: 0, videos: 1, videoSeconds: 6, costUsd: 0.3 });
      expect(text(await spend.service.generate({ prompt: 'x' }, spend.ctx()))).toContain('limit of $0.25 of videos a day');
    });

    it('does not count pictures against the clip limits', async () => {
      const t = setup({ userId: 'ada', settings: { maxVideosPerUserPerDay: 1 } });
      await t.db.insert(usageEvents).values({ id: 'u1', ts: Date.now(), userId: 'ada', providerId: 'img', modelId: 'p', input: 0, output: 0, images: 9, costUsd: 5 });
      expect((await t.service.generate({ prompt: 'x' }, t.ctx())).isError).toBeUndefined();
    });
  });

  describe('cost', () => {
    it('uses what the service reported', async () => {
      const t = setup({ run: async function* () {
        yield { type: 'usage', costUsd: 0.42 };
        yield { type: 'video', bytes: MP4 };
        yield { type: 'finish', reason: 'done' };
      } });
      const out = await t.service.generate({ prompt: 'x' }, t.ctx());
      expect(out.generated?.[0]).toMatchObject({ costUsd: 0.42, costEstimated: false });
    });

    it('prices by the admin’s per-second price at the resolution, as an estimate', async () => {
      const t = setup({ pricing: { 'vid/m': { bySecond: { '720p': 0.1 } } } });
      const out = await t.service.generate({ prompt: 'x' }, t.ctx());
      // One second, as the file says.
      expect(out.generated?.[0]).toMatchObject({ costUsd: 0.1, costEstimated: true });
    });

    it('leaves a clip unpriced when nothing says what it cost', async () => {
      const out = await setup().service.generate({ prompt: 'x' }, setup().ctx());
      expect(out.generated?.[0]!.costUsd).toBeUndefined();
    });
  });

  describe('models', () => {
    it('lists only video models for itself, and GenerateImage’s service lists none of them', async () => {
      const t = setup({ models: [info(), imageInfo()] });
      expect((await t.service.models({ userId: null, mode: 'chat', temporary: false })).map((m) => m.ref)).toEqual(['vid/m']);
    });

    it('describes each model by what it takes', async () => {
      const t = setup({ models: [info({ description: 'Fast' })] });
      expect(await t.service.modelList({ userId: null, mode: 'chat', temporary: false })).toBe('- vid/m (Clip Model, Fast): 4, 6, 8 seconds, usually 6; 480p/720p; 16:9 or 9:16; sound optional; can start from an image; prompt in plain sentences');
    });

    it('offers none while videos are off, and hides hidden models from non-admins', async () => {
      const off = setup({ settings: { videoEnabled: false } });
      expect(await off.service.available({ userId: null, mode: 'chat', temporary: false })).toBe(false);
      const hidden = setup({ models: [info({ hidden: true })] });
      expect(await hidden.service.available({ userId: null, mode: 'chat', temporary: false })).toBe(false);
      const admin = setup({ models: [info({ hidden: true })], admin: true });
      expect(await admin.service.available({ userId: null, mode: 'chat', temporary: false })).toBe(true);
    });

    it('puts the person’s default first and says what is available when asked for another', async () => {
      const second = info({ ref: 'vid/n', modelId: 'n', displayName: 'Other' });
      const t = setup({ models: [info(), second], preferred: 'vid/n' });
      expect((await t.service.models({ userId: 'u', mode: 'chat', temporary: false })).map((m) => m.ref)).toEqual(['vid/n', 'vid/m']);
      const out = await t.service.generate({ prompt: 'x', model: 'nope' }, t.ctx());
      expect(text(out)).toBe(`There's no video model "nope". You can use: vid/n, vid/m.`);
    });

    it('tells the model when there is none', async () => {
      const t = setup({ models: [] });
      expect(text(await t.service.generate({ prompt: 'x' }, t.ctx()))).toContain('No video model is available');
    });

    it('does not offer a model on a computer that is away', async () => {
      const t = setup({ models: [info({ available: false })] });
      expect(await t.service.available({ userId: 'u', mode: 'chat', temporary: false })).toBe(false);
    });
  });
});

describe('the image service beside video', () => {
  it('never offers a video model to GenerateImage', async () => {
    const t = setup({ models: [info(), imageInfo()] });
    const images = new ImageService({
      registry: t.registry,
      blobs: { put: async () => ({ sha256: '', size: 0, mime: '', createdAt: 0 }) as never, read: async () => PNG },
      files: { addGenerated: async () => {} },
      db: t.db,
      settings: () => ({ imageGeneration: { enabled: true, maxImagesPerTurn: 8 }, imageModels: { overrides: {} }, imagePricing: {}, models: { defaults: {}, aliases: {}, overrides: {} } }) as never,
      session: async () => ({ userId: null, mode: 'chat', temporary: false }),
      preferred: async () => undefined,
      isAdmin: async () => false,
      history: async () => [],
      turnStart: async () => 1,
      download: async () => ({ bytes: PNG, mime: 'image/png' }),
      recordUsage: () => {},
    });
    expect((await images.models({ userId: null, mode: 'chat', temporary: false })).map((m) => m.ref)).toEqual(['img/p']);
  });
});
