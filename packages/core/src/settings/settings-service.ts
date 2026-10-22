/**
 * Layered settings: global → project → local. Each Settings row writes exactly one JSON path in one
 * layer; files keep unknown keys; external edits are picked up by the watcher.
 */
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { APP, SettingsSchema, type Settings, type SettingsLayer, type SettingsSnapshot } from '@atelier/protocol';
import type { WorkspaceFs } from '../fs/workspace-fs.ts';
import { deepMerge, deleteAt, isPlainObject, leafPaths, setAt, type JsonPath } from '../util/json-path.ts';

export interface ProjectLocation {
  fs: WorkspaceFs;
  root: string;
}

interface LayerState {
  path: string;
  fs: WorkspaceFs;
  /** The file as written, invalid keys included (writes keep them). */
  raw: Record<string, unknown>;
  /** Its top-level keys that validate, which are what applies. */
  valid: Record<string, unknown>;
  error: string | null;
  /** Not JSON (or not an object): nothing applies and nothing may be written over it. */
  unreadable?: boolean;
}

/** One bad key doesn't undo the rest of a file: the top-level keys with problems are left out, and named. */
function validate(raw: Record<string, unknown>): Pick<LayerState, 'valid' | 'error'> {
  const check = SettingsSchema.safeParse(raw);
  if (check.success) return { valid: raw, error: null };
  const bad = new Set(check.error.issues.map((i) => String(i.path[0] ?? '')));
  const valid = bad.has('') ? {} : Object.fromEntries(Object.entries(raw).filter(([key]) => !bad.has(key)));
  return { valid, error: check.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; ') };
}

export class SettingsService extends EventEmitter<{ change: [SettingsSnapshot] }> {
  private layers = new Map<SettingsLayer, LayerState>();
  private current: { effective: Settings; snapshot: SettingsSnapshot } | null = null;
  private stopWatching: (() => void)[] = [];
  /** Writes and reloads run one after another: a reload that read the file before a write must not land after it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly globalFs: WorkspaceFs,
    private readonly globalDir: string,
    private project: ProjectLocation | null = null,
  ) {
    super();
  }

  /** `~/.atelier/settings.json` (desktop) or `/data/settings.json` (server). */
  get globalPath(): string {
    return join(this.globalDir, 'settings.json');
  }

  async load(): Promise<void> {
    this.layers.set('global', await this.readLayer(this.globalFs, this.globalPath));
    if (this.project) {
      const dir = join(this.project.root, APP.dirName);
      this.layers.set('project', await this.readLayer(this.project.fs, join(dir, 'settings.json')));
      this.layers.set('local', await this.readLayer(this.project.fs, join(dir, 'settings.local.json')));
    } else {
      this.layers.delete('project');
      this.layers.delete('local');
    }
    this.recompute();
  }

  /** Re-targets project/local layers (when the active workspace changes) and reloads. */
  async setProject(project: ProjectLocation | null): Promise<void> {
    this.project = project;
    this.unwatch();
    await this.load();
    this.watch();
  }

  watch(): void {
    this.unwatch();
    const byFs = new Map<WorkspaceFs, string[]>();
    for (const layer of this.layers.values()) byFs.set(layer.fs, [...(byFs.get(layer.fs) ?? []), layer.path]);
    for (const [fs, paths] of byFs) this.stopWatching.push(fs.watch(paths, () => void this.reloadQuietly()));
  }

  unwatch(): void {
    for (const stop of this.stopWatching) stop();
    this.stopWatching = [];
  }

  get effective(): Settings {
    if (!this.current) throw new Error('SettingsService.load() has not run');
    return this.current.effective;
  }

  snapshot(): SettingsSnapshot {
    if (!this.current) throw new Error('SettingsService.load() has not run');
    return this.current.snapshot;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  set(layer: SettingsLayer, path: JsonPath, value: unknown): Promise<void> {
    return this.serial(() => this.setNow(layer, path, value));
  }

  private async setNow(layer: SettingsLayer, path: JsonPath, value: unknown): Promise<void> {
    const state = this.requireLayer(layer);
    const next = setAt(state.raw, path, value);
    const candidate = this.mergeLayers(new Map(this.layers).set(layer, { ...state, valid: setAt(state.valid, path, value) }));
    const parsed = SettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SettingsValidationError(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid setting');
    }
    await this.writeLayer(state, next);
  }

  reset(layer: SettingsLayer, path: JsonPath): Promise<void> {
    return this.serial(async () => {
      const state = this.requireLayer(layer);
      await this.writeLayer(state, deleteAt(state.raw, path));
    });
  }

  /** The raw JSON of one layer (e.g. for "Open settings.json" or exports). */
  layerRaw(layer: SettingsLayer): Record<string, unknown> | undefined {
    return this.layers.get(layer)?.raw;
  }

  private requireLayer(layer: SettingsLayer): LayerState {
    const state = this.layers.get(layer);
    if (!state) throw new SettingsValidationError(`No ${layer} settings layer is active`);
    // Writing would replace a file that isn't readable JSON with just this change.
    if (state.unreadable) throw new SettingsValidationError(`${state.path} can't be read (${state.error}). Fix the file first.`);
    return state;
  }

  private async writeLayer(state: LayerState, raw: Record<string, unknown>): Promise<void> {
    await state.fs.write(state.path, JSON.stringify(raw, null, 2) + '\n');
    Object.assign(state, { raw }, validate(raw));
    this.recompute();
  }

  private async reloadQuietly(): Promise<void> {
    try {
      await this.serial(() => this.load());
    } catch {
      // A half-written file is retried on the next change event.
    }
  }

  private async readLayer(fs: WorkspaceFs, path: string): Promise<LayerState> {
    const text = await fs.read(path);
    if (text === null || text.trim() === '') return { path, fs, raw: {}, valid: {}, error: null };
    try {
      const raw: unknown = JSON.parse(text);
      if (!isPlainObject(raw)) return { path, fs, raw: {}, valid: {}, error: 'Settings file must contain a JSON object', unreadable: true };
      return { path, fs, raw, ...validate(raw) };
    } catch (error) {
      return { path, fs, raw: {}, valid: {}, error: `Invalid JSON: ${(error as Error).message}`, unreadable: true };
    }
  }

  private mergeLayers(layers: Map<SettingsLayer, LayerState>): unknown {
    let merged: unknown = {};
    for (const name of ['global', 'project', 'local'] as const) {
      const l = layers.get(name);
      if (l) merged = deepMerge(merged, l.valid);
    }
    return merged;
  }

  private recompute(): void {
    const effective = SettingsSchema.parse(this.mergeLayers(this.layers));
    const origins: Record<string, SettingsLayer> = {};
    for (const name of ['project', 'local'] as const) {
      const l = this.layers.get(name);
      if (l) for (const p of leafPaths(l.valid)) origins[p] = name;
    }
    const errors = [...this.layers.entries()]
      .filter(([, l]) => l.error)
      .map(([layer, l]) => ({ layer, message: l.error! }));
    const snapshot: SettingsSnapshot = { effective, origins, projectRoot: this.project?.root ?? null, errors };
    this.current = { effective, snapshot };
    this.emit('change', snapshot);
  }
}

export class SettingsValidationError extends Error {
  override name = 'SettingsValidationError';
}
