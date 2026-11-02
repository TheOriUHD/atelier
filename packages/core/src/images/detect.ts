/** Image servers on this computer's default ports, each proved by a reply only that server gives. */
import { imagePreset, type DetectedImageServer } from '@atelier/protocol';

const DETECT_TIMEOUT_MS = 800;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const PROBES: { preset: string; path: string; method?: 'POST'; accepts(status: number, body: unknown): boolean }[] = [
  { preset: 'comfyui', path: '/system_stats', accepts: (s, b) => s === 200 && isObject(b) && 'system' in b && 'devices' in b },
  { preset: 'forge', path: '/sdapi/v1/sd-models', accepts: (s, b) => s === 200 && Array.isArray(b) },
  { preset: 'koboldcpp', path: '/sdapi/v1/sd-models', accepts: (s, b) => s === 200 && Array.isArray(b) },
  { preset: 'swarmui', path: '/API/GetNewSession', method: 'POST', accepts: (s, b) => s === 200 && isObject(b) && typeof b.session_id === 'string' },
  { preset: 'invokeai', path: '/api/v1/app/version', accepts: (s, b) => s === 200 && isObject(b) && typeof b.version === 'string' },
  { preset: 'localai', path: '/v1/models', accepts: (s, b) => s === 200 && isObject(b) && Array.isArray(b.data) },
];

export async function detectImageServers(fetch: (url: string, init: RequestInit) => Promise<Response>, skip: ReadonlySet<string> = new Set()): Promise<DetectedImageServer[]> {
  const found: DetectedImageServer[] = [];
  await Promise.all(
    PROBES.map(async (p) => {
      const preset = imagePreset(p.preset)!;
      if (skip.has(preset.baseUrl)) return;
      try {
        const res = await fetch(preset.baseUrl + p.path, { method: p.method ?? 'GET', ...(p.method ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}), signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) });
        const body: unknown = await res.json().catch(() => null);
        if (p.accepts(res.status, body)) found.push({ preset: preset.id, type: preset.type, baseUrl: preset.baseUrl, label: preset.label });
      } catch {
        // Nothing listening.
      }
    }),
  );
  return found.sort((a, b) => a.label.localeCompare(b.label));
}
