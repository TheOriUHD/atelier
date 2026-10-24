/**
 * The person's own config in a home folder (ARCHITECTURE §8, §10, §21): their skills, commands and agents
 * (`~/.agents/skills`, `~/.claude/{skills,commands,agents}`, `~/.atelier/{skills,commands,agents}`), Claude Code's
 * plugins, `~/.claude/CLAUDE.md` and `~/.atelier/ATELIER.md`, and `~/.claude/settings.json`'s rules and hooks.
 *
 * The desktop's own backend reads its own machine's (`hostHome`). A server reads the home folder of the computer a
 * session's folder is on, through that person's desktop: the desktop looks once (`scanHome`) and sends what it listed
 * and read, the server looks again in that (`scannedHome`, cached by `DeviceHomes` until the desktop says something
 * changed). Only those folders and files are read there, plus `.md` files the instructions import; never Claude Code's
 * credentials, history or transcripts, and of settings.json only its permission rules, hooks and switched plugins.
 */
import { realpath, stat } from 'node:fs/promises';
import { posix, sep, win32 } from 'node:path';
import { APP, HomeScan, HooksConfig } from '@atelier/protocol';
import type { InstructionReader } from '../instructions/instructions.ts';
import type { DeviceLinks } from '../workspaces/device-links.ts';
import { claudeUserSettings, settingsFrom, type ProjectSettings } from '../workspaces/project-rules.ts';
import { discoverAgents } from './agents.ts';
import { discoverCommands } from './commands.ts';
import { claudeCodePlugins, pluginHooks, pluginSources, type Plugin } from './plugins.ts';
import { discoverSkills, type ExtensionFs } from './skills.ts';
import { hostFs, watchHost } from './sources.ts';

type Kind = 'skills' | 'commands' | 'agents';

/** One home folder's config, wherever it is. */
export interface HomeSource {
  home: string;
  /** What is found there is `host` (this backend's machine) or `home` (a person's desktop). */
  location: 'host' | 'home';
  fs: ExtensionFs;
  /** The person's instruction files there, and the files they import. */
  reader: InstructionReader;
  /** The session's folder is on that computer: its hooks, settings rules and skill scripts apply there. */
  sameMachine: boolean;
  /** The desktop it is on; null for the backend's own machine. */
  device: { id: string; name: string } | null;
  /** The global skill, command or agent folders there, most specific first; Claude Code's only with compatibility on. */
  roots(kind: Kind, claudeCode: boolean): string[];
  /** `~/.claude/settings.json`'s permission rules and hooks there. */
  claudeSettings(): Promise<ProjectSettings>;
  /** Claude Code's plugins installed there; `enabled` switches them over their own setting. */
  plugins(enabled: Record<string, boolean>): Promise<Plugin[]>;
}

/** The longest file read there; a scan reads this much in all at most. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SCAN_CHARS = 16 * 1024 * 1024;
const MAX_ENTRIES = 5000;
/** A slow desktop on a slow network: reading its home folder takes a while the first time. */
const SCAN_TIMEOUT_MS = 60_000;

/** Paths as the machine with the files joins them. */
const pathsFor = (separator: string) => (separator === '\\' ? win32 : posix);

/** The global folders in a home folder: the desktop's own `~/.atelier` ones too (`atelier`), Claude Code's with compatibility. */
function homeRoots(home: string, separator: string, kind: Kind, claudeCode: boolean, atelier: boolean): string[] {
  const { join } = pathsFor(separator);
  return [...(atelier ? [join(home, APP.dirName, kind)] : []), ...(kind === 'skills' ? [join(home, '.agents', 'skills')] : []), ...(claudeCode ? [join(home, '.claude', kind)] : [])];
}

/** What may be read in a home folder, and what never. */
export function homeAllowance(home: string, separator: string) {
  const { join } = pathsFor(separator);
  const at = (...parts: string[]) => join(home, ...parts);
  return {
    folders: [...(['skills', 'commands', 'agents'] as const).flatMap((kind) => homeRoots(home, separator, kind, true, true)), at('.claude', 'plugins')],
    files: [at('.claude', 'CLAUDE.md'), at(APP.dirName, 'ATELIER.md')],
    /** Claude Code's credentials, its own state, history and transcripts (with their memory), settings files, keys. */
    never: [
      at('.claude.json'),
      at('.claude', '.credentials.json'),
      at('.claude', 'history.jsonl'),
      at('.claude', 'projects'),
      at('.claude', 'todos'),
      at('.claude', 'shell-snapshots'),
      at('.claude', 'settings.json'),
      at('.claude', 'settings.local.json'),
      at('.ssh'),
      at('.aws'),
      at('.gnupg'),
    ],
  };
}

