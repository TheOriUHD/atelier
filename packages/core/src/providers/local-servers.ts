/**
 * Model servers on this computer's default ports (Ollama, llama.cpp, LM Studio), found the same way by the backend's
 * "Detected" list and by a desktop app asked about its own computer for a server (device services, ARCHITECTURE §21).
 */
import { DEFAULT_BASE_URLS, PROVIDER_LABELS, type LocalServer } from '@atelier/protocol';

const DETECT_TIMEOUT_MS = 800;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Default local ports and the response that proves the expected server is behind them. */
const PORT_PROBES: { type: LocalServer['type']; label: string; path: string; accepts(status: number, body: unknown): boolean }[] = [
  { type: 'ollama', label: PROVIDER_LABELS.ollama, path: '/api/version', accepts: (s, b) => s === 200 && isObject(b) && typeof b.version === 'string' },
  // llama-server answers 503 {"error":…} while it is still loading the model.
  { type: 'llamacpp', label: PROVIDER_LABELS.llamacpp, path: '/health', accepts: (s, b) => isObject(b) && ((s === 200 && b.status === 'ok') || (s === 503 && 'error' in b)) },
  { type: 'openai-compatible', label: 'LM Studio', path: '/models', accepts: (s, b) => s === 200 && isObject(b) && Array.isArray(b.data) },
];

/** The servers answering on their default ports, except those `skip` names (`type|baseUrl`). */
export async function detectLocalServers(fetch: (url: string, init: RequestInit) => Promise<Response>, skip: ReadonlySet<string> = new Set()): Promise<LocalServer[]> {
  const found: LocalServer[] = [];
  await Promise.all(
    PORT_PROBES.map(async (p) => {
      const url = DEFAULT_BASE_URLS[p.type];
      if (skip.has(`${p.type}|${url}`)) return;
      try {
        const res = await fetch(url + p.path, { signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) });
        // Other local apps answer on these ports too; only accept the server's own JSON shape.
        const body: unknown = await res.json().catch(() => null);
        if (p.accepts(res.status, body)) found.push({ type: p.type, baseUrl: url, label: p.label });
      } catch {
        // Nothing listening.
      }
    }),
  );
  return found;
}
