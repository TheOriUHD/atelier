/**
 * Image and sound servers on this computer's default ports, each proved by a reply only that server gives. Found the same way by
 * the backend's list and by a desktop app asked about its own computer for a server (device services, ARCHITECTURE §21).
 */
import { imagePreset, type DetectedImageServer } from '@atelier/protocol';

const DETECT_TIMEOUT_MS = 800;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * AUTOMATIC1111, its forks and Draw Things share port 7860, so each has its own proof, and `a1111` stands aside for a
 * fork that also answered: every one of them lists checkpoints the same way. Ollama isn't here: its current versions
 * can't make images (see dialects/openai-local.ts), and llama.cpp's server on 8080 and LM Studio on 1234 also answer
 * `/v1/models`, which is why LocalAI and sd-server need more than that.
 */
const PROBES: { preset: string; path: string; method?: 'POST'; accepts(status: number, body: unknown): boolean; unless?: readonly string[] }[] = [
  { preset: 'comfyui', path: '/system_stats', accepts: (s, b) => s === 200 && isObject(b) && 'system' in b && 'devices' in b },
  { preset: 'a1111', path: '/sdapi/v1/sd-models', accepts: (s, b) => s === 200 && Array.isArray(b), unless: ['forge', 'sdnext'] },
  { preset: 'forge', path: '/sdapi/v1/sd-modules', accepts: (s, b) => s === 200 && Array.isArray(b) },
  { preset: 'sdnext', path: '/sdapi/v1/version', accepts: (s, b) => s === 200 && isObject(b) && b.app === 'sd.next' },
  { preset: 'drawthings', path: '/sdapi/v1/options', accepts: (s, b) => s === 200 && isObject(b) && typeof b.model === 'string' && 'guidance_scale' in b && !('sd_model_checkpoint' in b) },
  // It answers with an empty list when it runs without an image model, which is a text server to us.
  { preset: 'koboldcpp', path: '/sdapi/v1/sd-models', accepts: (s, b) => s === 200 && Array.isArray(b) && b.length > 0 },
  { preset: 'sd-server', path: '/sdcpp/v1/models/status', accepts: (s, b) => s === 200 && isObject(b) && typeof b.state === 'string' },
  { preset: 'swarmui', path: '/API/GetNewSession', method: 'POST', accepts: (s, b) => s === 200 && isObject(b) && typeof b.session_id === 'string' },
  { preset: 'invokeai', path: '/api/v1/app/version', accepts: (s, b) => s === 200 && isObject(b) && typeof b.version === 'string' },
  { preset: 'localai', path: '/v1/models/capabilities', accepts: (s, b) => s === 200 && isObject(b) && Array.isArray(b.data) },
  // Sound. KoboldCpp answers like ComfyUI, AUTOMATIC1111 and Ollama too, so its own version route is the proof.
  { preset: 'localai-speech', path: '/v1/models/capabilities', accepts: (s, b) => s === 200 && isObject(b) && Array.isArray(b.data) },
  { preset: 'kokoro', path: '/v1/audio/voices', accepts: (s, b) => s === 200 && isObject(b) && Array.isArray(b.voices) && 'default_voice' in b },
  { preset: 'speaches', path: '/v1/registry', accepts: (s, b) => s === 200 && (Array.isArray(b) || (isObject(b) && Array.isArray(b.data))) },
  { preset: 'koboldcpp-speech', path: '/api/extra/version', accepts: (s, b) => s === 200 && isObject(b) && b.result === 'KoboldCpp' && !!b.tts },
  { preset: 'chatterbox', path: '/v1/audio/voices', accepts: (s, b) => s === 200 && isObject(b) && Array.isArray(b.voices) },
  { preset: 'ollama-speech', path: '/api/tags', accepts: (s, b) => s === 200 && isObject(b) && Array.isArray(b.models) && b.models.some((m) => isObject(m) && /phonon/i.test(String(m.name))) },
  { preset: 'acestep', path: '/v1/models', accepts: (s, b) => s === 200 && isObject(b) && 'code' in b && 'data' in b },
  { preset: 'fish-speech', path: '/v1/health', accepts: (s, b) => s === 200 && isObject(b) && !('data' in b) },
];

export async function detectImageServers(fetch: (url: string, init: RequestInit) => Promise<Response>, skip: ReadonlySet<string> = new Set()): Promise<DetectedImageServer[]> {
  const found = new Map<string, DetectedImageServer>();
  await Promise.all(
    PROBES.map(async (p) => {
      const preset = imagePreset(p.preset)!;
      if (skip.has(preset.baseUrl)) return;
      try {
        // A redirect is no proof, and following one would send the probe somewhere other than this default port.
        const res = await fetch(preset.baseUrl + p.path, { method: p.method ?? 'GET', redirect: 'manual', ...(p.method ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}), signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) });
        const body: unknown = await res.json().catch(() => null);
        if (p.accepts(res.status, body)) found.set(preset.id, { preset: preset.id, type: preset.type, baseUrl: preset.baseUrl, label: preset.label });
      } catch {
        // Nothing listening.
      }
    }),
  );
  const stoodAside = new Set(PROBES.filter((p) => p.unless?.some((other) => found.has(other))).map((p) => p.preset));
  return [...found.values()].filter((server) => !stoodAside.has(server.preset)).sort((a, b) => a.label.localeCompare(b.label));
}
