import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelCache } from '../store/schema.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { NodeWorkspaceFs } from '../fs/workspace-fs.ts';
import { SettingsService } from '../settings/settings-service.ts';
import { AesGcmCipher, SecretStore } from '../secrets/secret-store.ts';
import { ProviderRegistry } from './registry.ts';
import type { ProviderAdapter, ProviderInstance } from './types.ts';

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
