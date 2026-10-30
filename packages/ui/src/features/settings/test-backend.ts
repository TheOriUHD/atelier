/**
 * In-memory stand-in for the RPC client in Settings, onboarding and sign-in tests:
 * `vi.mock('../../lib/rpc.ts', …)` swaps `rpc()` for `fakeRpc`, and each test sets `backend.handlers`.
 * The signed-in person is an admin with default preferences unless a test says otherwise.
 */
import { defaultSettings, defaultUserPrefs, type ModelInfo, type Settings, type SettingsSnapshot, type UserSummary } from '@atelier/protocol';

type Handler = (input: never) => unknown;

export const backend = {
  calls: [] as { method: string; input: unknown }[],
  handlers: {} as Record<string, Handler>,
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
};

export function user(extra: Partial<UserSummary> = {}): UserSummary {
  return {
    id: 'u-admin',
    username: 'ada',
    name: 'Ada Lovelace',
    role: 'admin',
    avatar: null,
    mustChangePassword: false,
    hasPassword: true,
    disabled: false,
    safeguards: 'inherit',
    createdAt: 0,
    lastActiveAt: null,
    ...extra,
  };
}

export function resetBackend(handlers: Record<string, Handler>): void {
  backend.calls.length = 0;
  backend.listeners.clear();
  backend.handlers = { 'account.get': () => user(), 'prefs.get': () => defaultUserPrefs(), ...handlers };
}

export function callsTo(method: string): unknown[] {
  return backend.calls.filter((c) => c.method === method).map((c) => c.input);
}

/** Delivers a backend event to the subscribed components. */
export function emit(event: string, payload: unknown): void {
  for (const handler of backend.listeners.get(event) ?? []) handler(payload);
}

export const fakeRpc = {
  async call(method: string, input: unknown): Promise<unknown> {
    backend.calls.push({ method, input });
    const handler = backend.handlers[method];
    if (!handler) throw new Error(`Unexpected call: ${method}`);
    return handler(input as never);
  },
  on(event: string, handler: (payload: unknown) => void): () => void {
    const set = backend.listeners.get(event) ?? new Set();
    backend.listeners.set(event, set.add(handler));
    return () => void set.delete(handler);
  },
};

export function snapshot(effective: Partial<Settings> = {}, origins: SettingsSnapshot['origins'] = {}): SettingsSnapshot {
  return { effective: { ...defaultSettings(), ...effective }, origins, projectRoot: null, errors: [] };
}

export function model(providerId: string, modelId: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    ref: `${providerId}/${modelId}`,
    providerId,
    modelId,
    displayName: modelId,
    contextLength: 32_768,
    maxOutput: 8192,
    capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: false },
    tier: 'compact',
    source: 'detected',
    hidden: false,
    favorite: false,
    order: 1000,
    ...extra,
  };
}
