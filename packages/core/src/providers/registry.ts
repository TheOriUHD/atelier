/**
 * Builds adapters from configured providers, discovers and caches models, merges user overrides,
 * tracks provider health and handles the "Add provider" flow (test, save, detect, remove).
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_BASE_URLS,
  modelRef,
  parseModelRef,
  presetOf,
  PROVIDER_LABELS,
  type ModelInfo,
  type ProviderConfig,
  type ProviderStatus,
  type ProviderType,
  type Settings,
} from '@atelier/protocol';
import type { DetectedProvider, ProviderDraft } from '@atelier/protocol';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { SettingsService } from '../settings/settings-service.ts';
import type { Db } from '../store/db.ts';
import { modelCache } from '../store/schema.ts';
import { interpolate } from '../util/interpolate.ts';
import { ModelUnavailableError, type ModelResolver, type ResolvedModel } from '../agent/chat-service.ts';
import { tierFor } from './catalog.ts';
import { estimateContext } from './context-estimator.ts';
import { isAbortError, noAnswerError } from './http.ts';
import { withPromptedTools } from './prompted-tools.ts';
import { defaultLimits, RequestScheduler, serverName, type ServerLimits } from './scheduler.ts';
import type { AdapterDeps, HealthResult, ProviderAdapter, ProviderInstance } from './types.ts';

export type AdapterFactory = (instance: ProviderInstance, deps: AdapterDeps) => ProviderAdapter;
type DiscoveredModel = Omit<ModelInfo, 'hidden' | 'favorite' | 'order'>;

export interface RegistryDeps {
  db: Db;
  settings: SettingsService;
  secrets: SecretStore;
  env: Record<string, string | undefined>;
  createAdapter: AdapterFactory;
  adapterDeps: AdapterDeps;
}

const DETECT_TIMEOUT_MS = 800;
/** A health check that gets no answer this soon says so: the server is down or unreachable. */
const HEALTH_TIMEOUT_MS = 6_000;
/** Listing models may ask the server about each one in turn. */
const DISCOVERY_TIMEOUT_MS = 15_000;

/** Why a health check or model listing that threw failed, in words: a timeout names the server's address. */
function checkError(error: unknown, baseUrl: string, timeoutMs: number): string {
  if (isAbortError(error)) return noAnswerError(baseUrl, timeoutMs);
  return error instanceof Error ? error.message : 'Unreachable';
}

