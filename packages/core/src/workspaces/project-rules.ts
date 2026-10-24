/**
 * Permission rules and hooks a project brings (ARCHITECTURE §8, §12): `.atelier/settings.json` and its local
 * variant, plus Claude Code's `.claude/settings*.json` as a compatibility layer. Read through the
 * workspace's runner, so they work wherever the project lives. Unreadable or invalid files add nothing. A workspace the
 * person hasn't trusted ("Trust this workspace?") contributes nothing either, whatever its files say: a repository's own
 * hooks run commands and its allow rules skip the questions, so they apply only after the person agreed.
 */
import { HooksConfig } from '@atelier/protocol';
import { join } from 'node:path';
import type { WorkspaceFs } from '../fs/workspace-fs.ts';
import type { RuleSet } from '../permissions/engine.ts';
import { isTrusted, type Workspace } from './workspace.ts';

const LOCAL = '.atelier/settings.local.json';
const ATELIER = ['.atelier/settings.json', LOCAL];
const CLAUDE_CODE = ['.claude/settings.json', '.claude/settings.local.json'];
const CACHE_MS = 5000;

export interface ProjectSettings {
  rules: RuleSet;
  /** One per file that has hooks, in load order. */
  hooks: HooksConfig[];
}

const cache = new WeakMap<Workspace, { at: number; claudeCode: boolean; settings: Promise<ProjectSettings> }>();

/**
 * "Always allow in this project": adds the rule to `.atelier/settings.local.json`, the person's own layer for
 * this checkout, and keeps that file out of git through `.git/info/exclude` (never the project's .gitignore).
 */
export async function rememberProjectRule(workspace: Workspace, rule: string): Promise<void> {
  const path = `${workspace.root}${workspace.pathSep}${LOCAL}`;
  const text = await workspace.runner.call('fs.read', { path }).then((r) => r.content, () => '');
  const settings = (text.trim() ? JSON.parse(text) : {}) as { permissions?: { allow?: unknown } };
  const allow = Array.isArray(settings.permissions?.allow) ? (settings.permissions.allow as unknown[]) : [];
  if (allow.includes(rule)) return;
  const next = { ...settings, permissions: { ...settings.permissions, allow: [...allow, rule] } };
  await workspace.runner.call('fs.write', { path, content: `${JSON.stringify(next, null, 2)}\n`, mkdirp: true });
  cache.delete(workspace);

  await excludeFromGit(workspace).catch(() => undefined); // Best effort: not a repository, or a worktree whose git dir is outside the workspace.
}

async function excludeFromGit(workspace: Workspace): Promise<void> {
  const git = await workspace.runner.call('proc.exec', { argv: ['git', 'rev-parse', '--git-path', 'info/exclude'], cwd: workspace.root, timeoutMs: 5000 });
  if (git.exitCode !== 0) return;
  const exclude = git.stdout.trim();
  const current = await workspace.runner.call('fs.read', { path: exclude }).then((r) => r.content, () => '');
  if (current.split(/\r?\n/).includes(LOCAL)) return;
  await workspace.runner.call('fs.write', { path: exclude, content: `${current}${current && !current.endsWith('\n') ? '\n' : ''}${LOCAL}\n`, mkdirp: true });
}

export async function projectRules(workspace: Workspace, claudeCode: boolean): Promise<RuleSet> {
  return (await projectSettings(workspace, claudeCode)).rules;
}

export async function projectHooks(workspace: Workspace, claudeCode: boolean): Promise<HooksConfig[]> {
  return (await projectSettings(workspace, claudeCode)).hooks;
}

function projectSettings(workspace: Workspace, claudeCode: boolean): Promise<ProjectSettings> {
  // Checked on every call, before the cache: trusting a workspace takes effect at once.
  if (!isTrusted(workspace)) return Promise.resolve({ rules: { allow: [], ask: [], deny: [] }, hooks: [] });
  const hit = cache.get(workspace);
  if (hit && hit.claudeCode === claudeCode && Date.now() - hit.at < CACHE_MS) return hit.settings;
  const settings = read(workspace, claudeCode ? [...ATELIER, ...CLAUDE_CODE] : ATELIER);
  cache.set(workspace, { at: Date.now(), claudeCode, settings });
  return settings;
}

async function read(workspace: Workspace, files: string[]): Promise<ProjectSettings> {
  const out: ProjectSettings = { rules: { allow: [], ask: [], deny: [] }, hooks: [] };
  for (const file of files) {
    const text = await workspace.runner
      .call('fs.read', { path: `${workspace.root}${workspace.pathSep}${file}` })
      .then((r) => r.content, () => null);
    if (text) addSettings(out, text);
  }
  return out;
}

/** Claude Code's own `~/.claude/settings.json` (desktop, compatibility on): the lowest layer. */
export async function claudeUserSettings(fs: Pick<WorkspaceFs, 'read'>, home: string): Promise<ProjectSettings> {
  return settingsFrom(await fs.read(join(home, '.claude', 'settings.json')).catch(() => null));
}

/** One settings file's permission rules and hooks (a desktop's `~/.claude/settings.json`, as it sent it). */
export function settingsFrom(text: string | null): ProjectSettings {
  const out: ProjectSettings = { rules: { allow: [], ask: [], deny: [] }, hooks: [] };
  if (text) addSettings(out, text);
  return out;
}

/** Adds one settings file's permission rules and hooks; a malformed file contributes nothing. */
function addSettings(out: ProjectSettings, text: string): void {
  let parsed: { permissions?: Partial<Record<keyof RuleSet, unknown>>; hooks?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return;
  }
  const perms = parsed.permissions ?? {};
  for (const key of ['allow', 'ask', 'deny'] as const) {
    const list = perms[key];
    if (Array.isArray(list)) out.rules[key].push(...list.filter((r): r is string => typeof r === 'string'));
  }
  const hooks = HooksConfig.safeParse(parsed.hooks);
  if (hooks.success && Object.keys(hooks.data).length) out.hooks.push(hooks.data);
}
