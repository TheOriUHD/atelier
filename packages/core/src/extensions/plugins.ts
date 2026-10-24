/**
 * Plugins (ARCHITECTURE §10): bundles of skills, commands, agents and hooks (a plugin's MCP servers are not read) described by a
 * `.claude-plugin/plugin.json` manifest. On desktop the plugins installed for Claude Code are used too
 * (`~/.claude/plugins/installed_plugins.json`); they can be switched on and off here but not changed.
 * Turning one off in Atelier never touches Claude Code's own settings. A person's desktop signed in to a server lends
 * its Claude Code plugins too (extensions/home.ts): they are read the same way, through what the desktop sent.
 */
import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { HooksConfig } from '@atelier/protocol';
import type { ExtensionFs, ExtensionSource } from './skills.ts';
import { hostFs } from './sources.ts';

export interface Plugin {
  /** `name@marketplace`, as Claude Code's `enabledPlugins` keys them. */
  id: string;
  name: string;
  description: string;
  version: string;
  root: string;
  /** Installed by Claude Code (read-only here apart from on/off) or by Atelier. */
  source: 'claude-code' | 'atelier';
  enabled: boolean;
  /** Component folders, absolute. */
  dirs: Record<'skills' | 'commands' | 'agents', string[]>;
  /** Its hooks file (`hooks/hooks.json` unless the manifest says otherwise), or hooks given inline. */
  hooks: string | HooksConfig;
}

const Installed = z.object({
  version: z.literal(2),
  plugins: z.record(z.string(), z.array(z.object({ scope: z.string().optional(), installPath: z.string(), version: z.string().optional() }))),
});
const Manifest = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  commands: z.union([z.string(), z.array(z.string())]).optional(),
  agents: z.union([z.string(), z.array(z.string())]).optional(),
  hooks: z.union([z.string(), z.looseObject({})]).optional(),
});

export const readJson = (path: string) => readFile(path, 'utf8').then((t) => JSON.parse(t) as unknown, () => null);
const jsonIn = (fs: ExtensionFs, path: string) => fs.read(path).then((t) => (t === null ? null : (JSON.parse(t) as unknown)), () => null).catch(() => null);
/** Paths as the machine that has the files joins them. */
const pathsOf = (fs: ExtensionFs) => (fs.sep === '\\' ? win32 : posix);

/**
 * Claude Code's user-level installs. `enabled` starts from Claude Code's `enabledPlugins` (installed plugins
 * count as on; `claudeEnabled` when it was read already) and Atelier's own `enabledPlugins` overrides it.
 */
export async function claudeCodePlugins(home: string, atelierEnabled: Record<string, boolean>, fs: ExtensionFs = hostFs, claudeEnabled?: Record<string, unknown>): Promise<Plugin[]> {
  const { join } = pathsOf(fs);
  const installed = Installed.safeParse(await jsonIn(fs, join(home, '.claude', 'plugins', 'installed_plugins.json')));
  if (!installed.success) return [];
  const enabledThere = claudeEnabled ?? ((await jsonIn(fs, join(home, '.claude', 'settings.json'))) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins;
  const out: Plugin[] = [];
  for (const [id, entries] of Object.entries(installed.data.plugins)) {
    const entry = entries.find((e) => e.scope === 'user') ?? entries[0];
    if (!entry) continue;
    out.push(await readPlugin(id, entry.installPath, entry.version ?? '', 'claude-code', atelierEnabled[id] ?? enabledThere?.[id] !== false, fs));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A plugin folder as described by its manifest; components default to `skills/`, `commands/`, `agents/`, `hooks/hooks.json`. */
export async function readPlugin(id: string, root: string, version: string, source: Plugin['source'], enabled: boolean, fs: ExtensionFs = hostFs): Promise<Plugin> {
  const { join } = pathsOf(fs);
  const manifest = Manifest.safeParse(await jsonIn(fs, join(root, '.claude-plugin', 'plugin.json')));
  const m = manifest.success ? manifest.data : {};
  const dirsOf = (kind: 'skills' | 'commands' | 'agents') => {
    const declared = m[kind];
    return (declared === undefined ? [kind] : Array.isArray(declared) ? declared : [declared]).map((p) => join(root, p));
  };
  return {
    id,
    name: m.name ?? id.split('@')[0]!,
    description: m.description ?? '',
    version: m.version ?? version,
    root,
    source,
    enabled,
    dirs: { skills: dirsOf('skills'), commands: dirsOf('commands'), agents: dirsOf('agents') },
    hooks: typeof m.hooks === 'string' ? join(root, m.hooks) : (HooksConfig.safeParse(m.hooks?.hooks ?? m.hooks).data ?? join(root, 'hooks', 'hooks.json')),
  };
}

/** Where enabled plugins' skills, commands or agents are read from (after project and global ones). */
export function pluginSources(plugins: Plugin[], kind: 'skills' | 'commands' | 'agents', fs: ExtensionFs = hostFs, location: ExtensionSource['location'] = 'host'): ExtensionSource[] {
  return plugins.filter((p) => p.enabled).map((p) => ({ fs, location, scope: 'plugin' as const, roots: p.dirs[kind], plugin: { name: p.name, root: p.root } }));
}

/** Enabled plugins' hooks, with `${CLAUDE_PLUGIN_ROOT}` filled in as Claude Code's environment would. */
export async function pluginHooks(plugins: Plugin[], fs: ExtensionFs = hostFs): Promise<HooksConfig[]> {
  const out: HooksConfig[] = [];
  for (const p of plugins.filter((p) => p.enabled)) {
    const raw = typeof p.hooks === 'string' ? ((await jsonIn(fs, p.hooks)) as { hooks?: unknown } | null)?.hooks : p.hooks;
    const parsed = HooksConfig.safeParse(raw);
    if (!parsed.success || !Object.keys(parsed.data).length) continue;
    const filled = JSON.parse(JSON.stringify(parsed.data).replaceAll('${CLAUDE_PLUGIN_ROOT}', JSON.stringify(p.root).slice(1, -1))) as HooksConfig;
    out.push(filled);
  }
  return out;
}

