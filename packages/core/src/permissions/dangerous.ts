/**
 * Commands that always get a prompt with a warning outside Bypass mode, even when an allow rule matches
 * (ARCHITECTURE §8). Checked per simple command; `curl … | sh` is checked on the whole line.
 */
import { pathOps, type PathFlavor } from '../paths.ts';
import { commandWord, gitSubcommand, splitCommand, words } from './bash.ts';

export interface PathContext {
  cwd: string;
  home: string;
  /** Workspace roots; deleting outside them is dangerous. */
  roots: string[];
  /** Folders (the system's temp folders) below which deleting is ordinary scratch work: strictly below, never a glob. */
  scratch?: string[];
  /** Which platform's paths these are: this machine's unless a test says otherwise. */
  flavor?: PathFlavor;
}

const SHELLS = /^(sudo\s+)?(sh|bash|zsh|dash|fish|python3?|node|perl|ruby)\b/;

export function dangerousReason(command: string, ctx: PathContext): string | null {
  const { parts } = splitCommand(command);
  // Pipelines into an interpreter: compare each part with the one feeding it.
  const segments = command.split('|');
  for (let i = 1; i < segments.length; i++) {
    if (/\b(curl|wget|fetch)\b/.test(segments[i - 1]!) && SHELLS.test(segments[i]!.trim()))
      return 'pipes a download straight into a shell';
  }
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) return 'is a fork bomb';
  for (const part of parts) {
    const reason = partReason(part, ctx);
    if (reason) return reason;
  }
  return null;
}

function partReason(part: string, ctx: PathContext): string | null {
  const all = words(part);
  const cmd = commandWord(part);
  if (!cmd) return null;
  const args = all.slice(all.indexOf(cmd) + 1);
  const flags = args.filter((a) => a.startsWith('-'));
  const has = (...names: string[]) => names.some((n) => flags.includes(n));
  const shortFlags = flags.filter((f) => /^-[a-zA-Z]+$/.test(f)).join('');

  switch (cmd) {
    case 'sudo':
    case 'doas':
      return 'runs as root';
    case 'find': {
      // `find … -delete` and `find … -exec rm …` delete under find's starting points (the words before its tests).
      const deletes =
        args.includes('-delete') || args.some((a, i) => /^-(exec|execdir|ok|okdir)$/.test(a) && args[i + 1] === 'rm');
      if (!deletes) return null;
      const end = args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!');
      const starts = end < 0 ? args : args.slice(0, end);
      const outside = (starts.length > 0 ? starts : ['.']).find((t) => !withinRoots(t, ctx));
      return outside ? `deletes files under ${outside}, outside the workspace` : null;
    }
    case 'rm': {
      const recursive = /[rR]/.test(shortFlags) || has('--recursive');
      if (!recursive) return null;
      const targets = args.filter((a) => !a.startsWith('-'));
      const outside = targets.find((t) => !insideRoots(t, ctx));
      return outside ? `recursively deletes ${outside}, outside the workspace` : null;
    }
    case 'git': {
      // Past git's own options: `git -c k=v -C dir push --force` force-pushes too.
      const { sub } = gitSubcommand(args);
      if (sub === 'push' && (has('--force', '-f', '--force-with-lease') || args.some((a) => /^\+/.test(a))))
        return 'force-pushes, rewriting remote history';
      if (sub === 'reset' && has('--hard')) return 'discards uncommitted changes (git reset --hard)';
      if (sub === 'clean' && /f/.test(shortFlags)) return 'deletes untracked files (git clean -f)';
      return null;
    }
    case 'chmod':
      return (/R/.test(shortFlags) || has('--recursive')) && args.includes('777')
        ? 'makes files world-writable recursively'
        : null;
    case 'dd':
      return args.some((a) => /^of=\/dev\//.test(a)) ? 'writes directly to a device' : null;
    case 'shutdown':
    case 'reboot':
    case 'halt':
    case 'poweroff':
      return 'shuts down or restarts the machine';
    default:
      return /^mkfs(\.|$)/.test(cmd) ? 'formats a filesystem' : null;
  }
}

/** `~` or `~/…` (and `~\…` on Windows) with the home folder put in. */
function expandHome(target: string, ctx: PathContext): string {
  const win = pathOps(ctx.flavor).flavor === 'win32';
  return target === '~' || target.startsWith('~/') || (win && target.startsWith('~\\')) ? ctx.home + target.slice(1) : target;
}

/** Below a scratch folder (a temp folder), and not a pattern that could stand for several things there. */
function inScratch(target: string, ctx: PathContext): boolean {
  if (!ctx.scratch?.length || /[*?[]/.test(target)) return false;
  const ops = pathOps(ctx.flavor);
  const abs = ops.absolute(target, ctx.cwd);
  return ctx.scratch.some((dir) => ops.below(abs, dir));
}

/** Inside a workspace root or the root itself (find deletes what is below its starting point). */
function withinRoots(target: string, ctx: PathContext): boolean {
  const ops = pathOps(ctx.flavor);
  const abs = ops.absolute(expandHome(target, ctx), ctx.cwd);
  return ctx.roots.some((root) => ops.within(abs, root)) || inScratch(target, ctx);
}

/** Strictly below a workspace root: removing the root itself is not "inside". */
function insideRoots(target: string, ctx: PathContext): boolean {
  const ops = pathOps(ctx.flavor);
  const expanded = expandHome(target, ctx);
  if (/[*?]/.test(expanded) && !(ops.flavor === 'win32' ? /[\\/]/ : /\//).test(expanded)) return true; // a glob in the cwd
  const abs = ops.absolute(expanded, ctx.cwd);
  return ctx.roots.some((root) => ops.below(abs, root)) || inScratch(target, ctx);
}
