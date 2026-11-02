import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type PersonalImageProviderDraft } from '@atelier/protocol';
import { RequestScheduler } from '../providers/scheduler.ts';
import type { ProviderFetch } from '../providers/types.ts';
import { SecretStore } from '../secrets/secret-store.ts';
import type { SettingsService } from '../settings/settings-service.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { devices, imageModelCache, users } from '../store/schema.ts';
import { HOSTED_DEFAULTS } from './catalog.ts';
import { PersonalImageRepo, type PersonalImageAccess } from './personal.ts';
import { ImageModelUnavailable, ImageProviderRegistry } from './registry.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageInstance, ListedImageModel } from './types.ts';

const OWN = 'u-aaaaaaaaaa';
const THEIRS = 'u-bbbbbbbbbb';
const TEXT = 'u-tttttttttt';

const listed = (providerId: string, modelId: string): ListedImageModel => ({ ref: `${providerId}/${modelId}`, providerId, modelId, displayName: modelId, capabilities: { ...HOSTED_DEFAULTS, family: 'sdxl' }, source: 'detected' });
const draft: PersonalImageProviderDraft = { id: OWN, type: 'comfyui', preset: 'comfyui', name: 'My ComfyUI', baseUrl: 'http://127.0.0.1:8188/' };

let db: Db;
let secrets: SecretStore;
let connected: Set<string>;
let fetched: string[][];
let sockets: { who: string[]; headers: Record<string, string> }[];
let built: { instance: ImageInstance; deps: ImageAdapterDeps }[];
let models: string[];
let healthy: boolean;
const serverFetch = vi.fn<ProviderFetch>(async () => new Response('{}'));
const serverSocket = vi.fn<ImageAdapterDeps['socket']>(async () => {
  throw new Error('not here');
});

const settings = (over: object = {}) => ({ effective: { ...defaultSettings(), ...over }, set: vi.fn() }) as unknown as SettingsService;

function registry(extra: { settings?: SettingsService; scheduler?: RequestScheduler } = {}) {
  const access: PersonalImageAccess = {
    repo: new PersonalImageRepo(db),
    lends: (_userId, deviceId) => connected.has(deviceId),
    fetch: (userId, deviceId, providerId) => {
      fetched.push([userId, deviceId, providerId]);
      return async () => new Response('{}');
    },
    socket: (userId, deviceId, providerId, headers) => {
      sockets.push({ who: [userId, deviceId, providerId], headers });
      return async () => {
        throw new Error('Update the desktop app.');
      };
    },
  };
  return new ImageProviderRegistry({
    db,
    settings: extra.settings ?? settings(),
    secrets,
    env: {},
    createAdapter: (instance, deps): ImageAdapter => {
      built.push({ instance, deps });
      return {
        type: instance.type,
        health: async () => (healthy ? { ok: true, latencyMs: 1, warnings: [] } : { ok: false, latencyMs: null, warnings: [], error: "Couldn't reach it." }),
        listModels: async () => models.map((m) => listed(instance.id, m)),
        generate: async function* () {},
      };
    },
    adapterDeps: { fetch: serverFetch, socket: serverSocket },
    scheduler: extra.scheduler ?? new RequestScheduler(),
    text: { queue: () => null, free: async () => {}, key: async () => undefined, has: () => false, personal: async (id) => id === TEXT },
    personal: access,
  });
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  secrets = new SecretStore(db, { encrypt: async (s) => s, decrypt: async (s) => s });
  connected = new Set(['laptop']);
  fetched = [];
  sockets = [];
  built = [];
  models = ['sdxl'];
  healthy = true;
  serverFetch.mockClear();
  serverSocket.mockClear();
  const now = Date.now();
  await db.insert(users).values(['ada', 'bob'].map((id) => ({ id, username: id, name: id, role: 'user' as const, passwordHash: 'x', createdAt: now, updatedAt: now })));
  await db.insert(devices).values({ id: 'laptop', userId: 'ada', name: 'Ada’s Laptop', platform: 'darwin', createdAt: now, lastSeenAt: now });
});

