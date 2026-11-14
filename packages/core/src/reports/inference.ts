/**
 * Local model servers in an issue report (ARCHITECTURE §26): for each provider the person set up on this computer or
 * their own network, what the server runs, which models it has and which are loaded right now (with the memory they
 * take). This is what most "it's slow" and "it stopped" reports turn on.
 *
 * Only servers the settings already name are asked, each once, briefly, and without the provider's key: a server that
 * wants one says so and that is reported. Model files are named by their file name, never their folder.
 */
import type { ReportInference } from '@atelier/protocol';
import { rootUrl } from '../providers/util.ts';
import { isLocalServer } from '../providers/scheduler.ts';
import { hostLabel } from './redact.ts';

const PROBE_MS = 1500;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface InferenceTarget {
  type: string;
  baseUrl: string;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 160): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const fileName = (path: unknown): string | undefined => str(typeof path === 'string' ? path.split(/[\\/]/).pop() : undefined);
/** The object without its undefined fields (the schemas' optional fields may be missing, not undefined). */
const defined = <T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;

async function getJson(fetch: Fetch, url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS), headers: { accept: 'application/json' } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function ollama(fetch: Fetch, baseUrl: string): Promise<Partial<ReportInference>> {
  const url = (p: string) => rootUrl(baseUrl, p);
  const [version, tags, ps] = await Promise.all([getJson(fetch, url('/api/version')), getJson(fetch, url('/api/tags')).catch(() => null), getJson(fetch, url('/api/ps')).catch(() => null)]);
  const model = (m: unknown) => {
    const r = rec(m);
    const d = rec(r.details);
    return defined({
      name: str(r.name ?? r.model) ?? 'unknown',
      sizeBytes: num(r.size),
      vramBytes: num(r.size_vram),
      quantization: str(d.quantization_level, 40),
      family: str(d.family, 60),
      parameters: str(d.parameter_size, 40),
      contextLength: num(r.context_length),
      expiresAt: str(r.expires_at, 60),
    });
  };
  return defined({
    version: str(rec(version.body).version, 80),
    models: tags ? arr(rec(tags.body).models).slice(0, 100).map(model) : undefined,
    loaded: ps ? arr(rec(ps.body).models).slice(0, 32).map(model) : undefined,
  });
}

async function llamacpp(fetch: Fetch, baseUrl: string): Promise<Partial<ReportInference>> {
  const url = (p: string) => rootUrl(baseUrl, p);
  const [props, models, health] = await Promise.all([getJson(fetch, url('/props')), getJson(fetch, url('/v1/models')).catch(() => null), getJson(fetch, url('/health')).catch(() => null)]);
  const p = rec(props.body);
  const settings = rec(p.default_generation_settings);
  const loaded = fileName(p.model_path);
  return defined({
    version: str(p.build_info, 80),
    slots: num(p.total_slots),
    models: models ? arr(rec(models.body).data).slice(0, 100).map((m) => defined({ name: fileName(rec(m).id) ?? 'unknown' })) : undefined,
    loaded: loaded ? [defined({ name: loaded, contextLength: num(settings.n_ctx) })] : undefined,
    // 503 while it is still loading the model.
    notes: health && health.status !== 200 ? { health: health.status === 503 ? 'loading the model (HTTP 503)' : `HTTP ${health.status}` } : undefined,
  });
}

