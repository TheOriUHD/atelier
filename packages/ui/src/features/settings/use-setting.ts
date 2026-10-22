import { useEffect, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SettingsPath, SettingsSnapshot } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { getPath, setPath } from '../../lib/json-path.ts';
import { keys, usePrefs, useResetPref, useSetPref, useSetSetting, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

export interface Setting<T> {
  path: SettingsPath;
  /** The effective value (all layers merged, defaults applied). */
  value: T;
  /** Set when the effective value comes from the project or local layer. */
  origin: 'project' | 'local' | undefined;
  /** The last failed write, for an inline error. */
  error: string | null;
  /** Writes the global layer. Resolves to false when the write failed. */
  set(value: T): Promise<boolean>;
  /** Deletes the key from the global layer, so the default applies again. */
  clear(): Promise<boolean>;
  /** Deletes the key from the layer it comes from (project or local). */
  reset(): Promise<boolean>;
}

/** Runs writes, keeping the last failure for an inline error (or toasting it) and reloading on failure. */
export function useWrite(options: { toast?: boolean; reload?: () => void } = {}) {
  const [error, setError] = useState<string | null>(null);
  const run = async (write: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await write();
      return true;
    } catch (e) {
      const { message } = describeError(e);
      if (options.toast) toast.error(message);
      else setError(message);
      options.reload?.();
      return false;
    }
  };
  return { error, run };
}

/**
 * One system settings path: its effective value and writers that touch exactly that path. Writes to the
 * global layer update the cache optimistically; the backend's `settings.changed` confirms them.
 * Failures are kept for an inline error, or toasted with `{ toast: true }`.
 */
export function useSetting<T>(path: SettingsPath, options: { toast?: boolean } = {}): Setting<T> {
  const qc = useQueryClient();
  const { data } = useSettings();
  const { mutateAsync } = useSetSetting();
  const { error, run } = useWrite({ ...options, reload: () => void qc.invalidateQueries({ queryKey: keys.settings }) });
  const origin = data?.origins[path.join('.')];
  const scoped = origin === 'project' || origin === 'local' ? origin : undefined;

  return {
    path,
    value: getPath(data?.effective, path) as T,
    origin: scoped,
    error,
    set: (value) => {
      // A project value would win over the global write, so showing it optimistically would lie.
      if (!scoped) qc.setQueryData<SettingsSnapshot>(keys.settings, (s) => s && { ...s, effective: setPath(s.effective, path, value) });
      return run(() => mutateAsync({ path, value }));
    },
    clear: () => run(() => rpc().call('settings.reset', { layer: 'global', path })),
    reset: () => run(() => (scoped ? rpc().call('settings.reset', { layer: scoped, path }) : Promise.resolve())),
  };
}

/** One path of the signed-in person's preferences, with the same shape as a system setting. */
export function usePref<T>(path: SettingsPath): Setting<T> {
  const { prefs } = usePrefs();
  const { mutateAsync: setPref } = useSetPref();
  const { mutateAsync: resetPref } = useResetPref();
  const { error, run } = useWrite();
  const clear = () => run(() => resetPref({ path }));
  return {
    path,
    value: getPath(prefs, path) as T,
    origin: undefined,
    error,
    set: (value) => run(() => setPref({ path, value })),
    clear,
    reset: clear,
  };
}

/**
 * Local text for a string value: saves once typing pauses and on blur. While the field is
 * focused, outside updates don't overwrite what is being typed.
 */
export function useDraftText(setting: Pick<Setting<string>, 'value' | 'set'>, delay = 800) {
  const { value, set } = setting;
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // A draft whose save failed is not retried until it changes.
  const [rejected, setRejected] = useState<string | null>(null);
  if (!focused && draft !== value) setDraft(value);

  useEffect(() => {
    if (!focused || draft === value || draft === rejected) return;
    const timer = setTimeout(() => void set(draft).then((ok) => ok || setRejected(draft)), delay);
    return () => clearTimeout(timer);
  }, [focused, draft, rejected, value, set, delay]);

  return {
    value: draft,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onFocus: () => setFocused(true),
    onBlur: () => {
      if (draft !== value) void set(draft);
      setFocused(false);
    },
  };
}
