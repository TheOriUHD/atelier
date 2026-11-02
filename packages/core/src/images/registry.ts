/**
 * Image providers (ARCHITECTURE §23): the counterpart of providers/registry.ts for the separate `imageProviders` list.
 * Builds adapters, discovers and caches models, merges the admin's overrides, tracks health and handles "Add".
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import { imagePreset, modelRef, parseModelRef, type DetectedImageServer, type ImageModelInfo, type ImageModelOverride, type ImageProviderConfig, type ImageProviderDraft, type ProviderStatus } from '@atelier/protocol';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { SettingsService } from '../settings/settings-service.ts';
import type { Db } from '../store/db.ts';
import { imageModelCache } from '../store/schema.ts';
import { interpolate } from '../util/interpolate.ts';
import { isAbortError, noAnswerError } from '../providers/http.ts';
import { defaultLimits, serverName, type RequestScheduler, type ServerLimits } from '../providers/scheduler.ts';
import type { HealthResult } from '../providers/types.ts';
import { detectImageServers } from './detect.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageAdapterFactory, ImageInstance, ListedImageModel } from './types.ts';

export interface ImageRegistryDeps {
  db: Db;
  settings: SettingsService;
  secrets: SecretStore;
  env: Record<string, string | undefined>;
  createAdapter: ImageAdapterFactory;
  adapterDeps: ImageAdapterDeps;
  /** Shared with the text providers, so a GPU has one queue. */
  scheduler: RequestScheduler;
  /** The text providers an image server can share a GPU with. */
  text: {
    queue(providerId: string): { server: string; limits: () => ServerLimits } | null;
    /** Makes the text server unload what it holds. */
    free(providerId: string, signal: AbortSignal): Promise<void>;
    /** A text provider's raw key, for "use the same key". */
    key(providerId: string): Promise<string | undefined>;
    has(providerId: string): boolean;
  };
}

const HEALTH_TIMEOUT_MS = 6_000;
const DISCOVERY_TIMEOUT_MS = 20_000;

const checkError = (error: unknown, baseUrl: string, timeoutMs: number) => (isAbortError(error) ? noAnswerError(baseUrl, timeoutMs) : error instanceof Error ? error.message : 'Unreachable');
const configKey = (p: ImageProviderConfig) => JSON.stringify(Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))));

function withOverrides(model: ListedImageModel, overrides: Record<string, ImageModelOverride>): ImageModelInfo {
  const o = overrides[model.ref] ?? {};
  return {
    ...model,
    displayName: o.displayName ?? model.displayName,
    ...(o.description ?? model.description ? { description: (o.description ?? model.description)! } : {}),
    capabilities: { ...model.capabilities, ...(o.tuning ? { defaults: { ...model.capabilities.defaults, ...o.tuning } } : {}) },
    source: o.displayName || o.tuning ? 'override' : model.source,
    hidden: o.hidden ?? false,
    favorite: o.favorite ?? false,
    order: o.order ?? 0,
  };
}

export interface ResolvedImageModel {
  adapter: ImageAdapter;
  info: ImageModelInfo;
  config: ImageProviderConfig;
}

export class ImageModelUnavailable extends Error {}

