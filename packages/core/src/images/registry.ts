/**
 * Image providers (ARCHITECTURE §23): the counterpart of providers/registry.ts for the separate `imageProviders` list.
 * Builds adapters, discovers and caches models, merges the admin's overrides, tracks health and handles "Add".
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { eq, inArray } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { imagePreset, modelRef, parseModelRef, type DetectedImageServer, type ImageModelInfo, type ImageModelOverride, type ImageProviderConfig, type ImageProviderDraft, type ImageWorkflow, type ImageWorkflowSource, type ProviderStatus, type SavedImageWorkflow, eq, inArray } from 'drizzle-orm';
import { imagePreset, isPersonalProviderId, type ImageProviderType, type PersonalImageProvider, type PersonalImageProviderDraft } from '@atelier/protocol';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { SettingsService } from '../settings/settings-service.ts';
import type { Db } from '../store/db.ts';
import { imageModelCache } from '../store/schema.ts';
import { interpolate } from '../util/interpolate.ts';
import { isAbortError, noAnswerError } from '../providers/http.ts';
import { personalKeyId } from '../providers/personal.ts';
import { defaultLimits, serverName, type RequestScheduler, type ServerLimits } from '../providers/scheduler.ts';
import type { HealthResult, ProviderFetch } from '../providers/types.ts';
import { detectImageServers } from './detect.ts';
import { readWorkflow } from './dialects/comfyui/workflow.ts';
import type { PersonalImageAccess, PersonalImageRow } from './personal.ts';
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
    /** Whether someone's own text provider has this id. */
    personal(providerId: string): Promise<boolean>;
  };
  /** People's own image servers on their computers (personal.ts); without it there are none. */
  personal?: PersonalImageAccess;
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

/** A personal provider's row as a provider config (its key is the owner's own secret, read separately). */
const personalConfig = (row: PersonalImageRow): ImageProviderConfig => ({
  id: row.id,
  type: row.type as ImageProviderType,
  ...(row.preset ? { preset: row.preset } : {}),
  name: row.name,
  baseUrl: row.baseUrl,
  headers: {},
  enabled: row.enabled,
  ...row.options,
});
const deviceLabel = (row: PersonalImageRow): string => row.deviceName ?? 'a removed computer';

export interface ResolvedImageModel {
  adapter: ImageAdapter;
  info: ImageModelInfo;
  config: ImageProviderConfig;
  /** One of a person's own servers: the computer it runs on, and `fetch` from there (a URL it answers with is only reachable that way). */
  personal?: { deviceId: string; fetch: ProviderFetch };
}

export class ImageModelUnavailable extends Error {}

/**
 * `models` carries the shared models whenever they change; `personalModels` names a person whose own models (personal
 * image providers) changed, which only their windows hear about.
 */
export class ImageProviderRegistry extends EventEmitter<{ status: [ProviderStatus[]]; models: [ImageModelInfo[]]; personalModels: [string] }> {
  private adapters = new Map<string, { key: string; adapter: ImageAdapter }>();
  private statuses = new Map<string, ProviderStatus>();
  private known = new Map<string, string>();
  private overridesKey = '';
  private syncing: Promise<void> = Promise.resolve();
  /** Personal providers whose computer lent them at the last look, to discover one again when it comes back. */
  private reachable = new Set<string>();

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

