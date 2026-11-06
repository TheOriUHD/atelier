import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { audioId, type AudioCapabilities, type ImageModelInfo, type RunEvent } from '@atelier/protocol';
import { openDatabase } from '../store/db.ts';
import { generatedImages, usageEvents } from '../store/schema.ts';
import type { ToolContext } from '../tools/types.ts';
import { pcmToWav } from './audio.ts';
import { AudioService, DEFAULT_AUDIO_PER_TURN, type AudioServiceDeps } from './audio-service.ts';
import { soundModel } from './dialects/audio-common.ts';
import { HOSTED_DEFAULTS } from './catalog.ts';
import { ImageModelUnavailable, type ImageProviderRegistry } from './registry.ts';
import { ImageService } from './service.ts';
import type { ImageEvent, ImageRequest } from './types.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/audio/${name}`, import.meta.url)));
const MP3 = fixture('tone-cbr.mp3');
const FLAC = fixture('tone.flac');

const speech: AudioCapabilities = { kinds: ['speech'], voices: [{ id: 'alloy', name: 'Alloy', description: 'neutral' }, { id: 'v2', name: 'Bella' }], defaultVoice: 'alloy', direction: true, maxChars: 100 };
const music: AudioCapabilities = { kinds: ['music', 'sound'], durations: { kind: 'range', min: 5, max: 60, step: 1 }, defaultSeconds: 20, lyrics: true, vocals: 'optional' };
const model = (ref: string, audio: AudioCapabilities, over: Partial<ImageModelInfo> = {}): ImageModelInfo => {
  const [providerId, modelId] = ref.split('/') as [string, string];
  return { ref, providerId, modelId, displayName: modelId.toUpperCase(), capabilities: soundModel(audio, { seed: true }), source: 'detected', hidden: false, favorite: false, order: 0, ...over };
};
const SPEECH = model('tts/voice', speech);
const MUSIC = model('mus/song', music);
const PICTURE: ImageModelInfo = { ref: 'img/p', providerId: 'img', modelId: 'p', displayName: 'Pic', capabilities: { ...HOSTED_DEFAULTS }, source: 'detected', hidden: false, favorite: false, order: 0 };

interface Setup {
  run?: (request: ImageRequest) => AsyncIterable<ImageEvent>;
  models?: ImageModelInfo[];
  settings?: Record<string, unknown>;
  personal?: { deviceId: string; fetch: () => Promise<Response> };
  userId?: string | null;
  preferred?: Partial<Record<'speech' | 'music' | 'sound', string>>;
  defaults?: Record<string, string>;
  overrides?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
}

async function* done(bytes: Uint8Array = MP3, extra: Partial<Extract<ImageEvent, { type: 'audio' }>> = {}): AsyncGenerator<ImageEvent> {
  yield { type: 'queued', ahead: 0 };
  yield { type: 'progress', step: 3, steps: 10 };
  yield { type: 'audio', bytes, ...extra };
  yield { type: 'finish', reason: 'done' };
}

