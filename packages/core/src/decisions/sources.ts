/**
 * Which decision models the backend can ask (ARCHITECTURE §28). Mostly nothing to add: a provider set up for chat
 * offers its decision models (an Ollama 0.35 or later, LM Studio, a llama.cpp server, an OpenAI key, OpenRouter,
 * Requesty), and an admin can name any model of such a provider when its server can't say which of its models decide.
 * A service added only for decisions (TypeSafe, Decision Models, any System One server) is the rest.
 */
import type { DecisionServiceConfig, DecisionSource, ProviderConfig } from '@atelier/protocol';
import { lmStudioModels } from '../providers/lmstudio.ts';
import { isLocalServer } from '../providers/scheduler.ts';
import type { ProviderFetch } from '../providers/types.ts';
import { rootUrl } from '../providers/util.ts';
import type { DecisionDialect } from './wire.ts';

/** Who a decision model belongs to: a text provider (its key and queue) or a decision service. */
export type DecisionOwner = { kind: 'text'; id: string } | { kind: 'service'; id: string };

/** A format, or `auto` for a server not known yet: System One first, OpenAI's Decisions when it doesn't know that. */
export type TargetDialect = DecisionDialect | 'auto';

export interface DecisionTarget {
  source: DecisionSource;
  dialect: TargetDialect;
  /** The server's address without `/v1`: each format's path is added to it. */
  root: string;
  model: string;
  owner: DecisionOwner;
  /** Ollama keeps a model loaded as long as it is told (`keep_alive`). */
  ollama: boolean;
  /** LM Studio answers only with a loaded model: where to load this one when it isn't (`POST /api/v1/models/load`). */
  load?: string;
}

/** A format's endpoint on a server. */
export const endpointOf = (root: string, dialect: DecisionDialect): string => `${root}${dialect === 'openai-decisions' ? '/v1/decisions' : '/v1/systemone'}`;

/** Decision models by name, for servers that can't say which of their models decide (llama.cpp, other local servers). */
const DECISION_NAME = /\b(?:jev|openjev|nimble|tev\d|clef|laya|julia-\d|kev|decider|decision)/i;

/** Among a server's decision models, the ones that decided best in our tests come first (the rest keep their order). */
const PREFERRED = [/^nimble\b/i, /^clef-flash\b/i, /^clef\b/i, /^tev1(?::latest)?$/i, /^tev1\b/i];