/** LM Studio's own API tells loaded from not; any other OpenAI-compatible server lists its models, and vLLM its version. */
async function openaiCompatible(fetch: Fetch, baseUrl: string): Promise<Partial<ReportInference>> {
  const lmstudio = await getJson(fetch, rootUrl(baseUrl, '/api/v0/models')).catch(() => null);
  if (lmstudio && lmstudio.status === 200 && Array.isArray(rec(lmstudio.body).data)) {
    const models = arr(rec(lmstudio.body).data).slice(0, 100).map((m) => {
      const r = rec(m);
      return { loaded: r.state === 'loaded', model: defined({ name: str(r.id) ?? 'unknown', quantization: str(r.quantization, 40), family: str(r.arch, 60), contextLength: num(r.loaded_context_length ?? r.max_context_length) }) };
    });
    return { kind: 'lmstudio', models: models.map((m) => m.model), loaded: models.filter((m) => m.loaded).map((m) => m.model) };
  }
  const base = baseUrl.replace(/\/+$/, '');
  const [list, vllm] = await Promise.all([getJson(fetch, `${base}/models`), getJson(fetch, rootUrl(baseUrl, '/version')).catch(() => null)]);
  const version = vllm && vllm.status === 200 ? str(rec(vllm.body).version, 80) : undefined;
  return defined({
    ...(version ? { kind: 'vllm' } : {}),
    version,
    models: arr(rec(list.body).data).slice(0, 100).map((m) => defined({ name: str(rec(m).id) ?? 'unknown', contextLength: num(rec(m).max_model_len) })),
  });
}

/** ComfyUI's `/system_stats`: its versions and the cards it sees, with their memory. */
async function comfyui(fetch: Fetch, baseUrl: string): Promise<Partial<ReportInference>> {
  const { body } = await getJson(fetch, rootUrl(baseUrl, '/system_stats'));
  const system = rec(rec(body).system);
  return defined({
    version: str(system.comfyui_version, 80),
    devices: arr(rec(body).devices).slice(0, 16).map((d) => {
      const r = rec(d);
      return defined({ name: str(r.name, 200) ?? 'device', type: str(r.type, 40), vramBytes: num(r.vram_total), vramFreeBytes: num(r.vram_free) });
    }),
    notes: defined({ python: str(system.python_version, 60)?.split(' ')[0], pytorch: str(system.pytorch_version, 60), 'RAM free': num(system.ram_free) !== undefined ? `${Math.round(num(system.ram_free)! / 1e9)} GB` : undefined }),
  });
}

const PROBES: Record<string, (fetch: Fetch, baseUrl: string) => Promise<Partial<ReportInference>>> = {
  ollama,
  llamacpp,
  'openai-compatible': openaiCompatible,
  comfyui,
};

/** Servers for these types that answer only "it's there": A1111, SwarmUI, InvokeAI, ACE-Step. */
const REACHABLE_ONLY = new Set(['a1111', 'swarmui', 'invokeai', 'acestep']);

/** The local servers among `targets`, probed together. Public services and unknown types are skipped. */
export async function probeInference(fetch: Fetch, targets: readonly InferenceTarget[]): Promise<ReportInference[]> {
  const seen = new Set<string>();
  const local = targets.filter((t) => {
    const key = `${t.type}|${t.baseUrl.replace(/\/+$/, '')}`;
    if (seen.has(key) || !isLocalServer(t.baseUrl) || (!PROBES[t.type] && !REACHABLE_ONLY.has(t.type))) return false;
    seen.add(key);
    return true;
  });
  return Promise.all(
    local.slice(0, 12).map(async (t): Promise<ReportInference> => {
      const host = hostLabel(t.baseUrl);
      try {
        if (REACHABLE_ONLY.has(t.type)) {
          const res = await fetch(t.baseUrl, { signal: AbortSignal.timeout(PROBE_MS) });
          return { kind: t.type, host, notes: { answered: `HTTP ${res.status}` } };
        }
        const found = await PROBES[t.type]!(fetch, t.baseUrl);
        return { ...found, kind: found.kind ?? t.type, host };
      } catch (e) {
        const message = e instanceof Error ? (e.name === 'TimeoutError' ? 'No answer within 1.5 s.' : (e.cause instanceof Error ? e.cause.message : e.message)) : String(e);
        return { kind: t.type, host, error: message.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g, '<address>').slice(0, 400) };
      }
    }),
  );
}