function setup({ run = () => done(), models = [SPEECH, MUSIC, PICTURE], settings = {}, personal, userId = null, preferred = {}, defaults = {}, overrides = {}, pricing = {} }: Setup = {}) {
  const db = openDatabase(':memory:');
  db.$client.exec('PRAGMA foreign_keys = OFF');
  const requests: ImageRequest[] = [];
  const adapter = { type: 'openai-speech' as const, listModels: async () => [], health: async () => ({ ok: true, latencyMs: 1, warnings: [] }), generate: (request: ImageRequest) => (requests.push(request), run(request)), free: vi.fn(async () => {}) };
  const released = vi.fn();
  const registry = {
    listModels: async () => models,
    resolve: async (ref: string) => {
      const found = models.find((m) => m.ref === ref);
      if (!found) throw new ImageModelUnavailable('gone');
      return { adapter, info: found, config: { id: found.providerId, type: 'openai-speech', name: 'Sound Provider', baseUrl: 'https://sound.example.com', headers: {}, enabled: true }, ...(personal ? { personal } : {}) };
    },
    hold: async () => released,
    freeText: vi.fn(async () => {}),
  } as unknown as ImageProviderRegistry;
  const usage = vi.fn();
  const download = vi.fn(async () => ({ bytes: FLAC, mime: 'audio/flac' as const }));
  const addGenerated = vi.fn(async () => {});
  const put = vi.fn(async (bytes: Uint8Array, mime: string) => ({ sha256: (bytes === FLAC ? 'f' : 'a').repeat(64), size: bytes.length, mime, createdAt: 0 }));
  const deps: AudioServiceDeps = {
    registry,
    blobs: { put },
    files: { addGenerated },
    db,
    settings: () => ({ imageGeneration: { enabled: true, maxImagesPerTurn: 8, ...settings }, imageModels: { overrides }, imagePricing: pricing, models: { defaults, aliases: {}, overrides: {} } }) as never,
    session: async () => ({ userId, mode: 'chat', temporary: false }),
    preferred: async (_user, kind) => preferred[kind],
    isAdmin: async () => false,
    turnStart: async () => 1,
    download,
    recordUsage: usage,
    idleMs: 40,
  };
  const service = new AudioService(deps);
  const events: RunEvent[] = [];
  const ctx = (signal = new AbortController().signal): ToolContext => ({ sessionId: 's', messageId: 'a', callId: 'c', signal, emit: (e) => events.push(e) });
  return { service, requests, events, ctx, usage, addGenerated, released, db, download, put, deps };
}

const text = (out: { content: { type: string; text?: string }[] }) => (out.content[0] as { text: string }).text;