describe('a person’s own image servers', () => {
  it('serves their models to their owner alone, under their computer’s name', async () => {
    const r = registry();
    await r.savePersonal('ada', 'laptop', draft);
    expect(await r.listModels('ada')).toMatchObject([{ ref: `${OWN}/sdxl`, personal: { deviceId: 'laptop', deviceName: 'Ada’s Laptop' }, available: true, hidden: false }]);
    expect(await r.listModels('bob')).toEqual([]);
    expect(await r.listModels()).toEqual([]);
    expect(await r.personalProviders('bob')).toEqual([]);
    expect(await r.personalProviders('ada')).toMatchObject([{ id: OWN, type: 'comfyui', preset: 'comfyui', baseUrl: 'http://127.0.0.1:8188', deviceName: 'Ada’s Laptop', online: true, hasKey: false, status: { ok: true, modelCount: 1 } }]);
  });

  it('resolves for its owner only, and anyone else is told it doesn’t exist', async () => {
    const r = registry();
    await r.savePersonal('ada', 'laptop', draft);
    const ref = `${OWN}/sdxl`;
    expect((await r.resolve(ref, { admin: false, userId: 'ada' })).info.personal?.deviceName).toBe('Ada’s Laptop');
    await expect(r.resolve(ref, { admin: true, userId: 'bob' })).rejects.toThrow(`There's no image model "${ref}".`);
    await expect(r.resolve(ref, { admin: true, userId: null })).rejects.toBeInstanceOf(ImageModelUnavailable);
  });

  it('goes through the computer for everything, never the server’s own fetch or sockets', async () => {
    const r = registry();
    await r.savePersonal('ada', 'laptop', draft);
    await r.resolve(`${OWN}/sdxl`, { admin: false, userId: 'ada' });
    const { deps } = built.at(-1)!;
    expect(deps.fetch).not.toBe(serverFetch);
    expect(deps.socket).not.toBe(serverSocket);
    expect(deps.chatgpt).toBeUndefined();
    expect(fetched.at(-1)).toEqual(['ada', 'laptop', OWN]);
    expect(sockets.at(-1)).toEqual({ who: ['ada', 'laptop', OWN], headers: {} });
    expect(serverFetch).not.toHaveBeenCalled();
    expect(serverSocket).not.toHaveBeenCalled();
    // A finished image's URL goes the same way.
    const { personal } = await r.resolve(`${OWN}/sdxl`, { admin: false, userId: 'ada' });
    expect(personal?.fetch).toBeTypeOf('function');
    expect(personal?.fetch).not.toBe(serverFetch);
  });

  it('says when its computer is away, and takes it up again when it comes back', async () => {
    const r = registry();
    const told: string[] = [];
    r.on('personalModels', (userId) => told.push(userId));
    await r.savePersonal('ada', 'laptop', draft);
    expect(told).toEqual(['ada']);

    connected.delete('laptop');
    await r.devicesChanged('ada');
    expect((await r.listModels('ada'))[0]).toMatchObject({ available: false });
    expect((await r.personalProviders('ada'))[0]).toMatchObject({ online: false });
    await expect(r.resolve(`${OWN}/sdxl`, { admin: false, userId: 'ada' })).rejects.toThrow("My ComfyUI runs on Ada’s Laptop, which isn't connected.");

    models = ['sdxl', 'flux'];
    connected.add('laptop');
    await r.devicesChanged('ada');
    expect((await r.listModels('ada')).map((m) => [m.modelId, m.available])).toEqual([
      ['flux', true],
      ['sdxl', true],
    ]);
    expect(told).toEqual(['ada', 'ada', 'ada']);
    await r.devicesChanged('bob');
    expect(told).toHaveLength(3);
  });

  it('keeps a change to one person’s models from everyone else', async () => {
    const r = registry();
    const shared = vi.fn();
    r.on('models', shared);
    await r.savePersonal('ada', 'laptop', draft);
    await r.refreshPersonal('ada');
    await r.removePersonal('ada', OWN);
    expect(shared).not.toHaveBeenCalled();
  });

  it('keeps its key as the person’s own secret, read only for them', async () => {
    const r = registry();
    await r.savePersonal('ada', 'laptop', { ...draft, apiKey: 'sk-own-1234' });
    await r.resolve(`${OWN}/sdxl`, { admin: false, userId: 'ada' });
    expect(built.at(-1)!.instance.apiKey).toBe('sk-own-1234');
    expect(sockets.at(-1)!.headers).toEqual({ authorization: 'Bearer sk-own-1234' });
    expect(await secrets.forUser('ada', `provider-user-ada-${OWN}`)).toBe('sk-own-1234');
    expect(await secrets.forSettings(`provider-user-ada-${OWN}`)).toBeUndefined();
    expect(await secrets.forUser('bob', `provider-user-ada-${OWN}`)).toBeUndefined();
    expect((await r.personalProviders('ada'))[0]?.hasKey).toBe(true);
    await r.removePersonal('ada', OWN);
    expect(await secrets.has(`provider-user-ada-${OWN}`)).toBe(false);
  });

  it('won’t let an id be anyone else’s, a text server’s, or an admin provider’s', async () => {
    const r = registry({ settings: settings({ imageProviders: [{ id: THEIRS, type: 'comfyui', name: 'Shared', baseUrl: 'http://gpu:8188', headers: {}, enabled: true }] }) });
    await r.savePersonal('ada', 'laptop', draft);
    await expect(r.savePersonal('bob', 'laptop', draft)).rejects.toThrow('taken');
    await expect(r.testPersonal('bob', 'laptop', draft)).rejects.toThrow('taken');
    await expect(r.removePersonal('bob', OWN)).rejects.toThrow('gone');
    expect(await r.refreshPersonal('bob', OWN)).toEqual([]);
    // A desktop lends addresses by id, so an id means one thing whatever uses it.
    await expect(r.savePersonal('ada', 'laptop', { ...draft, id: TEXT })).rejects.toThrow('taken');
    await expect(r.savePersonal('ada', 'laptop', { ...draft, id: THEIRS })).rejects.toThrow('taken');
    // A new one needs the computer it runs on; an admin can't take the shape of a person's id.
    await expect(r.savePersonal('ada', null, { ...draft, id: 'u-cccccccccc' })).rejects.toThrow('desktop app');
    await expect(r.save({ ...draft, headers: {}, enabled: true })).rejects.toThrow("can't be a provider id");
  });

  it('keeps editing on the computer it was added from', async () => {
    const r = registry();
    await r.savePersonal('ada', 'laptop', draft);
    await r.savePersonal('ada', 'another', { ...draft, name: 'Renamed' });
    expect(await r.personalProviders('ada')).toMatchObject([{ name: 'Renamed', deviceId: 'laptop' }]);
  });

  it('takes what it found with it when removed, and leaves others’ alone', async () => {
    const r = registry();
    await r.savePersonal('ada', 'laptop', draft);
    await db.insert(imageModelCache).values({ providerId: THEIRS, modelId: 'kept', info: {}, discoveredAt: 0 });
    await r.removePersonal('ada', OWN);
    expect(await db.select().from(imageModelCache).all()).toMatchObject([{ providerId: THEIRS }]);
    expect(await r.personalProviders('ada')).toEqual([]);
  });

  it('turned off, it offers nothing and resolves to nothing', async () => {
    const r = registry();
    await r.savePersonal('ada', 'laptop', draft);
    await r.savePersonal('ada', null, { ...draft, enabled: false });
    expect(await r.listModels('ada')).toEqual([]);
    await expect(r.resolve(`${OWN}/sdxl`, { admin: false, userId: 'ada' })).rejects.toThrow('turned off');
  });

  it('tests a draft through the computer before anything is saved', async () => {
    const r = registry();
    healthy = false;
    expect((await r.testPersonal('ada', 'laptop', draft)).status).toMatchObject({ ok: false, error: "Couldn't reach it.", modelCount: 0 });
    expect(await r.personalProviders('ada')).toEqual([]);
    healthy = true;
    const tested = await r.testPersonal('ada', 'laptop', { ...draft, apiKey: 'sk-new' });
    expect(tested.models.map((m) => m.ref)).toEqual([`${OWN}/sdxl`]);
    expect(built.at(-1)!.instance.apiKey).toBe('sk-new');
    expect(await secrets.has(`provider-user-ada-${OWN}`)).toBe(false);
    expect(fetched.at(-1)).toEqual(['ada', 'laptop', OWN]);
  });

  it('needs a server: the desktop’s own backend has no personal providers', async () => {
    const r = new ImageProviderRegistry({
      db,
      settings: settings(),
      secrets,
      env: {},
      createAdapter: () => {
        throw new Error('no');
      },
      adapterDeps: { fetch: serverFetch, socket: serverSocket },
      scheduler: new RequestScheduler(),
      text: { queue: () => null, free: async () => {}, key: async () => undefined, has: () => false, personal: async () => false },
    });
    expect(await r.personalProviders('ada')).toEqual([]);
    expect(await r.personalModels('ada')).toEqual([]);
    expect(await r.refreshPersonal('ada')).toEqual([]);
    await expect(r.savePersonal('ada', 'laptop', draft)).rejects.toThrow('need an Atelier server');
  });
});

