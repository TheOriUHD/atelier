/**
 * The panel's calls to its Worker (deploy/admin). Every call carries `x-atelier-admin: 1` and, when it changes
 * something, a JSON body: the Worker refuses changes without both (CSRF). Cloudflare Access answers a lapsed sign-in
 * with a redirect to its login page, which `redirect: 'manual'` turns into "sign in again" instead of a CORS error.
 */
import { useCallback, useEffect, useState } from 'react';

/** Fired after a change went through (status, labels, note, seen, deletion). */
export const CHANGED = 'atelier-admin:changed';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(path, {
    method,
    headers: {
      'x-atelier-admin': '1',
      accept: 'application/json',
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(init.body),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'manual',
    signal: init.signal ?? null,
  });
  if (res.type === 'opaqueredirect') throw new ApiError('Your sign-in ran out. Reload the page to sign in again.', 401);
  // Something changed: the sidebar's unread counts ask again.
  if (method !== 'GET' && res.ok) window.dispatchEvent(new Event(CHANGED));
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok)
    throw new ApiError(
      typeof data?.error === 'string' ? data.error : `The admin Worker answered HTTP ${res.status}.`,
      res.status,
    );
  return data as T;
}

/** Bytes of a file the API serves (pictures), or null when it isn't there. */
export async function apiBytes(path: string): Promise<Uint8Array | null> {
  const res = await fetch(path, {
    headers: { 'x-atelier-admin': '1' },
    credentials: 'same-origin',
    redirect: 'manual',
  });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (update: (data: T | null) => T | null) => void;
}

/** GETs `path` (again whenever it changes, or on reload); null loads nothing. What was loaded last stays while the next loads. */
export function useApi<T>(path: string | null): Loaded<T> {
  const [tick, setTick] = useState(0);
  const key = path === null ? null : `${tick}:${path}`;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({
    key: null,
    data: null,
    error: null,
  });
  useEffect(() => {
    if (path === null || key === null) return;
    const controller = new AbortController();
    api<T>(path, { signal: controller.signal })
      .then((value) => setState({ key, data: value, error: null }))
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setState((s) => ({ key, data: s.data, error: e instanceof Error ? e.message : String(e) }));
      });
    return () => controller.abort();
  }, [path, key]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback(
    (update: (data: T | null) => T | null) => setState((s) => ({ ...s, data: update(s.data) })),
    [],
  );
  return { data: state.data, error: state.error, loading: key !== null && state.key !== key, reload, setData };
}