  private async adapterFor(config: ImageProviderConfig, personal?: PersonalImageRow): Promise<ImageAdapter> {
    const instance = personal ? await this.instance(config, await this.personalKey(personal)) : await this.instance(config);
    // Keyed on the resolved key too, so a rotated secret takes effect on the next request.
    const key = createHash('sha256').update(JSON.stringify(personal ? [instance, personal.userId, personal.deviceId] : instance)).digest('hex');
    const cached = this.adapters.get(config.id);
    if (cached?.key === key) return cached.adapter;
    const adapter = this.deps.createAdapter(instance, personal ? this.personalDeps(personal, instance.apiKey) : this.deps.adapterDeps);
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

  /** What `userId` can pick from: the shared models, favorites first, and their own after them. Without a user, the shared ones. */
  async listModels(userId?: string | null): Promise<ImageModelInfo[]> {
    const shared = await this.sharedModels();
    return userId ? [...shared, ...(await this.personalModels(userId))] : shared;
  }

  private async sharedModels(): Promise<ImageModelInfo[]> {
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
  async resolve(ref: string, options: { admin: boolean; userId: string | null }): Promise<ResolvedImageModel> {
    const parsed = parseModelRef(ref);
    if (parsed && isPersonalProviderId(parsed.providerId)) return this.resolvePersonal(ref, parsed.providerId, parsed.modelId, options.userId);
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

  /**
   * The queue a job on this provider waits in: a shared GPU's when it has one, else the image server's own. A personal
   * provider's is its computer's (`127.0.0.1` there is neither the server's nor another computer's).
   */
  queueOf({ config, personal }: Pick<ResolvedImageModel, 'config' | 'personal'>): { server: string; limits: () => ServerLimits; exclusive: boolean } {
    const shared = config.sharesGpuWith ? this.deps.text.queue(config.sharesGpuWith) : null;
    if (shared) return { ...shared, exclusive: true };
    const fallback = defaultLimits(config.baseUrl);
    const server = personal ? `device:${personal.deviceId}|${serverName(config.baseUrl)}` : serverName(config.baseUrl);
    return { server, limits: () => ({ parallel: config.parallelRequests ?? fallback.parallel, modelsAtOnce: fallback.modelsAtOnce }), exclusive: false };
  }

  hold(model: Pick<ResolvedImageModel, 'config' | 'personal' | 'info'>, signal: AbortSignal, options: { onWait?: (ahead: number | null) => void; owner?: string }): Promise<() => void> {
    const { server, limits, exclusive } = this.queueOf(model);
    return this.deps.scheduler.hold(server, limits, `image:${model.config.id}/${model.info.modelId}`, signal, { ...options, exclusive });
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

  private async refreshOne(config: ImageProviderConfig, personal?: PersonalImageRow): Promise<void> {
    let timeoutMs = HEALTH_TIMEOUT_MS;
    try {
      const adapter = await this.adapterFor(config, personal);
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
    // The shape of a person's own id stays theirs, so a ref never means two providers.
    if (isPersonalProviderId(draft.id)) throw new Error(`"${draft.id}" can't be a provider id: choose another.`);
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

  /** Reads a workflow on the server that will run it. Without a server, only what needs none can be read. */
  async parseWorkflow({ providerId, ...source }: ImageWorkflowSource): Promise<ImageWorkflow> {
    if (providerId === undefined) return readWorkflow(source);
    const adapter = await this.adapterOf(providerId);
    if (!adapter.parseWorkflow) throw new ImageModelUnavailable('This image provider has no workflows.');
    return adapter.parseWorkflow(source, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS));
  }

  async savedWorkflows(providerId: string): Promise<SavedImageWorkflow[]> {
    const adapter = await this.adapterOf(providerId);
    return adapter.savedWorkflows ? adapter.savedWorkflows(AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)) : [];
  }

  private async adapterOf(providerId: string): Promise<ImageAdapter> {
    const config = this.providers.find((p) => p.id === providerId);
    if (!config) throw new ImageModelUnavailable(`There's no image provider "${providerId}".`);
    return this.adapterFor(config);
  }

  /** Local image servers on default ports that aren't added yet. */
  async detect(): Promise<DetectedImageServer[]> {
    const configured = new Set(this.providers.map((p) => p.baseUrl));
    return detectImageServers(this.deps.adapterDeps.fetch, configured);
  }

  // ------------------------------------------------------ personal providers

  /** The person's own provider `id`; null when it isn't theirs (or there is none). */
  private async ownPersonal(id: string, userId: string | null | undefined): Promise<PersonalImageRow | null> {
    const row = userId && this.deps.personal ? await this.deps.personal.repo.get(id) : null;
    return row && row.userId === userId ? row : null;
  }

  private requirePersonal(): PersonalImageAccess {
    if (!this.deps.personal) throw new Error('Models on your computers need an Atelier server.');
    return this.deps.personal;
  }

  /** Its computer is connected and lends it. */
  private online(row: PersonalImageRow): boolean {
    return this.deps.personal?.lends(row.userId, row.deviceId, row.id) ?? false;
  }

  private personalKey(row: PersonalImageRow): Promise<string | undefined> {
    return this.deps.secrets.forUser(row.userId, personalKeyId(row.userId, row.id));
  }

  /** Everything goes out from the person's computer: nothing of the server's own, and never the request inspector. */
  private personalDeps(row: PersonalImageRow, apiKey: string | undefined): ImageAdapterDeps {
    const personal = this.requirePersonal();
    return { fetch: personal.fetch(row.userId, row.deviceId, row.id), socket: personal.socket(row.userId, row.deviceId, row.id, apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  }

  /** The person's own models, under their computer's name; `available` false while it isn't connected. */
  async personalModels(userId: string): Promise<ImageModelInfo[]> {
    if (!this.deps.personal) return [];
    const rows = (await this.deps.personal.repo.list(userId)).filter((r) => r.enabled);
    if (rows.length === 0) return [];
    const cached = await this.deps.db.select().from(imageModelCache).where(inArray(imageModelCache.providerId, rows.map((r) => r.id))).all();
    return rows.flatMap((row) => {
      const extra = { personal: { deviceId: row.deviceId, deviceName: deviceLabel(row) }, available: this.online(row) };
      return cached
        .filter((c) => c.providerId === row.id)
        .map((c) => ({ ...withOverrides(c.info as unknown as ListedImageModel, {}), ...extra }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    });
  }

  /** A personal model, for its owner only: anyone else is told it doesn't exist. Its computer must be connected. */
  private async resolvePersonal(ref: string, providerId: string, modelId: string, userId: string | null): Promise<ResolvedImageModel> {
    const row = await this.ownPersonal(providerId, userId);
    if (!row) throw new ImageModelUnavailable(`There's no image model "${ref}".`);
    if (!row.enabled) throw new ImageModelUnavailable(`${row.name} is turned off.`);
    if (!this.online(row)) throw new ImageModelUnavailable(`${row.name} runs on ${deviceLabel(row)}, which isn't connected.`);
    const found = (await this.deps.db.select().from(imageModelCache).where(eq(imageModelCache.providerId, providerId)).all()).find((r) => r.modelId === modelId);
    if (!found) throw new ImageModelUnavailable(`${row.name} has no model "${modelId}". Refresh it in Settings if it was just added.`);
    const info = { ...withOverrides(found.info as unknown as ListedImageModel, {}), personal: { deviceId: row.deviceId, deviceName: deviceLabel(row) }, available: true };
    const config = personalConfig(row);
    return { adapter: await this.adapterFor(config, row), info, config, personal: { deviceId: row.deviceId, fetch: this.requirePersonal().fetch(row.userId, row.deviceId, row.id) } };
  }

  /** The person's own image servers, with whether each computer is connected and the last check. */
  async personalProviders(userId: string): Promise<PersonalImageProvider[]> {
    if (!this.deps.personal) return [];
    const rows = await this.deps.personal.repo.list(userId);
    return Promise.all(
      rows.map(async (row) => {
        const status = this.statuses.get(row.id);
        return {
          ...row.options,
          id: row.id,
          type: row.type as PersonalImageProvider['type'],
          ...(row.preset ? { preset: row.preset } : {}),
          name: row.name,
          baseUrl: row.baseUrl,
          enabled: row.enabled,
          deviceId: row.deviceId,
          deviceName: row.deviceName ?? 'A removed computer',
          online: this.online(row),
          hasKey: await this.deps.secrets.has(personalKeyId(row.userId, row.id)),
          ...(status ? { status } : {}),
          createdAt: row.createdAt,
        };
      }),
    );
  }

  /** The row a draft makes on `deviceId` (or its existing one's computer); refuses an id that is someone else's. */
  private async personalDraft(userId: string, deviceId: string | null, draft: PersonalImageProviderDraft): Promise<{ row: PersonalImageRow; existing: PersonalImageRow | null }> {
    const personal = this.requirePersonal();
    const existing = await personal.repo.get(draft.id);
    // A desktop lends addresses by id, whatever uses them: one id can't be both a text and an image server, or two people's.
    if ((existing && existing.userId !== userId) || this.providers.some((p) => p.id === draft.id) || (await this.deps.text.personal(draft.id))) throw new Error('That provider id is taken: add it again.');
    const device = existing?.deviceId ?? deviceId;
    if (!device) throw new Error('Add image servers on your computer from the desktop app there.');
    const options = {
      ...(draft.parallelRequests ? { parallelRequests: draft.parallelRequests } : {}),
      ...(draft.freeAfterRun !== undefined ? { freeAfterRun: draft.freeAfterRun } : {}),
      ...(draft.models ? { models: draft.models } : {}),
      ...(draft.workflows ? { workflows: draft.workflows } : {}),
    };
    const row: PersonalImageRow = {
      id: draft.id,
      userId,
      deviceId: device,
      type: draft.type,
      preset: draft.preset ?? null,
      name: draft.name,
      baseUrl: draft.baseUrl.replace(/\/+$/, ''),
      options,
      enabled: draft.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? Date.now(),
      deviceName: existing?.deviceName ?? null,
    };
    return { row, existing };
  }

  /** Checks a draft from its computer before it is saved: health, then its models. */
  async testPersonal(userId: string, deviceId: string | null, draft: PersonalImageProviderDraft): Promise<{ status: ProviderStatus; models: ImageModelInfo[] }> {
    const { row, existing } = await this.personalDraft(userId, deviceId, draft);
    const raw = draft.apiKey ?? (existing ? await this.personalKey(existing) : undefined);
    const adapter = this.deps.createAdapter(await this.instance(personalConfig(row), raw), this.personalDeps(row, raw));
    const health: HealthResult = await adapter.health(AbortSignal.timeout(HEALTH_TIMEOUT_MS)).catch((error: unknown) => ({ ok: false, latencyMs: null, warnings: [], error: checkError(error, draft.baseUrl, HEALTH_TIMEOUT_MS) }));
    const models = health.ok ? await adapter.listModels(AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)).catch(() => [] as ListedImageModel[]) : [];
    return { status: { ...health, providerId: draft.id, modelCount: models.length, checkedAt: Date.now() }, models: models.map((m) => withOverrides(m, {})) };
  }

  /** Adds or edits one of the person's own image servers (a new one on `deviceId`); its key becomes their own secret. */
  async savePersonal(userId: string, deviceId: string | null, draft: PersonalImageProviderDraft): Promise<PersonalImageProvider> {
    const personal = this.requirePersonal();
    const { row } = await this.personalDraft(userId, deviceId, draft);
    if (draft.apiKey) await this.deps.secrets.set({ id: personalKeyId(userId, draft.id), label: `${draft.name} API key`, kind: 'api_key', value: draft.apiKey });
    const { deviceName: _, ...stored } = row;
    await personal.repo.put(stored);
    this.adapters.delete(draft.id);
    await this.refreshPersonal(userId, draft.id);
    return (await this.personalProviders(userId)).find((p) => p.id === draft.id)!;
  }

  async removePersonal(userId: string, id: string): Promise<void> {
    const personal = this.requirePersonal();
    if (!(await this.ownPersonal(id, userId))) throw new Error('That image server is gone.');
    await personal.repo.remove(id);
    this.adapters.delete(id);
    this.statuses.delete(id);
    this.reachable.delete(id);
    await this.deps.db.delete(imageModelCache).where(eq(imageModelCache.providerId, id));
    if (await this.deps.secrets.has(personalKeyId(userId, id))) await this.deps.secrets.delete(personalKeyId(userId, id));
    this.emit('personalModels', userId);
  }

  /** Re-checks the person's image servers (or one) on their computers that are connected, and tells their windows. */
  async refreshPersonal(userId: string, id?: string): Promise<PersonalImageProvider[]> {
    if (!this.deps.personal) return [];
    const rows = (await this.deps.personal.repo.list(userId)).filter((r) => r.enabled && (!id || r.id === id) && this.online(r));
    for (const r of rows) this.reachable.add(r.id);
    await Promise.all(rows.map((r) => this.refreshOne(personalConfig(r), r)));
    this.emit('personalModels', userId);
    return this.personalProviders(userId);
  }

  /**
   * One of the person's computers came, went, or changed what it lends: their own models there become available or
   * not, and a server that just came back is discovered again (its models may have changed meanwhile).
   */
  async devicesChanged(userId: string): Promise<void> {
    if (!this.deps.personal) return;
    const rows = await this.deps.personal.repo.list(userId);
    if (rows.length === 0) return;
    const back = rows.filter((r) => r.enabled && this.online(r) && !this.reachable.has(r.id));
    for (const r of rows) {
      if (r.enabled && this.online(r)) this.reachable.add(r.id);
      else this.reachable.delete(r.id);
    }
    await Promise.all(back.map((r) => this.refreshOne(personalConfig(r), r)));
    this.emit('personalModels', userId);
  }

  /** Whether a provider's name for a model reads well: `preset` first, for the Settings list. */
  label(config: ImageProviderConfig): string {
    return config.name || imagePreset(config.preset)?.label || config.id;
  }
}

export const imageRef = modelRef;