describe('the queue of a person’s own image server', () => {
  const signal = new AbortController().signal;
  const job = (r: ImageProviderRegistry, id: string, baseUrl: string, deviceId?: string) =>
    r.hold({ config: { id, type: 'comfyui', name: id, baseUrl, headers: {}, enabled: true }, info: listed(id, 'm') as never, ...(deviceId ? { personal: { deviceId, fetch: serverFetch } } : {}) }, signal, {});

  it('is per computer: the same address elsewhere is a different server', async () => {
    const r = registry();
    const base = 'http://127.0.0.1:8188';
    const here = await job(r, OWN, base, 'laptop');
    // Another computer, and the server's own, have queues of their own.
    await expect(job(r, THEIRS, base, 'desktop')).resolves.toBeTypeOf('function');
    await expect(job(r, 'shared', base)).resolves.toBeTypeOf('function');
    // The same computer's waits: one GPU, one job.
    let next = false;
    void job(r, 'u-dddddddddd', base, 'laptop').then(() => (next = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(next).toBe(false);
    here();
    await vi.waitFor(() => expect(next).toBe(true));
  });

  it('names the computer in the queue, as text does', () => {
    expect(registry().queueOf({ config: { id: OWN, type: 'comfyui', name: 'x', baseUrl: 'http://127.0.0.1:8188', headers: {}, enabled: true }, personal: { deviceId: 'laptop', fetch: serverFetch } }).server).toBe('device:laptop|http://127.0.0.1:8188');
  });

  it('takes its limit from the person’s setting', async () => {
    const r = registry();
    const base = 'http://127.0.0.1:8188';
    const config = { id: OWN, type: 'comfyui' as const, name: OWN, baseUrl: base, headers: {}, enabled: true, parallelRequests: 2 };
    const model = { config, info: listed(OWN, 'm') as never, personal: { deviceId: 'laptop', fetch: serverFetch } };
    await r.hold(model, signal, {});
    await expect(r.hold(model, signal, {})).resolves.toBeTypeOf('function');
  });
});