describe('AudioService', () => {
  it('reads text aloud, keeps the sound and tells the model its id without handing it the bytes', async () => {
    const t = setup();
    const out = await t.service.generate({ kind: 'speech', text: 'Hello there.', voice: 'bella' }, t.ctx());
    expect(out.isError).toBeUndefined();
    const id = audioId('a'.repeat(64));
    expect(out.content).toHaveLength(1);
    expect(text(out)).toContain(id);
    expect(text(out)).toContain('voice Bella');
    expect(text(out)).toContain("You can't hear it.");
    expect(out.generated?.[0]).toMatchObject({ id, kind: 'audio', audioKind: 'speech', mime: 'audio/mpeg', prompt: 'Hello there.', voice: 'Bella', width: 0, height: 0, modelName: 'VOICE' });
    expect(out.generated?.[0]?.seconds).toBeCloseTo(1.5, 0);
    expect(t.requests[0]).toMatchObject({ model: 'voice', prompt: 'Hello there.', count: 1, audio: { kind: 'speech', voice: 'v2' } });
    expect(t.addGenerated).toHaveBeenCalledWith(expect.objectContaining({ mime: 'audio/mpeg', name: 'hello-there-aaaaaa.mp3' }));
    expect(t.db.select().from(generatedImages).all()).toMatchObject([{ kind: 'audio', mime: 'audio/mpeg', width: 0, height: 0, prompt: 'Hello there.', params: { audioKind: 'speech', voice: 'v2', voiceName: 'Bella' } }]);
    expect(t.usage).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'tts', chars: 12, mode: 'chat' }));
    expect(t.released).toHaveBeenCalledOnce();
  });

  it('makes music with a model that makes music, and fits the length to it', async () => {
    const t = setup();
    const out = await t.service.generate({ kind: 'music', prompt: 'calm piano', seconds: 90, lyrics: 'la la la' }, t.ctx());
    expect(out.isError).toBeUndefined();
    expect(t.requests[0]).toMatchObject({ model: 'song', prompt: 'calm piano', audio: { kind: 'music', seconds: 60, lyrics: 'la la la' } });
    expect(text(out)).toContain('5 to 60 seconds');
    expect(out.generated?.[0]).toMatchObject({ audioKind: 'music', lyrics: 'la la la' });
  });

  it("uses the person's choice for the kind, then the server's, and a conversation goes to a model with enough voices", async () => {
    const other = model('tts/other', speech);
    const duo = model('tts/duo', { ...speech, maxSpeakers: 2 });
    const t = setup({ models: [SPEECH, other, duo], preferred: { speech: 'tts/other' } });
    await t.service.generate({ kind: 'speech', text: 'Hi' }, t.ctx());
    expect(t.requests[0]?.model).toBe('other');
    const u = setup({ models: [SPEECH, other], defaults: { speech: 'tts/other' } });
    await u.service.generate({ kind: 'speech', text: 'Hi' }, u.ctx());
    expect(u.requests[0]?.model).toBe('other');
    const v = setup({ models: [SPEECH, duo] });
    await v.service.generate({ kind: 'speech', text: 'A: hi\nB: yo', speakers: [{ name: 'A', voice: 'alloy' }, { name: 'B', voice: 'Bella' }] }, v.ctx());
    expect(v.requests[0]).toMatchObject({ model: 'duo', audio: { speakers: [{ name: 'A', voice: 'alloy' }, { name: 'B', voice: 'v2' }] } });
  });

  it('says what the models here make when none makes the kind asked for', async () => {
    const t = setup({ models: [SPEECH] });
    const out = await t.service.generate({ kind: 'music', prompt: 'a song' }, t.ctx());
    expect(out.isError).toBe(true);
    expect(text(out)).toBe('No model here makes music; the sound models here make speech. Tell the person.');
    const none = setup({ models: [PICTURE] });
    expect(text(await none.service.generate({ kind: 'speech', text: 'x' }, none.ctx()))).toContain('No sound model is available');
  });

  it('asks for the words, and for a description, before any slot or money is used', async () => {
    const t = setup();
    expect(text(await t.service.generate({ kind: 'speech' }, t.ctx()))).toContain('needs `text`');
    expect(text(await t.service.generate({ kind: 'sound', prompt: ' ' }, t.ctx()))).toContain('needs `prompt`');
    expect(t.requests).toHaveLength(0);
  });

  it('refuses text longer than the model reads, without making anything', async () => {
    const t = setup();
    const out = await t.service.generate({ kind: 'speech', text: 'x'.repeat(101) }, t.ctx());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('at most 100');
    expect(t.requests).toHaveLength(0);
  });

  it('keeps to the per-turn limit, which is six unless the admin says otherwise', async () => {
    expect(DEFAULT_AUDIO_PER_TURN).toBe(6);
    const t = setup({ settings: { maxAudioPerTurn: 1 } });
    await t.service.generate({ kind: 'speech', text: 'one' }, t.ctx());
    const second = await t.service.generate({ kind: 'speech', text: 'two' }, t.ctx());
    expect(second.isError).toBe(true);
    expect(text(second)).toContain('limit of 1 sound in one turn');
  });

  it('keeps to the per-person daily limits, counted from usage', async () => {
    const t = setup({ userId: 'u', settings: { maxAudioPerUserPerDay: 1 } });
    t.db.insert(usageEvents).values({ id: 'e', ts: Date.now(), userId: 'u', providerId: 'tts', modelId: 'voice', input: 0, output: 0, audios: 1 }).run();
    const out = await t.service.generate({ kind: 'speech', text: 'x' }, t.ctx());
    expect(text(out)).toContain('limit of 1 sounds a day');
  });

  it('is off when the admin turns sound off, and when image generation is off', async () => {
    expect(await setup({ settings: { audioEnabled: false } }).service.available({ userId: null, mode: 'chat', temporary: false })).toBe(false);
    expect(await setup({ settings: { enabled: false } }).service.available({ userId: null, mode: 'chat', temporary: false })).toBe(false);
    expect(await setup().service.available({ userId: null, mode: 'chat', temporary: false })).toBe(true);
  });

  it('wraps raw samples as a WAV, and fetches a sound that is only a URL', async () => {
    const pcm = new Uint8Array(48_000);
    const t = setup({ run: () => done(pcm, { mime: 'audio/L16;rate=24000' }) });
    const out = await t.service.generate({ kind: 'speech', text: 'raw' }, t.ctx());
    expect(out.generated?.[0]).toMatchObject({ mime: 'audio/wav', seconds: 1 });
    expect(t.put.mock.calls[0]![0]).toEqual(pcmToWav(pcm, 24_000));
    const u = setup({
      run: async function* () {
        yield { type: 'audio', url: 'https://cdn.example.com/a.flac' };
        yield { type: 'finish', reason: 'done' };
      },
    });
    const fetched = await u.service.generate({ kind: 'music', prompt: 'x' }, u.ctx());
    expect(u.download).toHaveBeenCalledWith('https://cdn.example.com/a.flac', expect.anything(), undefined);
    expect(fetched.generated?.[0]).toMatchObject({ mime: 'audio/flac' });
  });

  it('refuses what came back when it is not a sound', async () => {
    const t = setup({ run: () => done(new TextEncoder().encode('<html>oops</html>')) });
    await expect(t.service.generate({ kind: 'speech', text: 'x' }, t.ctx())).rejects.toThrow("isn't a sound file");
  });

  it('counts a sound the provider made for the turn, even when it is not one Atelier keeps', async () => {
    const t = setup({ settings: { maxAudioPerTurn: 1 }, run: () => done(new TextEncoder().encode('<html>oops</html>')) });
    await expect(t.service.generate({ kind: 'speech', text: 'x' }, t.ctx())).rejects.toThrow("isn't a sound file");
    const again = await t.service.generate({ kind: 'speech', text: 'y' }, t.ctx());
    expect(text(again)).toContain('limit of 1 sound in one turn');
  });

  it("passes a provider's refusal on as final", async () => {
    const t = setup({
      run: async function* () {
        yield { type: 'finish', reason: 'refused', error: { code: 'provider_refused', message: 'Sound Provider refused this: not allowed', retryable: false } };
      },
    });
    const out = await t.service.generate({ kind: 'speech', text: 'x' }, t.ctx());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("That is final: tell the person, and don't reword the request to get past it.");
  });

  it('reports progress with the kind of sound, ending with the stored one', async () => {
    const t = setup();
    await t.service.generate({ kind: 'music', prompt: 'x', seconds: 10 }, t.ctx());
    const progress = t.events.filter((e) => e.type === 'tool_progress').map((e) => (e as Extract<RunEvent, { type: 'tool_progress' }>).progress);
    expect(progress[0]).toMatchObject({ kind: 'audio', audioKind: 'music', seconds: 10 });
    expect(progress.at(-1)?.images?.[0]).toMatchObject({ kind: 'audio' });
  });

  it('prices speech by the character from the list, and leaves a person’s own server free', async () => {
    const tts1 = model('openai/tts-1', speech);
    const t = setup({ models: [tts1] });
    const out = await t.service.generate({ kind: 'speech', text: 'x'.repeat(100) }, t.ctx());
    expect(out.generated?.[0]).toMatchObject({ costUsd: 0.0015, costEstimated: true });
    const mine = setup({ models: [tts1], personal: { deviceId: 'd', fetch: async () => new Response() } });
    const free = await mine.service.generate({ kind: 'speech', text: 'x'.repeat(100) }, mine.ctx());
    expect(free.generated?.[0]?.costUsd).toBeUndefined();
  });

  it('lists the models for the text model with their voices and what each takes', async () => {
    const t = setup({ preferred: { speech: 'tts/voice' } });
    const list = await t.service.modelList({ userId: null, mode: 'chat', temporary: false });
    expect(list).toContain("- tts/voice (VOICE): speech (the person's choice for speech); takes directions for how to speak; at most 100 characters a call");
    expect(list).toContain('voices: alloy (Alloy: neutral) [usual], v2 (Bella)');
    expect(list).toContain('- mus/song (SONG): music, sound effects; 5 to 60 seconds in steps of 1, usually 20; sings lyrics, or instrumental');
    expect(list).not.toContain('img/p');
  });
});

describe('the picture tool and the sound models', () => {
  it("doesn't offer a sound model for pictures", async () => {
    const images = new ImageService({
      registry: { listModels: async () => [SPEECH, PICTURE] } as unknown as ImageProviderRegistry,
      blobs: { put: vi.fn(), read: vi.fn() },
      files: { addGenerated: vi.fn() },
      db: openDatabase(':memory:'),
      settings: () => ({ imageGeneration: { enabled: true, maxImagesPerTurn: 8 }, models: { defaults: {} } }) as never,
      session: async () => ({ userId: null, mode: 'chat', temporary: false }),
      preferred: async () => undefined,
      isAdmin: async () => false,
      history: async () => [],
      turnStart: async () => 0,
      download: vi.fn(),
      recordUsage: vi.fn(),
    } as never);
    expect((await images.models({ userId: null, mode: 'chat', temporary: false })).map((m) => m.ref)).toEqual(['img/p']);
  });
});