const inside = (path: string, folder: string, separator: string) => {
  const rel = pathsFor(separator).relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !pathsFor(separator).isAbsolute(rel));
};

/** Whether a server may list (`list`) or read (`read`) this path in the home folder there. */
export function homeAllows(home: string, separator: string, path: string, how: 'list' | 'read'): boolean {
  const paths = pathsFor(separator);
  if (!paths.isAbsolute(path)) return false;
  const target = paths.normalize(path);
  const { folders, files, never } = homeAllowance(home, separator);
  if (!inside(target, home, separator) || never.some((n) => inside(target, n, separator))) return false;
  if (folders.some((f) => inside(target, f, separator))) return true;
  return how === 'read' && (files.includes(target) || target.toLowerCase().endsWith('.md'));
}

/** This computer's home folder as a server may see it (the desktop's end): only what `homeAllows`, text up to 256 KB. */
export function homeFs(home: string): ExtensionFs {
  const { never } = homeAllowance(home, sep);
  return {
    sep,
    list: async (dir) => (homeAllows(home, sep, dir, 'list') ? hostFs.list(dir) : []),
    read: async (path) => {
      if (!homeAllows(home, sep, path, 'read')) return null;
      // A link may lead out of the home folder (a skill kept in a repository), but not to what is off limits in it.
      const real = await realpath(path).catch(() => null);
      if (!real || never.some((n) => inside(real, n, sep)) || (inside(real, home, sep) && !homeAllows(home, sep, real, 'read'))) return null;
      const info = await stat(real).catch(() => null);
      return info?.isFile() && info.size <= MAX_FILE_BYTES ? hostFs.read(real) : null;
    },
    realpath: async (path) => (homeAllows(home, sep, path, 'list') ? realpath(path) : path),
  };
}

/**
 * The desktop's end of `home.scan`: looks for skills, commands, agents and Claude Code's plugins in its home folder as
 * the server would, and returns every folder listed and file read on the way, the instruction files, and the filtered
 * `~/.claude/settings.json`.
 */
export async function scanHome(home: string): Promise<HomeScan> {
  const allowed = homeFs(home);
  const scan: HomeScan = { home, sep: sep === '\\' ? '\\' : '/', dirs: {}, files: {}, real: {}, settings: null };
  let budget = MAX_SCAN_CHARS;
  const recording: ExtensionFs = {
    sep,
    list: async (dir) => (scan.dirs[dir] ??= (await allowed.list(dir)).slice(0, MAX_ENTRIES)),
    read: async (path) => {
      if (Object.hasOwn(scan.files, path)) return scan.files[path]!;
      const text = budget > 0 ? await allowed.read(path) : null;
      budget -= text?.length ?? 0;
      return (scan.files[path] = text);
    },
    realpath: async (path) => (scan.real[path] ??= await allowed.realpath(path)),
  };
  const roots = (kind: Kind) => [{ fs: recording, location: 'home' as const, scope: 'global' as const, roots: homeRoots(home, sep, kind, true, true) }];
  await discoverSkills(roots('skills'));
  await discoverCommands(roots('commands'));
  await discoverAgents(roots('agents'));
  const plugins = (await claudeCodePlugins(home, {}, recording, {})).map((p) => ({ ...p, enabled: true }));
  await discoverSkills(pluginSources(plugins, 'skills', recording, 'home'));
  await discoverCommands(pluginSources(plugins, 'commands', recording, 'home'));
  await discoverAgents(pluginSources(plugins, 'agents', recording, 'home'));
  await pluginHooks(plugins, recording);
  for (const file of homeAllowance(home, sep).files) await recording.read(file);
  scan.settings = filterClaudeSettings(await hostFs.read(pathsFor(sep).join(home, '.claude', 'settings.json')));
  return scan;
}

/** `~/.claude/settings.json` as a server may have it: its permission rules, hooks and switched plugins, nothing else. */
export function filterClaudeSettings(text: string | null): HomeScan['settings'] {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as { permissions?: Record<string, unknown>; hooks?: unknown; enabledPlugins?: unknown };
  const rules = (list: unknown) => (Array.isArray(list) ? list.filter((r): r is string => typeof r === 'string') : []);
  const hooks = HooksConfig.safeParse(s.hooks);
  return {
    permissions: { allow: rules(s.permissions?.allow), ask: rules(s.permissions?.ask), deny: rules(s.permissions?.deny) },
    ...(hooks.success ? { hooks: hooks.data } : {}),
    enabledPlugins: s.enabledPlugins && typeof s.enabledPlugins === 'object' ? Object.fromEntries(Object.entries(s.enabledPlugins).filter(([, v]) => typeof v === 'boolean')) : {},
  };
}

