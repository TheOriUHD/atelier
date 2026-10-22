import type { SettingsPath } from '@atelier/protocol';

export function getPath(doc: unknown, path: SettingsPath): unknown {
  let cur = doc;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** Copy of `doc` with `value` at `path`, creating objects along the way. */
export function setPath<T>(doc: T, path: SettingsPath, value: unknown): T {
  const [head, ...rest] = path;
  if (head === undefined) return value as T;
  const base = (Array.isArray(doc) ? [...(doc as unknown[])] : { ...(doc as object) }) as Record<string | number, unknown>;
  base[head] = rest.length ? setPath(base[head], rest as SettingsPath, value) : value;
  return base as T;
}
