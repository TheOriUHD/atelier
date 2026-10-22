/**
 * Comparing file paths across platforms. A path reaches the backend in several forms: `C:\Users\me\app` from a
 * folder picker or `path.resolve`, `C:/Users/me/app` from git and the runner, any mix of case on a case-insensitive
 * disk. Decisions about paths (does a permission rule match, is this file inside the workspace) are made on one
 * comparison form, `key()`: `/` separators, no trailing separator, and on Windows folded to lower case.
 * `pathOps()` is the host's; tests name a platform to check the other one from any machine.
 */
import { posix, win32 } from 'node:path';

export type PathFlavor = 'posix' | 'win32';

export interface PathOps {
  flavor: PathFlavor;
  isAbsolute(path: string): boolean;
  /** `path` as an absolute path in this platform's own form, relative ones taken from `cwd`. */
  absolute(path: string, cwd: string): string;
  /** The form paths are compared in. Never shown to anyone. */
  key(path: string): string;
  /** `path` is `root` or something below it. */
  within(path: string, root: string): boolean;
  /** `path` is strictly below `root`. */
  below(path: string, root: string): boolean;
  /** `path` below `root` as `/`-separated segments (original case), or null when it isn't below it. */
  relative(path: string, root: string): string | null;
}

/** The path operations of this machine, or of `flavor` (tests). */
export function pathOps(flavor: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix'): PathOps {
  const win = flavor === 'win32';
  const api = win ? win32 : posix;
  const slashes = (p: string) => (win ? p.replace(/\\/g, '/') : p);
  const key = (p: string): string => {
    let k = slashes(api.isAbsolute(p) ? api.resolve(p) : api.normalize(p));
    // `C:/` and `/` are roots and keep their slash; everything else loses a trailing one.
    if (k.length > 1 && k.endsWith('/') && !/^[a-zA-Z]:\/$/.test(k)) k = k.slice(0, -1);
    return win ? k.toLowerCase() : k;
  };
  const below = (path: string, root: string): boolean => {
    const p = key(path);
    const r = key(root);
    return p !== r && p.startsWith(r.endsWith('/') ? r : `${r}/`);
  };
  return {
    flavor,
    isAbsolute: (p) => api.isAbsolute(p),
    absolute: (p, cwd) => (api.isAbsolute(p) ? api.resolve(p) : api.resolve(cwd, p)),
    key,
    within: (path, root) => key(path) === key(root) || below(path, root),
    below,
    relative: (path, root) => {
      if (!below(path, root)) return null;
      const segments = (s: string) => s.split('/').filter(Boolean);
      return segments(slashes(api.isAbsolute(path) ? api.resolve(path) : api.normalize(path))).slice(segments(key(root)).length).join('/');
    },
  };
}

/** A path as this machine writes it: `C:/Users/me` from git becomes `C:\Users\me` on Windows; unchanged elsewhere. */
export function nativePath(path: string): string {
  return process.platform === 'win32' ? win32.normalize(path) : path;
}
