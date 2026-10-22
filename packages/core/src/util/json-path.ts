/** Small helpers for addressing values inside JSON documents by path. */
export type JsonPath = readonly (string | number)[];

export function getAt(doc: unknown, path: JsonPath): unknown {
  let cur: unknown = doc;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** Returns a copy of `doc` with `value` at `path`, creating intermediate objects/arrays as needed. */
export function setAt<T>(doc: T, path: JsonPath, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path as [string | number, ...(string | number)[]];
  const base: Record<string | number, unknown> | unknown[] =
    doc !== null && typeof doc === 'object'
      ? Array.isArray(doc)
        ? [...doc]
        : { ...(doc as Record<string, unknown>) }
      : typeof head === 'number'
        ? []
        : {};
  (base as Record<string | number, unknown>)[head] = setAt((base as Record<string | number, unknown>)[head], rest, value);
  return base as T;
}

/** Returns a copy of `doc` without the value at `path`; empty parent objects are pruned. */
export function deleteAt<T>(doc: T, path: JsonPath): T {
  if (path.length === 0 || doc === null || typeof doc !== 'object') return doc;
  const [head, ...rest] = path as [string | number, ...(string | number)[]];
  if (Array.isArray(doc)) {
    const copy = [...doc];
    if (rest.length === 0) copy.splice(Number(head), 1);
    else copy[Number(head)] = deleteAt(copy[Number(head)], rest);
    return copy as T;
  }
  const copy = { ...(doc as Record<string, unknown>) };
  if (rest.length === 0) delete copy[head];
  else {
    const child = deleteAt(copy[head], rest);
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) delete copy[head];
    else copy[head] = child;
  }
  return copy as T;
}

/** Flattens leaf paths ("a.b.0.c") of a JSON object, used to compute setting origins. Arrays count as leaves. */
export function leafPaths(doc: unknown, prefix: string[] = []): string[] {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return prefix.length ? [prefix.join('.')] : [];
  return Object.entries(doc as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, [...prefix, k]));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merges plain objects; arrays and scalars from `over` replace those in `base`. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}
