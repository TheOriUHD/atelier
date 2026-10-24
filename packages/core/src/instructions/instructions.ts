/**
 * Instruction files (ARCHITECTURE §8): the global files (the system AGENTS.md and ATELIER.md, the person's own), then
 * the project's CLAUDE.md, .claude/CLAUDE.md, AGENTS.md, ATELIER.md and CLAUDE.local.md from the workspace root upward,
 * plus `.claude/rules/**.md`. ATELIER.md is Atelier's own file; AGENTS.md and CLAUDE.md load too. `@path` imports are
 * followed up to four hops and every file appears once.
 */
import { isAbsolute, join, posix, relative, win32 } from 'node:path';
import { APP, type InstructionFileName } from '@atelier/protocol';
import type { WorkspaceFs } from '../fs/workspace-fs.ts';
import { escapeAttr, escapeTags } from '../prompts/escape.ts';

/** In one folder, a later name ranks higher: ATELIER.md over AGENTS.md and CLAUDE.md, the person's CLAUDE.local.md last. */
export const INSTRUCTION_NAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', 'ATELIER.md', 'CLAUDE.local.md'] as const;
/** The file Atelier writes when it sets up or updates a project's instructions. */
export const ATELIER_MD = 'ATELIER.md';
/** Names a runner from before ATELIER.md accepts (it rejects the whole call over one name it doesn't know). */
const LEGACY_NAMES: readonly string[] = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md'];

/** The instruction file names to look for, without the CLAUDE.md family when that compatibility is off. */
export function instructionNames(claudeCode: boolean): InstructionFileName[] {
  return INSTRUCTION_NAMES.filter((n) => claudeCode || !(n.startsWith('.claude/') || n === 'CLAUDE.md' || n === 'CLAUDE.local.md'));
}

/** `fs.readAncestors`, retried without ATELIER.md for a runner that predates it. */
export async function readAncestors(
  call: (names: InstructionFileName[]) => Promise<{ path: string; content: string }[]>,
  names: readonly InstructionFileName[],
): Promise<{ path: string; content: string }[]> {
  try {
    return await call([...names]);
  } catch {
    const legacy = names.filter((n) => LEGACY_NAMES.includes(n));
    return legacy.length && legacy.length < names.length ? call(legacy).catch(() => []) : [];
  }
}

const MAX_IMPORT_DEPTH = 4;
const MAX_FILE_CHARS = 60_000;

/** Who wrote a file, which decides its rank (docs/PROMPTS.md §1.5): the administrator, the person, the project. */
export type InstructionKind = 'system' | 'personal' | 'project' | 'rules';

export interface InstructionFile {
  path: string;
  kind: InstructionKind;
  content: string;
  /** The file that imported this one, when it was pulled in with `@path`. */
  importedFrom?: string;
}

export interface InstructionReader {
  /** File contents, or null when it doesn't exist or can't be read. */
  read(path: string): Promise<string | null>;
  /** Instruction files from `from` up to the filesystem root, nearest last (see the runner's fs.readAncestors). */
  readAncestors(from: string, names: readonly string[]): Promise<{ path: string; content: string }[]>;
  /** Markdown files under a directory, recursively; empty when it doesn't exist. */
  listMarkdown(dir: string): Promise<string[]>;
}

/** Global files on the backend host, confined to `dirs` so an `@import` can't pull in arbitrary host files. */
export function hostReader(fs: WorkspaceFs, dirs: string[]): InstructionReader {
  const inside = (path: string) =>
    dirs.some((dir) => {
      const rel = relative(dir, path);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    });
  return {
    read: async (path) => (inside(path) ? fs.read(path).catch(() => null) : null),
    readAncestors: async () => [],
    listMarkdown: async () => [],
  };
}

/** How the ATELIER.md from Settings is named in the prompt, since it has no path. */
export const STORED_PERSONAL = 'ATELIER.md (personal, from Settings)';

/**
 * The administrator's AGENTS.md and ATELIER.md, then the person's own files (docs/PROMPTS.md §1.5). `home` is set only
 * where the person's own computer is (the desktop's, or theirs through their desktop, joined as that computer joins
 * paths); the ATELIER.md `stored` in their preferences works everywhere.
 */