export class ImageProviderRegistry extends EventEmitter<{ status: [ProviderStatus[]]; models: [ImageModelInfo[]] }> {
  private adapters = new Map<string, { key: string; adapter: ImageAdapter }>();
  private statuses = new Map<string, ProviderStatus>();
  private known = new Map<string, string>();
  private overridesKey = '';
  private syncing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ImageRegistryDeps) {
    super();
  }

  private get providers(): ImageProviderConfig[] {
    return this.deps.settings.effective.imageProviders;
  }

  private async instance(config: ImageProviderConfig | ImageProviderDraft, rawKey?: string): Promise<ImageInstance> {
    const resolvers = { secret: (id: string) => this.deps.secrets.forSettings(id), env: (name: string) => this.deps.env[name] };
    const apiKey = rawKey ?? (config.apiKey ? (await interpolate(config.apiKey, resolvers)).value : undefined);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.headers ?? {})) headers[k] = (await interpolate(v, resolvers)).value;
    return {
      id: config.id,
      type: config.type,
      ...(config.preset ? { preset: config.preset } : {}),
      name: config.name,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      ...(apiKey ? { apiKey } : {}),
      headers,
      models: config.models ?? [],
      workflows: config.workflows ?? [],
    };
  }

  private async adapterFor(config: ImageProviderConfig): Promise<ImageAdapter> {
    const instance = await this.instance(config);
    const key = createHash('sha256').update(JSON.stringify(instance)).digest('hex');
    const cached = this.adapters.get(config.id);
    if (cached?.key === key) return cached.adapter;
    const adapter = this.deps.createAdapter(instance, this.deps.adapterDeps);
    this.adapters.set(config.id, { key, adapter });
    return adapter;
  }

  statusList(): ProviderStatus[] {
    return this.providers.flatMap((p) => {
      const status = this.statuses.get(p.id);
      return status ? [status] : [];
    });
  }

  // ------------------------------------------------------------- models

  /** Everything people can pick from, favorites first. */
  async listModels(): Promise<ImageModelInfo[]> {
    const enabled = new Set(this.providers.filter((p) => p.enabled).map((p) => p.id));
    if (enabled.size === 0) return [];
    const { overrides } = this.deps.settings.effective.imageModels;
    const rows = await this.deps.db.select().from(imageModelCache).all();
    return rows
      .filter((r) => enabled.has(r.providerId))
      .map((r) => withOverrides(r.info as unknown as ListedImageModel, overrides))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.order - b.order || a.displayName.localeCompare(b.displayName));
  }

  /** The model behind `ref`, ready to run. `hidden` models are the admin's decision, so only admins reach them. */
  async resolve(ref: string, options: { admin: boolean }): Promise<ResolvedImageModel> {
    const parsed = parseModelRef(ref);
    const config = this.providers.find((p) => p.id === parsed?.providerId);
    if (!parsed || !config) throw new ImageModelUnavailable(`There's no image model "${ref}".`);
    if (!config.enabled) throw new ImageModelUnavailable(`${config.name} is turned off.`);
    const row = await this.deps.db.select().from(imageModelCache).where(eq(imageModelCache.providerId, parsed.providerId)).all();
    const found = row.find((r) => r.modelId === parsed.modelId);
    if (!found) throw new ImageModelUnavailable(`${config.name} has no model "${parsed.modelId}". Refresh it in Settings if it was just added.`);
    const info = withOverrides(found.info as unknown as ListedImageModel, this.deps.settings.effective.imageModels.overrides);
    if (info.hidden && !options.admin) throw new ImageModelUnavailable(`There's no image model "${ref}".`);
    return { adapter: await this.adapterFor(config), info, config };
  }

  /** The queue a job on this provider waits in: a shared GPU's when it has one, else the image server's own. */
  queueOf(config: ImageProviderConfig): { server: string; limits: () => ServerLimits; exclusive: boolean } {
    const shared = config.sharesGpuWith ? this.deps.text.queue(config.sharesGpuWith) : null;
    if (shared) return { ...shared, exclusive: true };
    const fallback = defaultLimits(config.baseUrl);
    return { server: serverName(config.baseUrl), limits: () => ({ parallel: config.parallelRequests ?? fallback.parallel, modelsAtOnce: fallback.modelsAtOnce }), exclusive: false };
  }

  hold(config: ImageProviderConfig, model: string, signal: AbortSignal, options: { onWait?: (ahead: number | null) => void; owner?: string }): Promise<() => void> {
    const { server, limits, exclusive } = this.queueOf(config);
    return this.deps.scheduler.hold(server, limits, `image:${config.id}/${model}`, signal, { ...options, exclusive });
  }

  /** Makes the text server on the same GPU unload what it holds; a server that can't is not a reason to fail. */
  freeText(config: ImageProviderConfig, signal: AbortSignal): Promise<void> {
    return config.sharesGpuWith ? this.deps.text.free(config.sharesGpuWith, signal).catch(() => undefined) : Promise.resolve();
  }

  // ------------------------------------------------------- health and discovery

  syncWithSettings(): Promise<void> {
    const run = this.syncing.then(() => this.sync());
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async sync(): Promise<void> {
    const current = new Map(this.providers.map((p) => [p.id, configKey(p)]));
    const changed = [...current].filter(([id, key]) => this.known.get(id) !== key).map(([id]) => id);
    const removed = [...this.known.keys()].filter((id) => !current.has(id));
    for (const id of removed) {
      this.adapters.delete(id);
      this.statuses.delete(id);
    }
    const overridesKey = JSON.stringify(this.deps.settings.effective.imageModels);
    const overridesChanged = overridesKey !== this.overridesKey;
    this.known = current;
    this.overridesKey = overridesKey;
    if (changed.length > 0) await Promise.all(changed.map((id) => this.refresh(id)));
    else if (removed.length > 0 || overridesChanged) {
      this.emit('status', this.statusList());
      this.emit('models', await this.listModels());
    }
  }

  async refresh(id?: string): Promise<ProviderStatus[]> {
    await Promise.all(this.providers.filter((p) => p.enabled && (!id || p.id === id)).map((p) => this.refreshOne(p)));
    this.emit('status', this.statusList());
    this.emit('models', await this.listModels());
    return this.statusList();
  }

  private async refreshOne(config: ImageProviderConfig): Promise<void> {
    let timeoutMs = HEALTH_TIMEOUT_MS;
    try {
      const adapter = await this.adapterFor(config);
      const health = await adapter.health(AbortSignal.timeout(timeoutMs));
      let models: ListedImageModel[] = [];
      if (health.ok) {
        timeoutMs = DISCOVERY_TIMEOUT_MS;
        models = await adapter.listModels(AbortSignal.timeout(timeoutMs));
        await this.storeModels(config.id, models);
      }
      this.statuses.set(config.id, { ...health, providerId: config.id, modelCount: models.length, checkedAt: Date.now() });
    } catch (error) {
      this.statuses.set(config.id, { providerId: config.id, ok: false, latencyMs: null, modelCount: 0, warnings: [], error: checkError(error, config.baseUrl, timeoutMs), checkedAt: Date.now() });
    }
  }

  private async storeModels(providerId: string, models: ListedImageModel[]): Promise<void> {
    const now = Date.now();
    await this.deps.db.delete(imageModelCache).where(eq(imageModelCache.providerId, providerId));
    for (const m of models) await this.deps.db.insert(imageModelCache).values({ providerId, modelId: m.modelId, info: m as unknown as Record<string, unknown>, discoveredAt: now }).onConflictDoNothing();
  }

  // ------------------------------------------------------- add-provider flow

  private rawKey(draft: ImageProviderDraft): Promise<string | undefined> {
    if (draft.apiKeyFromProvider) return this.deps.text.key(draft.apiKeyFromProvider);
    return Promise.resolve(draft.apiKeyFromEnv ? this.deps.env[draft.apiKeyFromEnv] : draft.apiKey);
  }

  /** An adapter for a draft that isn't saved: its own key if one was typed, else the saved provider's. */
  async draftAdapter(draft: ImageProviderDraft): Promise<{ adapter: ImageAdapter; instance: ImageInstance }> {
    const existing = this.providers.find((p) => p.id === draft.id);
    const raw = await this.rawKey(draft);
    const instance = await this.instance({ ...draft, apiKey: raw ? undefined : existing?.apiKey }, raw);
    return { adapter: this.deps.createAdapter(instance, this.deps.adapterDeps), instance };
  }

  async test(draft: ImageProviderDraft): Promise<{ status: ProviderStatus; models: ImageModelInfo[] }> {
    const { adapter } = await this.draftAdapter(draft);
    const health: HealthResult = await adapter.health(AbortSignal.timeout(HEALTH_TIMEOUT_MS)).catch((error: unknown) => ({ ok: false, latencyMs: null, warnings: [], error: checkError(error, draft.baseUrl, HEALTH_TIMEOUT_MS) }));
    const models = health.ok ? await adapter.listModels(AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)).catch(() => [] as ListedImageModel[]) : [];
    const { overrides } = this.deps.settings.effective.imageModels;
    return { status: { ...health, providerId: draft.id, modelCount: models.length, checkedAt: Date.now() }, models: models.map((m) => withOverrides(m, overrides)) };
  }

  async save(draft: ImageProviderDraft): Promise<ImageProviderConfig> {
    // Usage and prices are keyed on the id, so it can't also be a text provider's.
    if (this.deps.text.has(draft.id)) throw new Error(`"${draft.id}" is already a text provider's id: choose another.`);
    const existing = this.providers.find((p) => p.id === draft.id);
    const rawKey = await this.rawKey(draft);
    let apiKey = existing?.apiKey;
    if (rawKey) apiKey = `\${secret:${await this.deps.secrets.set({ id: `image-provider-${draft.id}`, label: `${draft.name} API key`, kind: 'api_key', value: rawKey })}}`;
    const { apiKey: _key, apiKeyFromEnv: _env, apiKeyFromProvider: _from, ...rest } = draft;
    const config: ImageProviderConfig = { ...rest, baseUrl: draft.baseUrl.replace(/\/+$/, ''), headers: draft.headers ?? {}, enabled: draft.enabled ?? true, ...(apiKey ? { apiKey } : {}) };
    const list = this.providers.filter((p) => p.id !== draft.id);
    list.splice(existing ? this.providers.findIndex((p) => p.id === draft.id) : list.length, 0, config);
    this.known.set(config.id, configKey(config));
    await this.deps.settings.set('global', ['imageProviders'], list);
    this.adapters.delete(draft.id);
    await this.refresh(draft.id);
    return config;
  }

  async remove(id: string): Promise<void> {
    this.known.delete(id);
    await this.deps.settings.set('global', ['imageProviders'], this.providers.filter((p) => p.id !== id));
    this.adapters.delete(id);
    this.statuses.delete(id);
    await this.deps.db.delete(imageModelCache).where(eq(imageModelCache.providerId, id));
    if (await this.deps.secrets.has(`image-provider-${id}`)) await this.deps.secrets.delete(`image-provider-${id}`);
    this.emit('status', this.statusList());
    this.emit('models', await this.listModels());
  }

  /** Local image servers on default ports that aren't added yet. */
  async detect(): Promise<DetectedImageServer[]> {
    const configured = new Set(this.providers.map((p) => p.baseUrl));
    return detectImageServers(this.deps.adapterDeps.fetch, configured);
  }

  /** Whether a provider's name for a model reads well: `preset` first, for the Settings list. */
  label(config: ImageProviderConfig): string {
    return config.name || imagePreset(config.preset)?.label || config.id;
  }
}

export const imageRef = modelRef;
