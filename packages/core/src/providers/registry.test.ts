import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { devices, modelCache, users } from '../store/schema.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { NodeWorkspaceFs } from '../fs/workspace-fs.ts';
import { SettingsService } from '../settings/settings-service.ts';
import { AesGcmCipher, SecretStore } from '../secrets/secret-store.ts';
import { ModelUnavailableError } from '../agent/chat-service.ts';
import { PersonalProviderRepo, type PersonalAccess } from './personal.ts';
import { ProviderRegistry } from './registry.ts';
import type { AdapterDeps, ProviderAdapter, ProviderInstance } from './types.ts';

let dir: string;
let db: Db;
let settings: SettingsService;
let secrets: SecretStore;
const instances: ProviderInstance[] = [];
const requests: import('./types.ts').ChatRequest[] = [];

const factory = (instance: ProviderInstance): ProviderAdapter => {
  instances.push(instance);
  return {
    type: instance.type,
    health: async () => ({ ok: true, latencyMs: 12, version: '1.0', warnings: [] }),
    listModels: async () => [
      {
        ref: `${instance.id}/small`,
        providerId: instance.id,
        modelId: 'small',
        displayName: 'Small',
        contextLength: 8192,
        maxOutput: 2048,
        capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: false },
        tier: 'compact',
        source: 'detected',
      },
    ],
    stream: async function* (req) {
      requests.push(req);
      yield { type: 'finish' as const, reason: 'end' as const };
    },
  };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-reg-'));
  db = openDatabase(':memory:');
  settings = new SettingsService(new NodeWorkspaceFs(), dir);
  await settings.load();
  secrets = new SecretStore(db, new AesGcmCipher(Buffer.alloc(32, 3)));
  instances.length = 0;
});
afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const offline = async (): Promise<Response> => {
  throw new TypeError('fetch failed');
};

function registry(env: Record<string, string> = {}, fetch: (url: string) => Promise<Response> = offline) {
  return new ProviderRegistry({ db, settings, secrets, env, createAdapter: factory, adapterDeps: { fetch, readBlob: async () => new Uint8Array() } });
}

