/**
 * Which decision models the backend can ask (ARCHITECTURE §28). Mostly nothing to add: an Ollama (0.35 or later) or
 * llama.cpp server set up for chat offers its decision models, an OpenAI key offers OpenAI's, and OpenRouter or
 * Requesty theirs. A service added only for decisions (TypeSafe, Decision Models, any System One server) is the rest.
 */
import type { DecisionServiceConfig, DecisionSource, ProviderConfig } from '@atelier/protocol';
import { isLocalServer } from '../providers/scheduler.ts';
import type { ProviderFetch } from '../providers/types.ts';
import { rootUrl } from '../providers/util.ts';
import type { DecisionDialect } from './wire.ts';

/** Who a decision model belongs to: a text provider (its key and queue) or a decision service. */
export type DecisionOwner = { kind: 'text'; id: string } | { kind: 'service'; id: string };

export interface DecisionTarget {
  source: DecisionSource;
  dialect: DecisionDialect;
  /** The endpoint, whole. */
  url: string;
  model: string;
  owner: DecisionOwner;
  /** Ollama keeps a model loaded as long as it is told (`keep_alive`). */
  ollama: boolean;
}

/** Decision models by name, for servers that can't say which of their models decide (llama.cpp, other local servers). */
const DECISION_NAME = /\b(?:jev|openjev|nimble|tev\d|clef|laya|julia-\d|kev|decider|decision)/i;

/** Among a server's decision models, the ones that decided best in our tests come first (the rest keep their order). */
const PREFERRED = [/^nimble\b/i, /^clef-flash\b/i, /^clef\b/i, /^tev1(?::latest)?$/i, /^tev1\b/i];

