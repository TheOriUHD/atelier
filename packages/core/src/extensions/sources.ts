/** Where skills and commands are read from: the backend's own files, or a workspace through its runner. */
import { readdir, readFile, realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { watch } from 'chokidar';
import type { Workspace } from '../workspaces/workspace.ts';
import type { ExtensionFs } from './skills.ts';

export const hostFs: ExtensionFs = {
  sep,
  list: (dir) => readdir(dir).catch(() => []),
  read: (path) => readFile(path, 'utf8').catch(() => null),
  realpath: (path) => realpath(path),
};

export function workspaceFs(ws: Workspace): ExtensionFs {
  return {
    sep: ws.pathSep,
    list: (dir) => ws.runner.call('fs.list', { path: dir, depth: 1 }).then((r) => r.entries.map((e) => e.name), () => []),
    read: (path) => ws.runner.call('fs.read', { path }).then((r) => (r.binary ? null : r.content), () => null),
    realpath: (path) => ws.runner.call('fs.stat', { path }).then((r) => r.path),
  };
}

/**
 * Calls `onChange` (once things settle) when skills, commands, agents or plugin installs change in these folders
 * and files on this machine — `npx skills add`, a plugin install, an edited SKILL.md — so lists refresh live.
 */
export function watchHost(paths: string[], onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  // A skill's SKILL.md is one folder down; deeper files (scripts, references) don't change what is offered.
  const watcher = watch(paths, { ignoreInitial: true, followSymlinks: true, depth: 2 });
  watcher.on('all', () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  });
  watcher.on('error', () => {});
  return () => {
    clearTimeout(timer);
    void watcher.close();
  };
}

/** A project's skill, command or agent folders, most specific first; Claude Code's only with compatibility on. */
export function projectRoots(ws: Workspace, kind: 'skills' | 'commands' | 'agents', claudeCode: boolean): string[] {
  // `.agents/skills` is the cross-agent install location; commands and agents have no such convention.
  const dirs = kind === 'skills' ? ['.atelier', '.agents', ...(claudeCode ? ['.claude'] : [])] : ['.atelier', ...(claudeCode ? ['.claude'] : [])];
  return dirs.map((d) => [ws.root, d, kind].join(ws.pathSep));
}
