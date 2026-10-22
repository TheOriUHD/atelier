/**
 * Plugin marketplaces (ARCHITECTURE §10): a GitHub repository with `.claude-plugin/marketplace.json`, in Claude
 * Code's format. Atelier installs plugins from them into its own cache and registry; plugins whose source it
 * can't fetch yet are listed with the reason.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { z } from 'zod';
import { downloadRepo, InstallError, type Fetch, type RepoRef } from './github.ts';
import { readJson, readPlugin, type Plugin } from './plugins.ts';

const PluginSource = z.union([
  z.string(),
  z.looseObject({ source: z.literal('github'), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), ref: z.string().optional(), path: z.string().optional() }),
  z.looseObject({ source: z.string() }),
]);

/** Names become folders in the cache, so each must be one plain path segment. */
const segment = /^(?!\.\.?$)[\w.+-]{1,64}$/;

const Marketplace = z.object({
  name: z.string().regex(segment),
  plugins: z.array(
    z.looseObject({
      name: z.string().regex(segment),
      description: z.string().optional(),
      // A version that isn't a plain segment is ignored; the commit names the install instead.
      version: z.string().regex(segment).optional().catch(undefined),
      source: PluginSource,
    }),
  ),
});

/** Whether `path` is `root` or inside it. */
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
};

export interface MarketplacePlugin {
  name: string;
  description: string;
  version: string;
  /** Why Atelier can't install it yet, when it can't. */
  unsupported?: string;
}

export interface PluginTarget {
  /** `<config>/plugins/cache`. */
  cache: string;
  /** Atelier's registry of its installs. */
  registry: string;
}

interface RegistryEntry {
  installPath: string;
  version: string;
  sha: string;
  installedAt: string;
}

const repoOf = (spec: string): RepoRef => {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(spec.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''));
  if (!m) throw new InstallError('Use owner/repo or a github.com URL for the marketplace.');
  return { owner: m[1]!, repo: m[2]!, path: '' };
};

async function readMarketplaceFile(dir: string) {
  const parsed = Marketplace.safeParse(await readJson(join(dir, '.claude-plugin', 'marketplace.json')));
  if (!parsed.success) throw new InstallError('That repository has no valid .claude-plugin/marketplace.json.');
  return parsed.data;
}

/** A marketplace's name and plugins. */
export async function browseMarketplace(repo: string, fetch: Fetch): Promise<{ name: string; plugins: MarketplacePlugin[] }> {
  const download = await downloadRepo(repoOf(repo), fetch);
  try {
    const m = await readMarketplaceFile(download.dir);
    return {
      name: m.name,
      plugins: m.plugins.map((p) => ({
        name: p.name,
        description: p.description ?? '',
        version: p.version ?? '',
        ...(typeof p.source === 'string' || p.source.source === 'github' ? {} : { unsupported: `Plugins from “${p.source.source}” sources can't be installed yet.` }),
      })),
    };
  } finally {
    await download.cleanup();
  }
}

/** Installs `plugin` from the marketplace in `repo`; returns its id (`plugin@marketplace`). */
export async function installPlugin(repo: string, plugin: string, target: PluginTarget, fetch: Fetch): Promise<string> {
  const market = await downloadRepo(repoOf(repo), fetch);
  try {
    const m = await readMarketplaceFile(market.dir);
    const entry = m.plugins.find((p) => p.name === plugin);
    if (!entry) throw new InstallError(`${m.name} has no plugin named “${plugin}”.`);
    const id = `${entry.name}@${m.name}`;
    let from: string;
    let sha = market.sha;
    let extra: { cleanup(): Promise<void> } | null = null;
    if (typeof entry.source === 'string') {
      from = normalize(join(market.dir, entry.source));
      if (!inside(market.dir, from)) throw new InstallError(`${plugin}'s source points outside its marketplace.`);
    } else if (entry.source.source === 'github' && typeof entry.source.repo === 'string') {
      const [owner, name] = entry.source.repo.split('/') as [string, string];
      const own = await downloadRepo({ owner, repo: name, ...(typeof entry.source.ref === 'string' ? { ref: entry.source.ref } : {}) }, fetch);
      extra = own;
      sha = own.sha;
      from = normalize(join(own.dir, typeof entry.source.path === 'string' ? entry.source.path : ''));
      if (!inside(own.dir, from)) throw new InstallError(`${plugin}'s source points outside its repository.`);
    } else {
      throw new InstallError(`Plugins from “${entry.source.source}” sources can't be installed yet.`);
    }
    try {
      const version = entry.version ?? sha.slice(0, 7);
      const dest = join(target.cache, m.name, entry.name, version);
      if (!inside(target.cache, dest) || dest === target.cache) throw new InstallError(`${plugin} can't be installed under that name.`);
      await rm(dest, { recursive: true, force: true });
      await mkdir(join(dest, '..'), { recursive: true });
      await cp(from, dest, { recursive: true });
      const registry = await readRegistry(target.registry);
      registry[id] = { installPath: dest, version, sha, installedAt: new Date().toISOString() };
      await writeRegistry(target.registry, registry);
      return id;
    } finally {
      await extra?.cleanup();
    }
  } finally {
    await market.cleanup();
  }
}

export async function uninstallPlugin(id: string, target: PluginTarget): Promise<void> {
  const registry = await readRegistry(target.registry);
  const entry = registry[id];
  if (!entry) throw new InstallError(`“${id}” wasn't installed by Atelier.`);
  if (inside(target.cache, entry.installPath) && entry.installPath !== target.cache) await rm(entry.installPath, { recursive: true, force: true });
  delete registry[id];
  await writeRegistry(target.registry, registry);
}

/** Atelier's installs, switched on unless `enabled` says otherwise. */
export async function atelierPlugins(target: PluginTarget, enabled: Record<string, boolean>): Promise<Plugin[]> {
  const registry = await readRegistry(target.registry);
  return Promise.all(Object.entries(registry).map(([id, e]) => readPlugin(id, e.installPath, e.version, 'atelier', enabled[id] ?? true)));
}

async function readRegistry(file: string): Promise<Record<string, RegistryEntry>> {
  return readFile(file, 'utf8').then((t) => (JSON.parse(t) as { plugins?: Record<string, RegistryEntry> }).plugins ?? {}, () => ({}));
}

async function writeRegistry(file: string, plugins: Record<string, RegistryEntry>): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`);
}