describe('ProviderRegistry', () => {
  it('keeps OpenRouter discovery out of the picker until curated, preserving favorites and defaults', async () => {
    const r = registry();
    await r.save({ id: 'router', type: 'openai-compatible', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: {}, enabled: true });
    expect((await r.listModels())[0]?.hidden).toBe(true);
    expect(await r.firstAvailable()).toBeUndefined();
    await settings.set('global', ['models', 'overrides', 'router/small', 'hidden'], false);
    expect(await r.firstAvailable()).toBe('router/small');
    await r.refresh();
    expect((await r.resolve('router/small')).info.hidden).toBe(false);
    await settings.reset('global', ['models', 'overrides', 'router/small']);
    await settings.set('global', ['models', 'overrides', 'router/small', 'favorite'], true);
    expect((await r.listModels())[0]?.hidden).toBe(false);
    await settings.set('global', ['models', 'overrides', 'router/small', 'hidden'], true);
    expect((await r.listModels())[0]?.hidden).toBe(true);
    await settings.reset('global', ['models', 'overrides', 'router/small']);
    await settings.set('global', ['models', 'defaults', 'chat'], 'router/small');
    expect((await r.listModels())[0]?.hidden).toBe(false);
  });
  it('saves a provider with its key in the secret store, never in settings', async () => {
    const r = registry();
    await r.save({ id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/', apiKey: 'sk-secret-9999', headers: {}, enabled: true });
    const file = await readFile(join(dir, 'settings.json'), 'utf8');
    expect(file).not.toContain('sk-secret');
    expect(file).toContain('${secret:provider-anthropic}');
    expect(instances.at(-1)?.apiKey).toBe('sk-secret-9999');
    expect(instances.at(-1)?.baseUrl).toBe('https://api.anthropic.com');
    expect(r.statusList()[0]).toMatchObject({ providerId: 'anthropic', ok: true, modelCount: 1 });
  });

  it('recalculates cached context offline while preserving a separate explicit request override', async () => {
    await settings.set('global', ['providers'], [{ id: 'gpu', type: 'ollama', name: 'GPU', baseUrl: 'http://localhost:11434', enabled: true, headers: {}, vramGiB: 16 }]);
    const cached = (await factory({ id: 'gpu', type: 'ollama', name: 'GPU', baseUrl: 'http://localhost:11434', headers: {} }).listModels())[0]!;
    await db.insert(modelCache).values({ providerId: 'gpu', modelId: 'small', discoveredAt: Date.now(), info: { ...cached, contextLength: 8192,
      contextEstimate: { modelBytes: 8 * 1024 ** 3, metadata: { trainedContext: 131072, layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 } },
    } });
    const r = registry();
    expect((await r.listModels())[0]).toMatchObject({ contextLength: 57600, calculatedContextLength: 57600 });
    await settings.set('global', ['providers', 0, 'vramGiB'], 24);
    expect((await r.listModels())[0]?.calculatedContextLength).toBe(119808);
    await settings.set('global', ['models', 'overrides', 'gpu/small', 'contextLength'], 65536);
    expect((await r.resolve('gpu/small')).info).toMatchObject({ contextLength: 65536, calculatedContextLength: 119808 });
  });

  it('round-trips memory and concurrency budgets through test, save and settings edits, preserving model overrides', async () => {
    const r = registry();
    const draft = { id: 'gpu', type: 'ollama' as const, name: 'GPU', baseUrl: 'http://localhost:11434', headers: {}, enabled: true, vramGiB: 24.5, parallelRequests: 2, modelsAtOnce: 3 };
    await r.test(draft);
    expect(instances.at(-1)).toMatchObject({ vramGiB: 24.5, parallelRequests: 2, modelsAtOnce: 3 });
    const changed = vi.fn();
    r.on('models', changed);
    await r.save(draft);
    expect(changed).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ ref: 'gpu/small' })]));
    expect(settings.effective.providers[0]).toMatchObject({ vramGiB: 24.5 });
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).providers[0].vramGiB).toBe(24.5);
    await settings.set('global', ['models', 'overrides', 'gpu/small', 'contextLength'], 65536);
    expect((await r.resolve('gpu/small')).info.contextLength).toBe(65536);
    await settings.set('global', ['providers', 0, 'vramGiB'], 48);
    await r.syncWithSettings();
    expect(instances.at(-1)?.vramGiB).toBe(48);
    expect((await r.resolve('gpu/small')).info.contextLength).toBe(65536);
    await r.save({ ...draft, vramGiB: undefined });
    expect(settings.effective.providers[0]?.vramGiB).toBeUndefined();
    expect(instances.at(-1)?.vramGiB).toBeUndefined();
  });

  it('resolves a model during its discovery with what discovery finds, not the fallback', async () => {
    await settings.set('global', ['providers'], [{ id: 'local', type: 'ollama', name: 'Local', baseUrl: 'http://localhost:11434', headers: {}, enabled: true }]);
    const r = registry();
    const syncing = r.syncWithSettings();
    const { info } = await r.resolve('local/small');
    expect(info).toMatchObject({ source: 'detected', contextLength: 8192, maxOutput: 2048 });
    await syncing;
  });

  it('lists discovered models with overrides applied and resolves them', async () => {
    const r = registry();
    await r.save({ id: 'local', type: 'ollama', name: 'Local', baseUrl: 'http://localhost:11434', headers: {}, enabled: true });
    await settings.set('global', ['models', 'overrides', 'local/small'], { displayName: 'Tiny', contextLength: 4096, favorite: true });
    const [m] = await r.listModels();
    expect(m).toMatchObject({ ref: 'local/small', displayName: 'Tiny', contextLength: 4096, favorite: true, source: 'override' });
    const resolved = await r.resolve('local/small');
    expect(resolved.info.contextLength).toBe(4096);
    expect(await r.firstAvailable()).toBe('local/small');
  });

  it('lists a model added by id for its provider until it is removed, and through refreshes', async () => {
    const r = registry();
    await r.save({ id: 'local', type: 'openai-compatible', name: 'Local', baseUrl: 'http://localhost:1234/v1', headers: {}, enabled: true });
    await settings.set('global', ['models', 'overrides', 'local/glm-5.3-flash-free'], { manual: true });
    await settings.set('global', ['models', 'overrides', 'gone/extra'], { manual: true });
    const added = (await r.listModels()).find((m) => m.modelId === 'glm-5.3-flash-free');
    expect(added).toMatchObject({ ref: 'local/glm-5.3-flash-free', providerId: 'local', manual: true, source: 'default', contextLength: 32_768, tier: 'full', hidden: false });
    expect((await r.listModels()).map((m) => m.ref)).toEqual(['local/glm-5.3-flash-free', 'local/small']);

    await r.refresh('local');
    expect((await r.listModels()).map((m) => m.ref)).toContain('local/glm-5.3-flash-free');
    expect((await r.resolve('local/glm-5.3-flash-free')).info.modelId).toBe('glm-5.3-flash-free');

    await settings.set('global', ['models', 'overrides', 'local/small', 'manual'], true);
    expect((await r.listModels()).find((m) => m.ref === 'local/small')).toMatchObject({ source: 'detected' });
    expect((await r.listModels()).find((m) => m.ref === 'local/small')?.manual).toBeUndefined();

    await settings.reset('global', ['models', 'overrides', 'local/glm-5.3-flash-free']);
    expect((await r.listModels()).map((m) => m.ref)).toEqual(['local/small']);
  });

  it('uses a rotated key on the next request', async () => {
    const r = registry();
    await r.save({ id: 'x', type: 'openai', name: 'X', baseUrl: 'https://api.openai.com', apiKey: 'old-key', headers: {}, enabled: true });
    const before = (await r.resolve('x/small')).adapter;
    expect((await r.resolve('x/small')).adapter).toBe(before);
    await secrets.set({ id: 'provider-x', label: 'X', kind: 'api_key', value: 'new-key' });
    expect((await r.resolve('x/small')).adapter).not.toBe(before);
    expect(instances.at(-1)?.apiKey).toBe('new-key');
  });

  it('removes a provider together with its secret and cached models', async () => {
    const r = registry();
    await r.save({ id: 'x', type: 'openai', name: 'X', baseUrl: 'https://api.openai.com', apiKey: 'k', headers: {}, enabled: true });
    await r.remove('x');
    expect(await secrets.has('provider-x')).toBe(false);
    expect(await r.listModels()).toEqual([]);
    await expect(r.resolve('x/small')).rejects.toThrow(/not configured/);
  });

  it('wraps models marked "prompted" so tools travel in the prompt instead of the API', async () => {
    const r = registry();
    await r.save({ id: 'local', type: 'ollama', name: 'Local', baseUrl: 'http://localhost:11434', headers: {}, enabled: true });
    await settings.set('global', ['models', 'overrides', 'local/small', 'toolCalling'], 'prompted');
    const { adapter } = await r.resolve('local/small');
    const tool = { name: 'artifact', description: 'Make an artifact', inputSchema: { type: 'object', properties: {} } };
    for await (const _ of adapter.stream({ model: 'small', system: [{ text: 'base' }], messages: [], tools: [tool], maxOutputTokens: 100, signal: new AbortController().signal })) void _;
    expect(requests.at(-1)!.tools ?? []).toEqual([]);
    expect(requests.at(-1)!.system.map((b) => b.text).join('\n')).toContain('artifact');
    expect((await r.resolve('local/small')).adapter).toBe(adapter);
  });

  it('picks up providers added outside the app and does not re-probe after its own save', async () => {
    const r = registry();
    const models: string[][] = [];
    r.on('models', (list: { ref: string }[]) => models.push(list.map((m) => m.ref)));
    settings.on('change', () => void r.syncWithSettings());

    await settings.set('global', ['providers'], [{ id: 'hand', type: 'ollama', name: 'Hand-edited', baseUrl: 'http://127.0.0.1:11500' }]);
    await r.syncWithSettings();
    expect(models.at(-1)).toEqual(['hand/small']);

    const probes = instances.length;
    await r.save({ id: 'second', type: 'ollama', name: 'Second', baseUrl: 'http://127.0.0.1:11501', headers: {}, enabled: true });
    await r.syncWithSettings();
    expect(instances.length - probes).toBe(1);
  });

  it('sizes each server’s queue from settings, else from what it reports, else from where it runs', async () => {
    const r = new ProviderRegistry({
      db,
      settings,
      secrets,
      env: {},
      // The llama.cpp server says it has 4 slots.
      createAdapter: (instance) => ({ ...factory(instance), ...(instance.type === 'llamacpp' ? { serverLimits: async () => ({ parallel: 4, modelsAtOnce: 1 }) } : {}) }),
      adapterDeps: { fetch: offline, readBlob: async () => new Uint8Array() },
    });
    await r.save({ id: 'ollama', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', headers: {}, enabled: true });
    await r.save({ id: 'llama', type: 'llamacpp', name: 'llama.cpp', baseUrl: 'http://gpu-box:8080', headers: {}, enabled: true });
    await r.save({ id: 'claude', type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', headers: {}, enabled: true });
    expect(r.statusList().map((s) => [s.providerId, s.queue])).toEqual([
      ['ollama', { parallel: 1, modelsAtOnce: 1 }],
      ['llama', { parallel: 4, modelsAtOnce: 1 }],
      ['claude', { parallel: 16, modelsAtOnce: null }],
    ]);
    await r.save({ id: 'ollama', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', headers: {}, enabled: true, parallelRequests: 2, modelsAtOnce: 3 });
    expect(r.statusList()[0]?.queue).toEqual({ parallel: 2, modelsAtOnce: 3 });
    expect(settings.effective.providers[0]).toMatchObject({ parallelRequests: 2, modelsAtOnce: 3 });
  });

  it('keeps helper work on the loaded model when the server holds one model at a time', async () => {
    const r = registry();
    await r.save({ id: 'gpu', type: 'ollama', name: 'GPU', baseUrl: 'http://localhost:11434', headers: {}, enabled: true });
    await r.save({ id: 'gpu-alias', type: 'openai-compatible', name: 'Same GPU', baseUrl: 'http://LOCALHOST:11434/', headers: {}, enabled: true });
    await r.save({ id: 'cloud', type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', headers: {}, enabled: true });
    // Same server, one model at a time: stay on the conversation's model, even through another provider entry.
    expect(r.avoidSwap('gpu/qwen3:8b', 'gpu/qwen3:32b')).toBe('gpu/qwen3:32b');
    expect(r.avoidSwap('gpu-alias/qwen3:8b', 'gpu/qwen3:32b')).toBe('gpu/qwen3:32b');
    // Another server, or one with room for both: the model asked for.
    expect(r.avoidSwap('cloud/claude-haiku-5-5', 'gpu/qwen3:32b')).toBe('cloud/claude-haiku-5-5');
    expect(r.avoidSwap('gpu/qwen3:8b', 'cloud/claude-opus-5-5')).toBe('gpu/qwen3:8b');
    await r.save({ id: 'gpu', type: 'ollama', name: 'GPU', baseUrl: 'http://localhost:11434', headers: {}, enabled: true, modelsAtOnce: 2 });
    expect(r.avoidSwap('gpu/qwen3:8b', 'gpu/qwen3:32b')).toBe('gpu/qwen3:8b');
  });

  it('says which server gave no answer in time, in the test and in the provider’s status', async () => {
    // Every check's time runs out at once; the server never answers.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    const r = new ProviderRegistry({
      db,
      settings,
      secrets,
      env: {},
      createAdapter: (instance) => ({
        ...factory(instance),
        health: async (signal) => {
          throw signal!.reason;
        },
      }),
      adapterDeps: { fetch: offline, readBlob: async () => new Uint8Array() },
    });
    try {
      const draft = { id: 'lan', type: 'ollama' as const, name: 'LAN', baseUrl: 'http://192.168.1.50:11434', headers: {}, enabled: true };
      const message = 'No answer from 192.168.1.50:11434 within 6 seconds. Check that the server is running and that this computer can reach it (firewall, address, port).';
      expect((await r.test(draft)).status).toMatchObject({ ok: false, error: message });
      await r.save(draft);
      expect(r.statusList()[0]).toMatchObject({ ok: false, error: message });
      // Health checks wait 6 seconds, not 15.
      expect(timeout.mock.calls).toEqual([[6_000], [6_000]]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('detects local servers only when they answer with their own API shape', async () => {
    const r = registry({}, async (url) => {
      if (url === 'http://localhost:11434/api/version') return Response.json({ version: '0.12.3' });
      // Some unrelated web app on llama.cpp's default port.
      if (url === 'http://localhost:8080/health') return new Response('<!doctype html><title>HomeHub</title>', { headers: { 'content-type': 'text/html' } });
      throw new TypeError('fetch failed');
    });
    expect(await r.detect()).toEqual([{ type: 'ollama', baseUrl: 'http://localhost:11434', label: 'Ollama', via: 'port' }]);
  });

  it('accepts a llama.cpp server that is still loading its model', async () => {
    const r = registry({}, async (url) =>
      url === 'http://localhost:8080/health' ? Response.json({ error: { code: 503, message: 'Loading model' } }, { status: 503 }) : offline(),
    );
    expect((await r.detect()).map((d) => d.type)).toEqual(['llamacpp']);
  });

  it('suggests providers from environment keys without exposing them', async () => {
    const r = registry({ ANTHROPIC_API_KEY: 'sk-env' });
    const found = await r.detect();
    const env = found.find((f) => f.via === 'env');
    expect(env).toMatchObject({ type: 'anthropic', envVar: 'ANTHROPIC_API_KEY' });
    expect(JSON.stringify(found)).not.toContain('sk-env');
  });
});

describe('personal providers', () => {
  const OWN = 'u-aaaaaaaaaa';
  /** Computers connected and lending, by device id. */
  let connected: Set<string>;
  let fetched: string[][];
  let tools: Record<string, Record<string, 'native' | 'prompted' | 'none'>>;
  let built: { id: string; deps: AdapterDeps }[];
  const inspected = vi.fn(offline);

  beforeEach(async () => {
    connected = new Set(['laptop']);
    fetched = [];
    tools = {};
    built = [];
    const now = Date.now();
    await db.insert(users).values(['ada', 'bob'].map((id) => ({ id, username: id, name: id, role: 'user' as const, passwordHash: 'x', createdAt: now, updatedAt: now })));
    await db.insert(devices).values({ id: 'laptop', userId: 'ada', name: 'Ada’s Laptop', platform: 'darwin', createdAt: now, lastSeenAt: now });
  });

  function personalRegistry() {
    const access: PersonalAccess = {
      repo: new PersonalProviderRepo(db),
      lends: (_userId, deviceId) => connected.has(deviceId),
      fetch: (userId, deviceId, providerId) => {
        fetched.push([userId, deviceId, providerId]);
        return offline;
      },
      chatgptChat: () => ({ request: async () => '{"signedIn":true}' }),
      toolCalling: async (userId) => tools[userId] ?? {},
      setToolCalling: async (userId, ref, value) => void (tools[userId] = { ...tools[userId], [ref]: value }),
    };
    return new ProviderRegistry({
      db,
      settings,
      secrets,
      env: {},
      createAdapter: (instance, deps) => {
        built.push({ id: instance.id, deps });
        return factory(instance);
      },
      adapterDeps: { fetch: inspected, readBlob: async () => new Uint8Array() },
      personal: access,
    });
  }
  const draft = { id: OWN, type: 'ollama' as const, name: 'My Ollama', baseUrl: 'http://localhost:11434/' };

  it('serves a person’s own models to them alone, through their computer, and says when it isn’t connected', async () => {
    const r = personalRegistry();
    await r.savePersonal('ada', 'laptop', draft);
    expect((await r.listModels('ada')).find((m) => m.ref === `${OWN}/small`)).toMatchObject({ personal: { deviceId: 'laptop', deviceName: 'Ada’s Laptop' }, available: true });
    expect(await r.listModels('bob')).toEqual([]);
    expect(await r.listModels()).toEqual([]);
    expect(await r.firstAvailable()).toBeUndefined();

    expect((await r.resolve(`${OWN}/small`, 'ada')).info.personal?.deviceName).toBe('Ada’s Laptop');
    expect(instances.at(-1)).toMatchObject({ id: OWN, baseUrl: 'http://localhost:11434' });
    // Its requests go out from the laptop, never through the request inspector.
    const own = built.findLast((b) => b.id === OWN)!.deps;
    expect(own.fetch).not.toBe(inspected);
    await own.fetch('http://localhost:11434/api/tags', {}).catch(() => undefined);
    expect(fetched.at(-1)).toEqual(['ada', 'laptop', OWN]);
    expect(inspected).not.toHaveBeenCalled();

    // Anyone else, or no one, is told it isn't there.
    await expect(r.resolve(`${OWN}/small`, 'bob')).rejects.toThrow(`${OWN}/small isn't available.`);
    await expect(r.resolve(`${OWN}/small`)).rejects.toBeInstanceOf(ModelUnavailableError);

    connected.delete('laptop');
    expect((await r.listModels('ada')).find((m) => m.ref === `${OWN}/small`)?.available).toBe(false);
    await expect(r.resolve(`${OWN}/small`, 'ada')).rejects.toThrow("My Ollama runs on Ada’s Laptop, which isn't connected.");
    expect((await r.personalProviders('ada'))[0]).toMatchObject({ id: OWN, online: false, deviceName: 'Ada’s Laptop', hasKey: false });
    expect(await r.personalProviders('bob')).toEqual([]);
  });

  it('keeps its id shape and its key to its owner', async () => {
    const r = personalRegistry();
    await r.savePersonal('ada', 'laptop', { ...draft, apiKey: 'sk-own-1234' });
    expect(instances.at(-1)?.apiKey).toBe('sk-own-1234');
    expect((await r.personalProviders('ada'))[0]?.hasKey).toBe(true);
    expect(await secrets.forSettings(`provider-user-ada-${OWN}`)).toBeUndefined();
    expect(await secrets.forUser('bob', `provider-user-ada-${OWN}`)).toBeUndefined();
    // An admin provider can't take a personal provider's id, or the shape of one.
    await expect(r.save({ id: OWN, type: 'ollama', name: 'Taken', baseUrl: 'http://localhost:11434', headers: {}, enabled: true })).rejects.toThrow("can't be a provider id");
    await expect(r.save({ id: 'u-bbbbbbbbbb', type: 'ollama', name: 'Shape', baseUrl: 'http://localhost:11434', headers: {}, enabled: true })).rejects.toThrow("can't be a provider id");
    // Nor can another person.
    await expect(r.savePersonal('bob', 'laptop', draft)).rejects.toThrow('taken');
    await expect(r.removePersonal('bob', OWN)).rejects.toThrow('gone');
    // A new one needs the computer it runs on.
    await expect(r.savePersonal('ada', null, { ...draft, id: 'u-cccccccccc' })).rejects.toThrow('desktop app');

    await r.removePersonal('ada', OWN);
    expect(await secrets.has(`provider-user-ada-${OWN}`)).toBe(false);
    expect(await r.listModels('ada')).toEqual([]);
  });

  it('queues a computer’s server apart from the same address next to the server', async () => {
    const r = personalRegistry();
    await r.save({ id: 'local', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', headers: {}, enabled: true });
    await r.savePersonal('ada', 'laptop', draft);
    const signal = new AbortController().signal;
    const held = await r.agentTurn('local/small', signal);
    // The server's own Ollama takes one sub-agent at a time; the laptop's has a queue of its own.
    await expect(r.agentTurn(`${OWN}/small`, signal, undefined, 'ada')).resolves.toBeTypeOf('function');
    let next = false;
    void r.agentTurn('local/small', signal).then(() => (next = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(next).toBe(false);
    held();
    await vi.waitFor(() => expect(next).toBe(true));
  });

  it('tells only the owner when their models change, and finds them again when their computer comes back', async () => {
    const r = personalRegistry();
    const told: string[] = [];
    const shared = vi.fn();
    r.on('personalModels', (userId) => told.push(userId));
    r.on('models', shared);
    await r.savePersonal('ada', 'laptop', draft);
    expect(told).toEqual(['ada']);
    expect(shared).not.toHaveBeenCalled();

    await r.devicesChanged('ada');
    connected.delete('laptop');
    await db.delete(modelCache);
    await r.devicesChanged('ada');
    expect((await r.listModels('ada')).length).toBe(0);
    connected.add('laptop');
    await r.devicesChanged('ada');
    // Back: its models are asked for again.
    expect((await r.listModels('ada')).map((m) => [m.ref, m.available])).toEqual([[`${OWN}/small`, true]]);
    expect(told).toEqual(['ada', 'ada', 'ada', 'ada']);
    // Someone without their own providers hears nothing.
    await r.devicesChanged('bob');
    expect(told).toHaveLength(4);
  });

  it('records a tool-calling test of a person’s own model in their prefs, not the admin’s settings', async () => {
    const r = personalRegistry();
    await r.savePersonal('ada', 'laptop', draft);
    expect(await r.probeTools(`${OWN}/small`, 'ada')).toMatchObject({ native: false });
    expect(tools.ada).toEqual({ [`${OWN}/small`]: 'prompted' });
    expect(settings.effective.models.overrides).toEqual({});
    expect((await r.resolve(`${OWN}/small`, 'ada')).info.capabilities.tools).toBe('prompted');
  });
});