export function instructionGlobals(opts: { configDir: string; home: string | null; claudeCode: boolean; stored: string }): LoadOptions['globals'] {
  const { home } = opts;
  const at = (...parts: string[]) => apiFor(home!).join(home!, ...parts);
  const own = home === null ? [] : [...(opts.claudeCode ? [at('.claude', 'CLAUDE.md')] : []), at(APP.dirName, ATELIER_MD)];
  return [
    // The desktop's config folder is ~/.atelier, whose ATELIER.md is then the owner's own file rather than a system one.
    ...['AGENTS.md', ATELIER_MD].map((name) => join(opts.configDir, name)).filter((path) => !own.includes(path)).map((path) => ({ path, kind: 'system' as const })),
    ...own.map((path) => ({ path, kind: 'personal' as const })),
    ...(opts.stored.trim() ? [{ path: STORED_PERSONAL, kind: 'personal' as const, content: opts.stored }] : []),
  ];
}

const NO_FILES: InstructionReader = { read: async () => null, readAncestors: async () => [], listMarkdown: async () => [] };

export interface LoadOptions {
  /** The backend host's home, for `@~/…` imports in global files. */
  home: string;
  /**
   * Global files in load order: the system AGENTS.md and ATELIER.md, then the person's files. One with `content` is
   * stored by Atelier rather than read from disk (Settings › Account); its `path` only names it, and it imports nothing.
   */
  globals: { path: string; kind: 'system' | 'personal'; content?: string }[];
  /** Reads the global files, on the backend host. */
  host: InstructionReader;
  /** The workspace, read through its runner; absent for chats without a workspace. */
  workspace?: { root: string; home: string; reader: InstructionReader };
  /** Read Claude Code's files (`~/.claude/CLAUDE.md`, `.claude/rules`). */
  claudeCode: boolean;
}

/**
 * A path belongs to the machine that has the file (a Windows laptop, a Linux host, a codespace), so it is joined with
 * that machine's separators and not with the ones of the process that reads it.
 */
const apiFor = (path: string) =>
  /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || (path.includes('\\') && !path.includes('/')) ? win32 : posix;

export async function loadInstructions(opts: LoadOptions): Promise<InstructionFile[]> {
  const seen = new Set<string>();
  const out: InstructionFile[] = [];

  type Source = { reader: InstructionReader; home: string; kind: InstructionKind };
  const add = async (src: Source, file: { path: string; content: string }, importedFrom?: string, depth = 0) => {
    const path = apiFor(file.path).normalize(file.path);
    if (seen.has(path)) return;
    seen.add(path);
    const content = file.content.length > MAX_FILE_CHARS ? `${file.content.slice(0, MAX_FILE_CHARS)}\n[Truncated]` : file.content;
    out.push({ path, kind: src.kind, content, ...(importedFrom ? { importedFrom } : {}) });
    if (depth >= MAX_IMPORT_DEPTH) return;
    for (const target of importsOf(content, apiFor(path).dirname(path), src.home)) {
      if (seen.has(target)) continue;
      const imported = await src.reader.read(target);
      if (imported !== null) await add(src, { path: target, content: imported }, path, depth + 1);
    }
  };

  for (const global of opts.globals) {
    const stored = global.content !== undefined;
    const content = stored ? global.content! : await opts.host.read(global.path);
    if (content !== null && (!stored || content.trim())) await add({ reader: stored ? NO_FILES : opts.host, home: opts.home, kind: global.kind }, { path: global.path, content });
  }

  if (opts.workspace) {
    const { root, reader } = opts.workspace;
    const project: Source = { reader, home: opts.workspace.home, kind: 'project' };
    for (const file of await reader.readAncestors(root, instructionNames(opts.claudeCode))) await add(project, file);
    if (opts.claudeCode) {
      for (const path of (await reader.listMarkdown(apiFor(root).join(root, '.claude/rules'))).sort()) {
        const content = await reader.read(path);
        if (content !== null) await add({ ...project, kind: 'rules' }, { path, content });
      }
    }
  }
  return out;
}

/** `@path` references outside code: `@./docs/style.md`, `@~/notes.md`, `@README.md`. Emails and @mentions are ignored. */
export function importsOf(content: string, baseDir: string, home: string): string[] {
  const prose = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const targets: string[] = [];
  const api = apiFor(baseDir);
  for (const m of prose.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+\.\w+)/g)) {
    const raw = m[1]!;
    const path = raw.startsWith('~/') ? apiFor(home).join(home, raw.slice(2)) : raw.startsWith('/') ? raw : api.join(baseDir, raw);
    targets.push(api.normalize(path));
  }
  return targets;
}

/** Loaded files for the system prompt, most general first; their contents can't open or close Atelier's tags. */
export function renderInstructions(files: InstructionFile[]): string {
  return files.map((f) => `<instructions source="${escapeAttr(f.path)}" kind="${f.kind}">\n${escapeTags(f.content.trim())}\n</instructions>`).join('\n\n');
}
