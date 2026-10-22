/**
 * Installing skills from GitHub (ARCHITECTURE §10): `owner/repo[@ref][/path]` or a github.com URL. Every folder
 * with a SKILL.md under the path is copied into the install root. On desktop that is `~/.agents/skills`, linked
 * from `~/.claude/skills`, the layout `npx skills -g` uses, so Claude Code and other agents see the same
 * installs. Atelier records what it installed in its own lock file and never writes another tool's.
 */
import { cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { downloadRepo, InstallError, type Fetch, type RepoRef } from './github.ts';
import { parseSkill } from './skills.ts';


export interface LockEntry {
  source: string;
  sha: string;
  path: string;
  installedAt: string;
}

export interface InstallTarget {
  /** Where skill folders go. */
  root: string;
  /** Also linked from here (desktop: `~/.claude/skills`). */
  linkFrom?: string;
  /** Atelier's lock file. */
  lockFile: string;
}

const SOURCE = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([\w./-]+?))?(?:\/(?:tree\/([\w.-]+)\/)?(.*?))?\/?$/;

export function parseSource(input: string): RepoRef {
  const m = SOURCE.exec(input.trim());
  if (!m) throw new InstallError('Use owner/repo, owner/repo@ref/path, or a github.com URL.');
  const [, owner, repo, atRef, treeRef, path] = m;
  return { owner: owner!, repo: repo!, ...(atRef || treeRef ? { ref: (atRef ?? treeRef)! } : {}), path: (path ?? '').replace(/^\/+|\/+$/g, '') };
}

async function readLock(file: string): Promise<Record<string, LockEntry>> {
  const data = await readFile(file, 'utf8').then((t) => JSON.parse(t) as { skills?: Record<string, LockEntry> }, () => null);
  return data?.skills ?? {};
}

/** Skills Atelier installed, by name. */
export const installedSkills = (target: InstallTarget) => readLock(target.lockFile);

/**
 * Downloads the repository at the ref (default branch when absent) and installs each skill under the path.
 * A folder that already exists and wasn't installed by Atelier is left alone unless `replace` is set.
 */
export async function installSkills(input: string, target: InstallTarget, fetch: Fetch, replace = false): Promise<string[]> {
  const src = parseSource(input);
  const { dir: work, sha, cleanup } = await downloadRepo(src, fetch);
  try {
    const base = join(work, src.path);
    const found = await skillDirs(base, 3);
    if (!found.length) throw new InstallError(`No SKILL.md found under ${src.path || 'the repository root'}.`);

    const lock = await readLock(target.lockFile);
    const skills: { name: string; dir: string }[] = [];
    for (const dir of found) {
      // A repository that is itself one skill is named after the repository.
      const parsed = parseSkill(await readFile(join(dir, 'SKILL.md'), 'utf8'), dir === work ? src.repo : basename(dir));
      if (!parsed) throw new InstallError(`${relative(work, dir) || 'The skill'} has no description in its SKILL.md.`);
      const dest = join(target.root, parsed.name);
      if (!replace && !lock[parsed.name] && (await exists(dest))) {
        throw new InstallError(`A skill named “${parsed.name}” is already installed from somewhere else. Install again with replace to overwrite it.`, 'skill_exists', { name: parsed.name });
      }
      skills.push({ name: parsed.name, dir });
    }

    await mkdir(target.root, { recursive: true });
    for (const { name, dir } of skills) {
      const dest = join(target.root, name);
      await rm(dest, { recursive: true, force: true });
      await cp(dir, dest, { recursive: true });
      if (target.linkFrom) await link(dest, join(target.linkFrom, name));
      lock[name] = { source: `${src.owner}/${src.repo}`, sha, path: relative(work, dir).replaceAll('\\', '/'), installedAt: new Date().toISOString() };
    }
    await writeFile(target.lockFile, `${JSON.stringify({ version: 1, skills: lock }, null, 2)}\n`);
    return skills.map((s) => s.name);
  } finally {
    await cleanup();
  }
}

/** Removes a skill Atelier installed (and its link); skills from elsewhere are not Atelier's to remove. */
export async function uninstallSkill(name: string, target: InstallTarget): Promise<void> {
  const lock = await readLock(target.lockFile);
  if (!lock[name]) throw new InstallError(`“${name}” wasn't installed by Atelier.`);
  if (target.linkFrom) {
    const linkPath = join(target.linkFrom, name);
    if ((await lstat(linkPath).catch(() => null))?.isSymbolicLink()) await rm(linkPath);
  }
  await rm(join(target.root, name), { recursive: true, force: true });
  delete lock[name];
  await writeFile(target.lockFile, `${JSON.stringify({ version: 1, skills: lock }, null, 2)}\n`);
}

/** Folders with a SKILL.md: `dir` itself, or below it down to `depth` levels. */
async function skillDirs(dir: string, depth: number): Promise<string[]> {
  if (await exists(join(dir, 'SKILL.md'))) return [dir];
  if (depth === 0) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => skillDirs(join(dir, e.name), depth - 1)));
  return nested.flat();
}

/** A relative link, as `npx skills` makes; a copy where links aren't allowed (Windows without Developer Mode). */
async function link(target: string, at: string): Promise<void> {
  const current = await lstat(at).catch(() => null);
  if (current && !current.isSymbolicLink()) return; // Something else lives there; leave it.
  if (current) await rm(at);
  await mkdir(join(at, '..'), { recursive: true });
  await symlink(relative(join(at, '..'), target), at, 'dir').catch(() => cp(target, at, { recursive: true }));
}

const exists = (path: string) => lstat(path).then(() => true, () => false);