/** Order-independent identity of a provider config (settings normalization may reorder keys). */
const configKey = (p: ProviderConfig): string => JSON.stringify(Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Default local ports and the response that proves the expected server is behind them. */
const PORT_PROBES: { type: ProviderType; label: string; path: string; accepts(status: number, body: unknown): boolean }[] = [
  { type: 'ollama', label: PROVIDER_LABELS.ollama, path: '/api/version', accepts: (s, b) => s === 200 && isObject(b) && typeof b.version === 'string' },
  // llama-server answers 503 {"error":…} while it is still loading the model.
  { type: 'llamacpp', label: PROVIDER_LABELS.llamacpp, path: '/health', accepts: (s, b) => isObject(b) && ((s === 200 && b.status === 'ok') || (s === 503 && 'error' in b)) },
  { type: 'openai-compatible', label: 'LM Studio', path: '/models', accepts: (s, b) => s === 200 && isObject(b) && Array.isArray(b.data) },
];

export class ProviderRegistry extends EventEmitter<{ status: [ProviderStatus[]]; models: [ModelInfo[]] }> implements ModelResolver {
  private adapters = new Map<string, { key: string; adapter: ProviderAdapter }>();
  /** Provider configs as last probed, to notice edits made outside save/remove (e.g. a hand-edited settings.json). */
  private known = new Map<string, string>();
  private overridesKey = '';
  private syncing: Promise<void> = Promise.resolve();
  private statuses = new Map<string, ProviderStatus>();
  /** One queue per model server, for every request and sub-agent run (providers/scheduler.ts). */
  private readonly scheduler = new RequestScheduler();
  /** What each provider's server said about its capacity, by provider id. */
  private reported = new Map<string, { parallel?: number; modelsAtOnce?: number }>();

  constructor(private readonly deps: RegistryDeps) {
    super();
  }

  private get providers(): ProviderConfig[] {
    return this.deps.settings.effective.providers;
  }

  private async instance(config: ProviderConfig | ProviderDraft, rawKey?: string): Promise<ProviderInstance> {
    const resolvers = { secret: (id: string) => this.deps.secrets.forSettings(id), env: (name: string) => this.deps.env[name] };
    const apiKey = rawKey ?? (config.apiKey ? (await interpolate(config.apiKey, resolvers)).value : undefined);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.headers ?? {})) headers[k] = (await interpolate(v, resolvers)).value;
    return { id: config.id, type: config.type, name: config.name, baseUrl: config.baseUrl.replace(/\/+$/, ''), ...(apiKey ? { apiKey } : {}), headers,
      ...(config.vramGiB !== undefined ? { vramGiB: config.vramGiB } : {}),
      ...(config.parallelRequests !== undefined ? { parallelRequests: config.parallelRequests } : {}),
      ...(config.modelsAtOnce !== undefined ? { modelsAtOnce: config.modelsAtOnce } : {}),
      ...(config.temporaryChat !== undefined ? { temporaryChat: config.temporaryChat } : {}),
    };
  }

  private async adapterFor(config: ProviderConfig): Promise<ProviderAdapter> {
    // Keyed on the resolved key and headers too, so a rotated secret takes effect on the next request.
    const instance = await this.instance(config);
    const key = createHash('sha256').update(JSON.stringify(instance)).digest('hex');
    const cached = this.adapters.get(config.id);
    if (cached && cached.key === key) return cached.adapter;
    // Limits are read per request, so an edit in Settings applies to the next one.
    const adapter = this.scheduler.wrap(this.deps.createAdapter(instance, this.deps.adapterDeps), serverName(config.baseUrl), () => this.limits(config.id) ?? defaultLimits(config.baseUrl));
    this.adapters.set(config.id, { key, adapter });
    return adapter;
  }

  /** The provider's server limits: from settings, else as the server reported them, else the defaults for where it runs. */
  private limits(providerId: string): ServerLimits | null {
    const config = this.providers.find((p) => p.id === providerId);
    if (!config) return null;
    const reported = this.reported.get(providerId) ?? {};
    const fallback = defaultLimits(config.baseUrl);
    return {
      parallel: config.type === 'chatgpt-chat' ? 1 : config.parallelRequests ?? reported.parallel ?? fallback.parallel,
      modelsAtOnce: config.modelsAtOnce ?? reported.modelsAtOnce ?? fallback.modelsAtOnce,
    };
  }

  /**
   * `ref`, unless running it would make a server that holds one model at a time swap out `current` (a sub-agent's,
   * summary's or title's model next to the conversation's): then `current`, which is loaded already.
   */
  avoidSwap(ref: string, current: string): string {
    const a = parseModelRef(ref);
    const b = parseModelRef(current);
    if (!a || !b || ref === current) return ref;
    const configA = this.providers.find((p) => p.id === a.providerId);
    const configB = this.providers.find((p) => p.id === b.providerId);
    if (!configA?.enabled || !configB?.enabled || serverName(configA.baseUrl) !== serverName(configB.baseUrl)) return ref;
    return (this.limits(configB.id)?.modelsAtOnce ?? Infinity) <= 1 ? current : ref;
  }

  /** Waits until a sub-agent may start on the server of `ref` (as many at once as it answers requests); returns the release. */
  async agentTurn(ref: string, signal: AbortSignal, onWait?: (ahead: number | null) => void): Promise<() => void> {
    const config = this.providers.find((p) => p.id === parseModelRef(ref)?.providerId);
    if (!config) return () => {};
    return this.scheduler.agentTurn(serverName(config.baseUrl), () => this.limits(config.id) ?? defaultLimits(config.baseUrl), signal, onWait);
  }

  // ------------------------------------------------------------- models

  private calculated(model: DiscoveredModel): DiscoveredModel {
    const provider = this.providers.find((p) => p.id === model.providerId);
    const calculatedContextLength = provider?.type === 'ollama' && model.contextEstimate
      ? estimateContext({ ...provider, ...model.contextEstimate }) : undefined;
    return calculatedContextLength ? { ...model, contextLength: calculatedContextLength, calculatedContextLength } : model;
  }

  private configured(model: DiscoveredModel): ModelInfo {
    const settings = this.deps.settings.effective;
    const info = applyOverrides(this.calculated(model), settings.models.overrides);
    const provider = this.providers.find((p) => p.id === model.providerId);
    const override = settings.models.overrides[model.ref];
    if (provider && presetOf(provider.baseUrl) === 'openrouter' && override?.hidden === undefined) {
      const selected = [...Object.values(settings.models.defaults), ...Object.values(settings.models.aliases)].includes(model.ref);
      info.hidden = !info.favorite && !info.manual && !selected;
    }
    return info;
  }

  async listModels(): Promise<ModelInfo[]> {
    const enabled = new Set(this.providers.filter((p) => p.enabled).map((p) => p.id));
    const rows = await this.deps.db.select().from(modelCache).all();
    const overrides = this.deps.settings.effective.models.overrides;
    const reported = rows.filter((r) => enabled.has(r.providerId)).map((r) => r.info as unknown as DiscoveredModel);
    const known = new Set(reported.map((m) => m.ref));
    const manual = Object.entries(overrides).flatMap(([ref, o]) => {
      const parsed = o.manual && !known.has(ref) ? parseModelRef(ref) : null;
      const config = parsed && enabled.has(parsed.providerId) ? this.providers.find((p) => p.id === parsed.providerId) : undefined;
      return config && parsed ? [{ ...fallbackModel(config, parsed.modelId), manual: true }] : [];
    });
    return [...reported, ...manual]
      .map((m) => this.configured(m))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.order - b.order || a.displayName.localeCompare(b.displayName));
  }

  async resolve(ref: string): Promise<ResolvedModel> {
    const parsed = parseModelRef(ref);
    if (!parsed) throw new ModelUnavailableError(`Invalid model "${ref}".`, 'settings/models');
    const config = this.providers.find((p) => p.id === parsed.providerId);
    if (!config) throw new ModelUnavailableError(`The provider for ${ref} is not configured.`);
    if (!config.enabled) throw new ModelUnavailableError(`${config.name} is disabled.`);
    const find = async () => (await this.deps.db.select().from(modelCache).where(eq(modelCache.providerId, parsed.providerId)).all()).find((r) => r.modelId === parsed.modelId);
    // Not discovered yet: a request right after startup or a provider change waits for the discovery in flight
    // rather than running on guessed limits (no reasoning control, an 8k reply cap).
    const cached = (await find()) ?? (await this.syncing.then(find));
    const base: DiscoveredModel = cached ? (cached.info as unknown as DiscoveredModel) : fallbackModel(config, parsed.modelId);
    const info = this.configured(base);
    const adapter = await this.adapterFor(config);
    // Models without native tool calling get tools described in the prompt and parsed from the text (§7).
    return { adapter: info.capabilities.tools === 'prompted' ? this.prompted(adapter) : adapter, info };
  }

  private promptedAdapters = new WeakMap<ProviderAdapter, ProviderAdapter>();
  private prompted(adapter: ProviderAdapter): ProviderAdapter {
    let wrapped = this.promptedAdapters.get(adapter);
    if (!wrapped) this.promptedAdapters.set(adapter, (wrapped = withPromptedTools(adapter)));
    return wrapped;
  }

  async firstAvailable(): Promise<string | undefined> {
    return (await this.listModels()).find((m) => !m.hidden)?.ref;
  }

  // ------------------------------------------------------------- health

  statusList(): ProviderStatus[] {
    return this.providers.map((p) => {
      const status = this.statuses.get(p.id) ?? { providerId: p.id, ok: false, latencyMs: null, modelCount: 0, warnings: [], checkedAt: 0 };
      const limits = this.limits(p.id) ?? defaultLimits(p.baseUrl);
      return { ...status, queue: { parallel: limits.parallel, modelsAtOnce: Number.isFinite(limits.modelsAtOnce) ? limits.modelsAtOnce : null } };
    });
  }

  /** Re-checks health and re-discovers models for one or all providers. */
  /**
   * Call on every settings change: re-probes added or edited providers and republishes the model list when
   * overrides change. Calls are serialized, so awaiting one also waits for any sync already in flight.
   */
  syncWithSettings(): Promise<void> {
    const run = this.syncing.then(() => this.sync());
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async sync(): Promise<void> {
    const current = new Map(this.providers.map((p) => [p.id, configKey(p)]));
    const changed = [...current].filter(([id, key]) => this.known.get(id) !== key).map(([id]) => id);
    for (const id of this.known.keys()) {
      if (current.has(id)) continue;
      this.adapters.delete(id);
      this.statuses.delete(id);
    }
    const removed = [...this.known.keys()].some((id) => !current.has(id));
    const overridesKey = JSON.stringify(this.deps.settings.effective.models);
    const overridesChanged = overridesKey !== this.overridesKey;
    this.known = current;
    this.overridesKey = overridesKey;
    if (changed.length > 0) await Promise.all(changed.map((id) => this.refresh(id)));
    else if (removed || overridesChanged) {
      this.emit('status', this.statusList());
      this.emit('models', await this.listModels());
    }
  }

  async refresh(id?: string): Promise<ProviderStatus[]> {
    const targets = this.providers.filter((p) => p.enabled && (!id || p.id === id));
    await Promise.all(targets.map((p) => this.refreshOne(p)));
    this.emit('status', this.statusList());
    this.emit('models', await this.listModels());
    return this.statusList();
  }

  private async refreshOne(config: ProviderConfig): Promise<void> {
    const adapter = await this.adapterFor(config);
    this.reported.delete(config.id);
    let timeoutMs = HEALTH_TIMEOUT_MS;
    try {
      const health = await adapter.health(AbortSignal.timeout(timeoutMs));
      let models: DiscoveredModel[] = [];
      if (health.ok) {
        timeoutMs = DISCOVERY_TIMEOUT_MS;
        const signal = AbortSignal.timeout(timeoutMs);
        models = await adapter.listModels(signal);
        await this.storeModels(config.id, models);
        const reported = await adapter.serverLimits?.(signal).catch(() => undefined);
        if (reported) this.reported.set(config.id, reported);
      }
      this.statuses.set(config.id, { ...health, providerId: config.id, modelCount: models.length, checkedAt: Date.now() });
    } catch (error) {
      this.statuses.set(config.id, {
        providerId: config.id,
        ok: false,
        latencyMs: null,
        modelCount: 0,
        warnings: [],
        error: checkError(error, config.baseUrl, timeoutMs),
        checkedAt: Date.now(),
      });
    }
  }

  private async storeModels(providerId: string, models: DiscoveredModel[]): Promise<void> {
    const now = Date.now();
    await this.deps.db.delete(modelCache).where(eq(modelCache.providerId, providerId));
    for (const m of models) {
      await this.deps.db.insert(modelCache).values({ providerId, modelId: m.modelId, info: m as unknown as Record<string, unknown>, discoveredAt: now });
    }
  }

  // ------------------------------------------------------- add-provider flow

  async test(draft: ProviderDraft): Promise<{ status: ProviderStatus; models: ModelInfo[] }> {
    const rawKey = draft.apiKeyFromEnv ? this.deps.env[draft.apiKeyFromEnv] : draft.apiKey;
    const adapter = this.deps.createAdapter(await this.instance({ ...draft, apiKey: undefined }, rawKey), this.deps.adapterDeps);
    const health: HealthResult = await adapter.health(AbortSignal.timeout(HEALTH_TIMEOUT_MS)).catch((error: unknown) => ({ ok: false, latencyMs: null, warnings: [], error: checkError(error, draft.baseUrl, HEALTH_TIMEOUT_MS) }));
    const models = health.ok ? await adapter.listModels(AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)).catch(() => [] as DiscoveredModel[]) : [];
    const overrides = this.deps.settings.effective.models.overrides;
    return {
      status: { ...health, providerId: draft.id, modelCount: models.length, checkedAt: Date.now() },
      models: models.map((m) => applyOverrides(m, overrides)),
    };
  }

  /** Stores the key in the secret store and writes the provider (with a secret reference) to settings. */
  async save(draft: ProviderDraft): Promise<ProviderConfig> {
    const rawKey = draft.apiKeyFromEnv ? this.deps.env[draft.apiKeyFromEnv] : draft.apiKey;
    const existing = this.providers.find((p) => p.id === draft.id);
    let apiKey = existing?.apiKey;
    if (rawKey) {
      const secretId = await this.deps.secrets.set({ id: `provider-${draft.id}`, label: `${draft.name} API key`, kind: 'api_key', value: rawKey });
      apiKey = `\${secret:${secretId}}`;
    }
    const config: ProviderConfig = {
      id: draft.id,
      type: draft.type,
      name: draft.name,
      baseUrl: draft.baseUrl.replace(/\/+$/, ''),
      headers: draft.headers ?? {},
      enabled: draft.enabled ?? true,
      ...(apiKey ? { apiKey } : {}),
      ...(draft.vramGiB !== undefined ? { vramGiB: draft.vramGiB } : {}),
      ...(draft.parallelRequests ? { parallelRequests: draft.parallelRequests } : {}),
      ...(draft.modelsAtOnce ? { modelsAtOnce: draft.modelsAtOnce } : {}),
    };
    const list = this.providers.filter((p) => p.id !== draft.id);
    const index = existing ? this.providers.findIndex((p) => p.id === draft.id) : list.length;
    list.splice(index, 0, config);
    this.known.set(config.id, configKey(config));
    await this.deps.settings.set('global', ['providers'], list);
    this.adapters.delete(draft.id);
    await this.refresh(draft.id);
    return config;
  }

  async remove(id: string): Promise<void> {
    const remaining = this.providers.filter((p) => p.id !== id);
    this.known.delete(id);
    await this.deps.settings.set('global', ['providers'], remaining);
    this.adapters.delete(id);
    this.statuses.delete(id);
    this.reported.delete(id);
    await this.deps.db.delete(modelCache).where(eq(modelCache.providerId, id));
    if (await this.deps.secrets.has(`provider-${id}`)) await this.deps.secrets.delete(`provider-${id}`);
    this.emit('status', this.statusList());
    this.emit('models', await this.listModels());
  }

  /** Finds local servers on default ports and API keys in the environment (values are never returned). */
  async detect(): Promise<DetectedProvider[]> {
    const configured = new Set(this.providers.map((p) => `${p.type}|${p.baseUrl}`));
    const found: DetectedProvider[] = [];
    await Promise.all(
      PORT_PROBES.map(async (p) => {
        const url = DEFAULT_BASE_URLS[p.type];
        if (configured.has(`${p.type}|${url}`)) return;
        try {
          const res = await this.deps.adapterDeps.fetch(url + p.path, { signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) });
          // Other local apps answer on these ports too; only accept the server's own JSON shape.
          const body: unknown = await res.json().catch(() => null);
          if (p.accepts(res.status, body)) found.push({ type: p.type, baseUrl: url, label: p.label, via: 'port' });
        } catch {
          // Nothing listening.
        }
      }),
    );
    for (const [envVar, type] of [['ANTHROPIC_API_KEY', 'anthropic'], ['OPENAI_API_KEY', 'openai']] as const) {
      if (this.deps.env[envVar] && !this.providers.some((p) => p.type === type)) {
        found.push({ type, baseUrl: DEFAULT_BASE_URLS[type], label: PROVIDER_LABELS[type], via: 'env', envVar });
      }
    }
    return found.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** One-shot native tool-call test; records the result as an override so the picker shows it. */
  async probeTools(ref: string): Promise<{ native: boolean; detail: string }> {
    const { adapter, info } = await this.resolve(ref);
    const signal = AbortSignal.timeout(60_000);
    let called = false;
    let error = '';
    for await (const ev of adapter.stream({
      model: info.modelId,
      system: [{ text: 'You are testing tool calling. Always call the provided tool.' }],
      messages: [{ id: 'p', sessionId: 'p', parentId: null, role: 'user', parts: [{ type: 'text', text: 'What is the weather in Paris? Use the tool.' }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: Date.now() }],
      tools: [{ name: 'get_weather', description: 'Get the current weather for a city.', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      maxOutputTokens: 512,
      effort: null,
      contextLength: info.contextLength,
      signal,
    })) {
      if (ev.type === 'tool_call_end' && ev.input && typeof ev.input === 'object') called = true;
      if (ev.type === 'finish' && ev.error) error = ev.error.message;
    }
    await this.deps.settings.set('global', ['models', 'overrides', ref, 'toolCalling'], called ? 'native' : 'prompted');
    this.emit('models', await this.listModels());
    return { native: called, detail: called ? 'The model returned a native tool call.' : error || 'No native tool call; switched to prompted tool calling.' };
  }
}

export function applyOverrides(m: DiscoveredModel, overrides: Settings['models']['overrides']): ModelInfo {
  const o = overrides[m.ref] ?? {};
  const tools = o.toolCalling ?? m.capabilities.tools;
  return {
    ...m,
    displayName: o.displayName ?? m.displayName,
    contextLength: o.contextLength ?? m.contextLength,
    maxOutput: o.maxOutputTokens ?? m.maxOutput,
    capabilities: { ...m.capabilities, tools, vision: o.vision ?? m.capabilities.vision },
    tier: o.promptTier ?? m.tier,
    // Adding a model by id says nothing about its capabilities.
    source: Object.keys(o).some((k) => k !== 'manual') ? 'override' : m.source,
    hidden: o.hidden ?? false,
    favorite: o.favorite ?? false,
    order: o.order ?? 1000,
    ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
  };
}

/** Used when a model is configured or added by id but was never discovered (e.g. provider offline at startup). */
function fallbackModel(config: ProviderConfig, modelId: string): DiscoveredModel {
  const frontier = config.type === 'anthropic' || config.type === 'openai';
  return {
    ref: modelRef(config.id, modelId),
    providerId: config.id,
    modelId,
    displayName: modelId,
    contextLength: frontier ? 200_000 : 32_768,
    maxOutput: frontier ? 32_000 : 8192,
    capabilities: { tools: 'native', vision: frontier, pdf: config.type === 'anthropic', reasoning: frontier ? 'effort' : 'none', caching: config.type === 'anthropic' },
    tier: tierFor(config.type, modelId),
    source: 'default',
  };
}