const rank = (model: string) => {
  const i = PREFERRED.findIndex((p) => p.test(model.split('/').at(-1)!));
  return i < 0 ? PREFERRED.length : i;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** A model's name as people know it: no `:latest`. */
export const modelLabel = (model: string): string => model.replace(/:latest$/, '');

const textId = (provider: string, model: string) => `text:${provider}:${model}`;
const serviceId = (service: string, model: string) => `service:${service}:${model}`;

/** The parts of a source id; null for one that isn't. */
export function parseSourceId(id: string): { kind: 'text' | 'service'; owner: string; model: string } | null {
  const m = /^(text|service):([^:]+):(.+)$/.exec(id);
  return m ? { kind: m[1] as 'text' | 'service', owner: m[2]!, model: m[3]! } : null;
}

type ListWay = 'ollama' | 'local' | 'openrouter' | 'requesty' | 'fixed' | 'none';

/**
 * How a text provider offers decision models, by its type and address; null when it can't have any (Anthropic, a
 * ChatGPT or Copilot sign-in, Mistral). `named`: an admin names one of its models, so a server Atelier can't list
 * decision models of (an OpenAI-compatible server elsewhere) counts too.
 */
export function textOffer(p: ProviderConfig, named = false): { dialect: TargetDialect; list: ListWay; fixed?: string[]; local: boolean; ollama: boolean } | null {
  const host = hostOf(p.baseUrl);
  const local = isLocalServer(p.baseUrl);
  if (p.type === 'ollama') return { dialect: 'systemone', list: 'ollama', local, ollama: true };
  if (p.type === 'llamacpp') return { dialect: 'auto', list: 'local', local, ollama: false };
  if (p.type === 'openai') {
    if (host === 'api.openai.com') return { dialect: 'openai-decisions', list: 'fixed', fixed: ['gpt-6-luna'], local: false, ollama: false };
    return named ? { dialect: 'auto', list: 'none', local, ollama: false } : null;
  }
  if (p.type === 'openai-compatible') {
    if (host === 'openrouter.ai') return { dialect: 'systemone', list: 'openrouter', local: false, ollama: false };
    if (host === 'router.requesty.ai') return { dialect: 'systemone', list: 'requesty', local: false, ollama: false };
    // A server on this computer or the network (LM Studio, llama.cpp, vLLM, Ollama's `/v1`): it is asked what it has.
    if (local) return { dialect: 'auto', list: 'local', local, ollama: false };
    return named ? { dialect: 'auto', list: 'none', local, ollama: false } : null;
  }
  return null;
}

/** The providers an admin can name a decision model of. */
export const namableProviders = (text: readonly ProviderConfig[]): ProviderConfig[] => text.filter((p) => p.enabled !== false && textOffer(p, true));

/** A service's target for one of its models. */
function serviceTarget(s: DecisionServiceConfig, model: string): DecisionTarget {
  return { source: { id: serviceId(s.id, model), label: modelLabel(model), provider: s.name, local: isLocalServer(s.baseUrl) }, dialect: s.type, root: rootUrl(s.baseUrl, ''), model, owner: { kind: 'service', id: s.id }, ollama: false };
}

/**
 * A target for a source id: the one a listing found (which knows the server's format and whether LM Studio has the
 * model loaded), else one built from the settings alone, so an admin's choice works without a listing.
 */
export function targetFor(id: string, text: readonly ProviderConfig[], services: readonly DecisionServiceConfig[], listed: readonly DecisionTarget[] = []): DecisionTarget | null {
  const parts = parseSourceId(id);
  if (!parts) return null;
  if (parts.kind === 'text') {
    const p = text.find((x) => x.id === parts.owner && x.enabled !== false);
    const offer = p && textOffer(p, true);
    if (!p || !offer) return null;
    const found = listed.find((t) => t.source.id === id);
    if (found) return { ...found, source: { ...found.source, provider: p.name } };
    return { source: { id, label: modelLabel(parts.model), provider: p.name, local: offer.local }, dialect: offer.dialect, root: rootUrl(p.baseUrl, ''), model: parts.model, owner: { kind: 'text', id: p.id }, ollama: offer.ollama };
  }
  const s = services.find((x) => x.id === parts.owner && x.enabled !== false);
  return s ? serviceTarget(s, parts.model) : null;
}

export interface ListDeps {
  fetch: ProviderFetch;
  credentials(owner: DecisionOwner): Promise<{ apiKey?: string | undefined; headers: Record<string, string> }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

async function getJson(deps: ListDeps, owner: DecisionOwner, url: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const { apiKey, headers } = await deps.credentials(owner);
  const res = await deps.fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** Model ids in an OpenAI-style list (`{ data: [{ id }] }`) or a list of names (`{ models: [{ name }] }`). */
function ids(json: unknown): string[] {
  const list = isRecord(json) ? (Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : []) : arr(json);
  return list.flatMap((m) => {
    const id = isRecord(m) ? (str(m.id) ?? str(m.name) ?? str(m.model)) : str(m);
    return id ? [id] : [];
  });
}

/**
 * An Ollama server's decision models: `/api/tags` says each model's capabilities (0.40), else `/api/show` does. Null
 * when the server isn't an Ollama (no model list there).
 */
async function ollamaDecisionModels(deps: ListDeps, owner: DecisionOwner, root: string, signal: AbortSignal): Promise<string[] | null> {
  const tags = await getJson(deps, owner, `${root}/api/tags`, signal).catch(() => null);
  if (!isRecord(tags) || !Array.isArray(tags.models)) return null;
  const models = tags.models.filter(isRecord);
  const said = models.filter((m) => Array.isArray(m.capabilities));
  if (said.length === models.length) return models.filter((m) => arr(m.capabilities).includes('decision')).flatMap((m) => str(m.name) ?? str(m.model) ?? []);
  // An older server lists no capabilities: each model's own page says them (Ollama before 0.35 has no decision models).
  const found: string[] = [];
  for (const m of models.slice(0, 60)) {
    const name = str(m.name) ?? str(m.model);
    if (!name) continue;
    const capabilities = Array.isArray(m.capabilities) ? m.capabilities : await getJson(deps, owner, `${root}/api/show`, signal, { model: name }).then((shown) => (isRecord(shown) ? arr(shown.capabilities) : []), () => []);
    if (capabilities.includes('decision')) found.push(name);
  }
  return found;
}

interface Found {
  model: string;
  dialect: TargetDialect;
  ollama?: boolean;
  load?: string;
}

/**
 * A server on this computer or the network, asked what it is: LM Studio says which models decide and whether they are
 * loaded (and serves them on OpenAI's `/v1/decisions`, which its docs name), an Ollama behind an OpenAI-compatible
 * address says so in `/api/tags`, and anything else (llama.cpp) is read by the models' names. A server that answers
 * every address with a 200 and an error (an LM Studio from before decision models) falls through to the names.
 */
async function localDecisionModels(deps: ListDeps, owner: DecisionOwner, root: string, signal: AbortSignal): Promise<Found[]> {
  const lm = lmStudioModels(await getJson(deps, owner, `${root}/api/v1/models`, signal).catch(() => null));
  if (lm) return lm.filter((m) => m.type === 'decision').map((m) => ({ model: m.key, dialect: 'openai-decisions' as const, ...(m.loaded.length ? {} : { load: `${root}/api/v1/models/load` }) }));
  const ollama = await ollamaDecisionModels(deps, owner, root, signal);
  if (ollama) return ollama.map((model) => ({ model, dialect: 'systemone' as const, ollama: true }));
  const named = ids(await getJson(deps, owner, `${root}/v1/models`, signal).catch(() => null)).filter((m) => DECISION_NAME.test(m));
  return named.map((model) => ({ model, dialect: 'auto' as const }));
}

/** A text provider's decision models, best first. */
export async function listTextProvider(deps: ListDeps, p: ProviderConfig, signal: AbortSignal): Promise<DecisionTarget[]> {
  const offer = textOffer(p);
  if (!offer) return [];
  const owner: DecisionOwner = { kind: 'text', id: p.id };
  const root = rootUrl(p.baseUrl, '');
  let found: Found[];
  if (offer.list === 'fixed') found = (offer.fixed ?? []).map((model) => ({ model, dialect: offer.dialect }));
  else if (offer.list === 'ollama') found = ((await ollamaDecisionModels(deps, owner, root, signal)) ?? []).map((model) => ({ model, dialect: 'systemone' as const, ollama: true }));
  else if (offer.list === 'local') found = await localDecisionModels(deps, owner, root, signal);
  else if (offer.list === 'openrouter') found = ids(await getJson(deps, owner, `${root}/v1/models?output_modalities=decisions`, signal)).map((model) => ({ model, dialect: offer.dialect }));
  else if (offer.list === 'requesty') found = ids(await getJson(deps, owner, `${root}/v1/models/decision`, signal)).map((model) => ({ model, dialect: offer.dialect }));
  else found = [];
  const seen = new Set<string>();
  return found
    .filter((f) => !seen.has(f.model) && seen.add(f.model))
    .sort((a, b) => rank(a.model) - rank(b.model))
    .map((f) => ({
      source: { id: textId(p.id, f.model), label: modelLabel(f.model), provider: p.name, local: offer.local },
      dialect: f.dialect,
      root,
      model: f.model,
      owner,
      ollama: f.ollama ?? offer.ollama,
      ...(f.load ? { load: f.load } : {}),
    }));
}

/** A service's models: the ones typed in, else its list (`GET /v1/models`), else the preset's. */
export async function listService(deps: ListDeps, s: DecisionServiceConfig, signal: AbortSignal, presetModels: readonly string[] = []): Promise<DecisionTarget[]> {
  const owner: DecisionOwner = { kind: 'service', id: s.id };
  let models = s.models?.length ? s.models : [];
  if (!models.length) models = await getJson(deps, owner, `${rootUrl(s.baseUrl, '')}/v1/models`, signal).then(ids, () => [...presetModels]);
  if (!models.length) models = [...presetModels];
  return [...new Set(models)].map((model) => serviceTarget(s, model));
}

/**
 * The one to use when the admin chose none: a model of a service added for decisions (someone chose to pay for it),
 * else one of a server someone runs. A provider's paid models (OpenAI's, OpenRouter's) only when chosen by name.
 */
export function pickAutomatic(targets: readonly DecisionTarget[]): DecisionTarget | null {
  return targets.find((t) => t.owner.kind === 'service') ?? targets.find((t) => t.source.local) ?? null;
}