const rank = (model: string) => {
  const i = PREFERRED.findIndex((p) => p.test(model));
  return i < 0 ? PREFERRED.length : i;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** A model's name as people know it: no `:latest`, no vendor prefix. */
export const modelLabel = (model: string): string => model.replace(/:latest$/, '');

const textId = (provider: string, model: string) => `text:${provider}:${model}`;
const serviceId = (service: string, model: string) => `service:${service}:${model}`;

/** The parts of a source id; null for one that isn't. */
export function parseSourceId(id: string): { kind: 'text' | 'service'; owner: string; model: string } | null {
  const m = /^(text|service):([^:]+):(.+)$/.exec(id);
  return m ? { kind: m[1] as 'text' | 'service', owner: m[2]!, model: m[3]! } : null;
}

/** How a text provider offers decision models, by its type and address; null when it offers none. */
export function textOffer(p: ProviderConfig): { dialect: DecisionDialect; url: string; list: 'ollama' | 'openai-models' | 'openrouter' | 'requesty' | 'fixed'; fixed?: string[]; local: boolean; ollama: boolean } | null {
  const host = hostOf(p.baseUrl);
  const local = isLocalServer(p.baseUrl);
  if (p.type === 'ollama') return { dialect: 'systemone', url: rootUrl(p.baseUrl, '/v1/systemone'), list: 'ollama', local, ollama: true };
  if (p.type === 'llamacpp') return { dialect: 'systemone', url: rootUrl(p.baseUrl, '/v1/systemone'), list: 'openai-models', local, ollama: false };
  if (p.type === 'openai' && host === 'api.openai.com') return { dialect: 'openai-decisions', url: rootUrl(p.baseUrl, '/v1/decisions'), list: 'fixed', fixed: ['gpt-6-luna'], local: false, ollama: false };
  if (p.type === 'openai-compatible') {
    if (host === 'openrouter.ai') return { dialect: 'systemone', url: rootUrl(p.baseUrl, '/v1/systemone'), list: 'openrouter', local: false, ollama: false };
    if (host === 'router.requesty.ai') return { dialect: 'systemone', url: rootUrl(p.baseUrl, '/v1/systemone'), list: 'requesty', local: false, ollama: false };
    // A local server added as OpenAI-compatible: Ollama's `/v1` or llama.cpp's.
    if (local) return { dialect: 'systemone', url: rootUrl(p.baseUrl, '/v1/systemone'), list: 'ollama', local, ollama: true };
  }
  return null;
}

/** A service's endpoint. */
export const serviceUrl = (s: Pick<DecisionServiceConfig, 'type' | 'baseUrl'>): string => rootUrl(s.baseUrl, s.type === 'openai-decisions' ? '/v1/decisions' : '/v1/systemone');

/** A target for a source id, built from the settings alone (no listing): an admin's choice works without one. */
export function targetFor(id: string, text: readonly ProviderConfig[], services: readonly DecisionServiceConfig[]): DecisionTarget | null {
  const parts = parseSourceId(id);
  if (!parts) return null;
  if (parts.kind === 'text') {
    const p = text.find((x) => x.id === parts.owner && x.enabled !== false);
    const offer = p && textOffer(p);
    if (!p || !offer) return null;
    return { source: { id, label: modelLabel(parts.model), provider: p.name, local: offer.local }, dialect: offer.dialect, url: offer.url, model: parts.model, owner: { kind: 'text', id: p.id }, ollama: offer.ollama };
  }
  const s = services.find((x) => x.id === parts.owner && x.enabled !== false);
  if (!s) return null;
  return { source: { id, label: modelLabel(parts.model), provider: s.name, local: isLocalServer(s.baseUrl) }, dialect: s.type, url: serviceUrl(s), model: parts.model, owner: { kind: 'service', id: s.id }, ollama: false };
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

/** An Ollama server's decision models: `/api/tags` says each model's capabilities (0.40), else `/api/show` does. */
async function ollamaDecisionModels(deps: ListDeps, owner: DecisionOwner, baseUrl: string, signal: AbortSignal): Promise<string[]> {
  const tags = await getJson(deps, owner, rootUrl(baseUrl, '/api/tags'), signal);
  const models = arr(isRecord(tags) ? tags.models : []).filter(isRecord);
  const said = models.filter((m) => Array.isArray(m.capabilities));
  if (said.length === models.length) return models.filter((m) => arr(m.capabilities).includes('decision')).flatMap((m) => str(m.name) ?? str(m.model) ?? []);
  // An older server lists no capabilities: each model's own page says them (Ollama before 0.35 has no decision models).
  const found: string[] = [];
  for (const m of models.slice(0, 60)) {
    const name = str(m.name) ?? str(m.model);
    if (!name) continue;
    const capabilities = Array.isArray(m.capabilities) ? m.capabilities : await getJson(deps, owner, rootUrl(baseUrl, '/api/show'), signal, { model: name }).then((shown) => (isRecord(shown) ? arr(shown.capabilities) : []), () => []);
    if (capabilities.includes('decision')) found.push(name);
  }
  return found;
}

/** A text provider's decision models, best first. */
export async function listTextProvider(deps: ListDeps, p: ProviderConfig, signal: AbortSignal): Promise<DecisionTarget[]> {
  const offer = textOffer(p);
  if (!offer) return [];
  const owner: DecisionOwner = { kind: 'text', id: p.id };
  let models: string[];
  if (offer.list === 'fixed') models = offer.fixed ?? [];
  else if (offer.list === 'ollama') models = await ollamaDecisionModels(deps, owner, p.baseUrl, signal);
  else if (offer.list === 'openrouter') models = ids(await getJson(deps, owner, `${rootUrl(p.baseUrl, '/v1/models')}?output_modalities=decisions`, signal));
  else if (offer.list === 'requesty') models = ids(await getJson(deps, owner, rootUrl(p.baseUrl, '/v1/models/decision'), signal));
  else models = ids(await getJson(deps, owner, rootUrl(p.baseUrl, '/v1/models'), signal)).filter((m) => DECISION_NAME.test(m));
  return [...new Set(models)]
    .sort((a, b) => rank(a) - rank(b))
    .map((model) => ({ source: { id: textId(p.id, model), label: modelLabel(model), provider: p.name, local: offer.local }, dialect: offer.dialect, url: offer.url, model, owner, ollama: offer.ollama }));
}

/** A service's models: the ones typed in, else its list (`GET /v1/models`), else the preset's. */
export async function listService(deps: ListDeps, s: DecisionServiceConfig, signal: AbortSignal, presetModels: readonly string[] = []): Promise<DecisionTarget[]> {
  const owner: DecisionOwner = { kind: 'service', id: s.id };
  let models = s.models?.length ? s.models : [];
  if (!models.length) models = await getJson(deps, owner, rootUrl(s.baseUrl, '/v1/models'), signal).then(ids, () => [...presetModels]);
  if (!models.length) models = [...presetModels];
  return [...new Set(models)].map((model) => ({
    source: { id: serviceId(s.id, model), label: modelLabel(model), provider: s.name, local: isLocalServer(s.baseUrl) },
    dialect: s.type,
    url: serviceUrl(s),
    model,
    owner,
    ollama: false,
  }));
}

/**
 * The one to use when the admin chose none: a model of a service added for decisions (someone chose to pay for it),
 * else one of a server someone runs. A provider's paid models (OpenAI's, OpenRouter's) only when chosen by name.
 */
export function pickAutomatic(targets: readonly DecisionTarget[]): DecisionTarget | null {
  return targets.find((t) => t.owner.kind === 'service') ?? targets.find((t) => t.source.local) ?? null;
}