/** Tells `onChange` (once things settle) when the person's config in this computer's home folder changes. */
export function watchHome(home: string, onChange: () => void): () => void {
  const { folders, files } = homeAllowance(home, sep);
  const { join } = pathsFor(sep);
  const plugins = join(home, '.claude', 'plugins');
  return watchHost([...folders.filter((f) => f !== plugins), join(plugins, 'installed_plugins.json'), join(home, '.claude', 'settings.json'), ...files], onChange);
}

/** The backend's own machine's home folder (the desktop's backend). */
export function hostHome(home: string, opts: { sameMachine: boolean; reader: InstructionReader; read(path: string): Promise<string | null> }): HomeSource {
  return {
    home,
    location: 'host',
    fs: hostFs,
    reader: opts.reader,
    sameMachine: opts.sameMachine,
    device: null,
    roots: (kind, claudeCode) => homeRoots(home, sep, kind, claudeCode, false),
    claudeSettings: () => claudeUserSettings({ read: opts.read }, home),
    plugins: (enabled) => claudeCodePlugins(home, enabled),
  };
}

/** A desktop's home folder as its scan holds it; `read` asks the desktop for a file the scan didn't hold. */
export function scannedHome(scan: HomeScan, opts: { sameMachine: boolean; device: { id: string; name: string }; read(path: string): Promise<string | null> }): HomeSource {
  const fs: ExtensionFs = {
    sep: scan.sep,
    list: async (dir) => scan.dirs[dir] ?? [],
    read: async (path) => scan.files[path] ?? null,
    realpath: async (path) => scan.real[path] ?? path,
  };
  const asked = new Map<string, Promise<string | null>>();
  return {
    home: scan.home,
    location: 'home',
    fs,
    reader: {
      read: (path) => {
        if (Object.hasOwn(scan.files, path)) return Promise.resolve(scan.files[path]!);
        let text = asked.get(path);
        if (!text) asked.set(path, (text = opts.read(path).catch(() => null)));
        return text;
      },
      readAncestors: async () => [],
      listMarkdown: async () => [],
    },
    sameMachine: opts.sameMachine,
    device: opts.device,
    roots: (kind, claudeCode) => homeRoots(scan.home, scan.sep, kind, claudeCode, true),
    claudeSettings: async () => settingsFrom(scan.settings ? JSON.stringify(scan.settings) : null),
    plugins: (enabled) => claudeCodePlugins(scan.home, enabled, fs, scan.settings?.enabledPlugins ?? {}),
  };
}

/** On a server: each desktop's home folder as it last sent it, asked for again once the desktop says it changed. */
export class DeviceHomes {
  private scans = new Map<string, Promise<{ scan: HomeScan; name: string } | null>>();

  constructor(
    private readonly links: Pick<DeviceLinks, 'ready' | 'request'>,
    private readonly deviceName: (userId: string, deviceId: string) => Promise<string>,
  ) {}

  /** The home folder of `deviceId`, when it is connected and lends it; `sameMachine` when the session's folder is there too. */
  async get(userId: string, deviceId: string, sameMachine: boolean): Promise<HomeSource | null> {
    const info = await this.links.ready(userId, deviceId);
    if (!info?.services.includes('home') || !info.lending.home) return null;
    const key = JSON.stringify([userId, deviceId]);
    let scan = this.scans.get(key);
    if (!scan) {
      const asked = this.links
        .request(userId, deviceId, { op: 'home.scan' }, SCAN_TIMEOUT_MS)
        .then(async (value) => ({ scan: HomeScan.parse(value), name: await this.deviceName(userId, deviceId) }))
        .catch(() => null);
      this.scans.set(key, (scan = asked));
      // A failed scan is tried again next time.
      void asked.then((found) => !found && this.scans.get(key) === asked && this.scans.delete(key));
    }
    const found = await scan;
    if (!found) return null;
    const read = (path: string) => this.links.request(userId, deviceId, { op: 'home.read', path }).then((v) => (typeof v === 'string' ? v : null));
    return scannedHome(found.scan, { sameMachine, device: { id: deviceId, name: found.name }, read });
  }

  /** Something changed there, or the device came or went: look again next time. */
  forget(userId: string, deviceId?: string): void {
    for (const key of [...this.scans.keys()]) {
      const [user, device] = JSON.parse(key) as [string, string];
      if (user === userId && (deviceId === undefined || device === deviceId)) this.scans.delete(key);
    }
  }
}
