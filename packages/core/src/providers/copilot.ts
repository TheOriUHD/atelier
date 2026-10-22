/**
 * GitHub Copilot as a provider: the plan's models through the Copilot API, authorized by the person's GitHub sign-in
 * (copilot-auth.ts). Chat Completions (openai-compatible.ts) is the wire format for every model that takes it; a model
 * that only takes `/responses` goes through the Responses adapter (openai.ts). Models reachable only another way
 * (`/v1/messages`) are left out. "Copilot Auto" asks Copilot's router (`POST /auto`) for the model, as VS Code does, and
 * sends the request to it with the router's session token. The address, the editor headers and the token are set in
 * the fetch the adapters are given. See also docs/ARCHITECTURE.md §7.
 */
import { z } from 'zod';
import { Effort, type Message, type Part } from '@atelier/protocol';
import { DEFAULT_CONTEXT, listedModel } from './catalog.ts';
import { COPILOT_BASE_URL, CopilotSignedOut, EDITOR_HEADERS } from './copilot-auth.ts';
import { guardStream, jsonHeaders, ProviderHttpError, probe, requestJson } from './http.ts';
import { streamChatCompletions } from './openai-compatible.ts';
import { createOpenAIAdapter } from './openai.ts';
import type { AdapterDeps, ChatRequest, CopilotPort, HealthResult, ListedModel, ProviderAdapter, ProviderFetch, ProviderInstance, StreamEvent } from './types.ts';

export type CopilotEndpoint = 'chat' | 'responses';

const MODELS_URL = `${COPILOT_BASE_URL}/models`;
const AUTO_URL = `${COPILOT_BASE_URL}/auto`;

const signedOutResponse = (message: string): Response =>
  new Response(JSON.stringify({ error: { code: 'unauthorized', message } }), { status: 401, headers: { 'content-type': 'application/json' } });

/** The adapters' fetch, sent to the account's API address with its token and the editor headers, and once more after a 401. */
export function copilotFetch(inner: ProviderFetch, auth: CopilotPort): ProviderFetch {
  return async (input, init) => {
    const send = async (force: boolean): Promise<Response> => {
      let credentials;
      try {
        credentials = await auth.credentials({ force });
      } catch (e) {
        if (e instanceof CopilotSignedOut) return signedOutResponse(e.message);
        throw e;
      }
      // The Responses adapter asks for `/v1/responses`; Copilot serves it unversioned.
      const path = input.startsWith(COPILOT_BASE_URL) ? input.slice(COPILOT_BASE_URL.length).replace(/^\/v1\/responses\b/, '/responses') : null;
      const target = path === null ? input : credentials.baseUrl + path;
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${credentials.token}`);
      headers.set('copilot-integration-id', 'vscode-chat');
      headers.set('x-github-api-version', '2025-05-01');
      for (const [name, value] of Object.entries(EDITOR_HEADERS)) headers.set(name, value);
      return inner(target, { ...init, headers });
    };
    const first = await send(false);
    if (first.status !== 401) return first;
    // The Copilot token may have expired early or been revoked: once more with a new one.
    void first.body?.cancel().catch(() => undefined);
    return send(true);
  };
}

const hasImage = (parts: readonly Part[]): boolean => parts.some((p) => p.type === 'image' || (p.type === 'tool_result' && hasImage(p.content)));

/**
 * The headers that say what a request is. `X-Initiator: user` only for the person's own turn (a run's request whose last
 * message is theirs, not tool results): Copilot counts premium requests by it, and everything else (tool-result
 * continuations, sub-agents, titles, summaries) is the agent's.
 */
export function requestHeaders(request: Pick<ChatRequest, 'messages' | 'queue'>): Record<string, string> {
  const last = request.messages.at(-1);
  const ownTurn = (request.queue?.priority ?? 'foreground') === 'foreground' && !!request.queue?.owner && last?.role === 'user' && !last.parts.some((p) => p.type === 'tool_result');
  return {
    'openai-intent': 'conversation-edits',
    'x-initiator': ownTurn ? 'user' : 'agent',
    ...(request.messages.some((m) => hasImage(m.parts)) ? { 'copilot-vision-request': 'true' } : {}),
  };
}

const CopilotModel = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  model_picker_enabled: z.boolean().optional(),
  is_chat_fallback: z.boolean().optional(),
  policy: z.object({ state: z.string().optional() }).optional(),
  billing: z.object({ auto_discount: z.number().optional() }).optional(),
  supported_endpoints: z.array(z.string()).optional(),
  capabilities: z
    .object({
      limits: z.object({ max_context_window_tokens: z.number().optional(), max_output_tokens: z.number().optional(), max_prompt_tokens: z.number().optional() }).optional(),
      supports: z.object({ tool_calls: z.boolean().optional(), vision: z.boolean().optional(), reasoning_effort: z.union([z.boolean(), z.array(z.string())]).optional() }).optional(),
    })
    .optional(),
});
type CopilotModel = z.infer<typeof CopilotModel>;

/** Copilot's router as a model: `POST /auto` picks the real model per conversation, as VS Code's "Auto" does. */
export const AUTO_MODEL = 'auto';

/** The routing profiles `POST /auto` takes, as VS Code offers them ("Optimize for"). */
export type AutoTier = 'efficiency' | 'balance' | 'intelligence';

/** Atelier's effort as Auto's tier: Low saves, Medium balances (VS Code's default), High and above ask for the best. */
export function autoTier(effort: ChatRequest['effort']): AutoTier {
  if (effort === 'low') return 'efficiency';
  if (!effort || effort === 'medium') return 'balance';
  return 'intelligence';
}

const endpointOf = (listed: readonly string[] | undefined): CopilotEndpoint | null =>
  !listed || listed.includes('/chat/completions') ? 'chat' : listed.includes('/responses') ? 'responses' : null;

function limitsOf(m: CopilotModel): { contextLength: number; maxOutput: number } {
  const limits = m.capabilities?.limits ?? {};
  const maxOutput = limits.max_output_tokens ?? 16_384;
  const window = limits.max_context_window_tokens ?? DEFAULT_CONTEXT;
  // The prompt has its own cap, below the window on many models: that is what fills up.
  return { maxOutput, contextLength: limits.max_prompt_tokens ? Math.min(window, limits.max_prompt_tokens + maxOutput) : window };
}

export interface CopilotModelList {
  models: ListedModel[];
  /** How to reach every usable model, listed or not: Auto may route to one the list leaves out. */
  endpoints: Map<string, CopilotEndpoint>;
  /** The plan's fallback model, for when the router can't be reached. */
  fallback: string | null;
}

/**
 * The account's model list: what its picker shows, with tool calls, through an endpoint Atelier speaks, and Auto.
 * Plans that only get Auto (Free, Student) mark every model as not for the picker; then the ones their policy enables
 * are listed instead.
 */
export function copilotModels(instance: ProviderInstance, json: unknown): CopilotModelList {
  const data = z.object({ data: z.array(z.unknown()) }).safeParse(json);
  const endpoints = new Map<string, CopilotEndpoint>();
  const usable: CopilotModel[] = [];
  let fallback: string | null = null;
  for (const raw of data.success ? data.data.data : []) {
    const parsed = CopilotModel.safeParse(raw);
    if (!parsed.success) continue;
    const m = parsed.data;
    if (m.id === AUTO_MODEL || m.policy?.state === 'disabled' || !m.capabilities?.supports?.tool_calls || endpoints.has(m.id)) continue;
    const endpoint = endpointOf(m.supported_endpoints);
    if (!endpoint) continue;
    endpoints.set(m.id, endpoint);
    usable.push(m);
    if (m.is_chat_fallback && !fallback) fallback = m.id;
  }
  const picker = usable.filter((m) => m.model_picker_enabled);
  const restricted = picker.length === 0;
  const shown = restricted ? usable.filter((m) => m.policy?.state === 'enabled') : picker;
  const models = shown.map((m) => {
    const supports = m.capabilities?.supports ?? {};
    const levels = Array.isArray(supports.reasoning_effort) ? supports.reasoning_effort.filter((l) => Effort.safeParse(l).success) : supports.reasoning_effort ? ['low', 'medium', 'high'] : [];
    return listedModel(instance, m.id, {
      displayName: m.name ?? m.id,
      ...limitsOf(m),
      capabilities: { tools: 'native', vision: !!supports.vision, pdf: false, reasoning: levels.length ? 'effort' : 'none', caching: false },
      source: 'detected',
      ...(levels.length ? { effortLevels: levels } : {}),
      tier: 'full',
    });
  });
  if (usable.length > 0) {
    // Models with an Auto discount are the router's pool; a request must fit the smallest of them.
    const pool = usable.some((m) => m.billing?.auto_discount !== undefined) ? usable.filter((m) => m.billing?.auto_discount !== undefined) : usable;
    const limits = pool.map(limitsOf);
    const auto = listedModel(instance, AUTO_MODEL, {
      displayName: 'Copilot Auto',
      contextLength: Math.min(...limits.map((l) => l.contextLength)),
      maxOutput: Math.min(...limits.map((l) => l.maxOutput)),
      capabilities: { tools: 'native', vision: pool.some((m) => m.capabilities?.supports?.vision), pdf: false, reasoning: 'effort', caching: false },
      source: 'detected',
      effortLevels: ['low', 'medium', 'high'],
      tier: 'full',
    });
    if (restricted) models.unshift(auto);
    else models.push(auto);
  }
  return { models, endpoints, fallback };
}

const AutoAnswer = z.object({
  session_token: z.string().min(1),
  expires_at: z.number(),
  selected_model: z.object({ id: z.string().min(1), supported_endpoints: z.array(z.string()).optional() }),
});

interface AutoRoute {
  model: string;
  /** Bills the request against the Auto session; only valid for the model it was issued with. */
  token: string | null;
  endpoint: CopilotEndpoint | null;
  /** Epoch ms after which the conversation is routed again. */
  until: number;
}

/** What the person last asked, for the router to judge. */
function lastPrompt(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n').trim();
    if (text) return text;
  }
  return '';
}

export function createCopilotAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const auth = deps.copilot;
  if (!auth) {
    const unavailable = 'GitHub Copilot is not available on this backend.';
    return {
      type: instance.type,
      listModels: async () => [],
      health: async () => ({ ok: false, latencyMs: null, warnings: [], error: unavailable }),
      async *stream() {
        yield { type: 'finish', reason: 'error', error: { code: 'provider_auth', message: unavailable, retryable: false } };
      },
    };
  }
  const configured: ProviderInstance = { id: instance.id, type: instance.type, name: instance.name, baseUrl: COPILOT_BASE_URL, headers: instance.headers };
  const wrapped: AdapterDeps = { ...deps, fetch: copilotFetch(deps.fetch, auth) };
  let endpoints = new Map<string, CopilotEndpoint>();
  let fallback: string | null = null;
  const routes = new Map<string, Promise<AutoRoute>>();

  async function listModels(signal?: AbortSignal): Promise<ListedModel[]> {
    try {
      const json = await requestJson(wrapped, configured, MODELS_URL, { headers: jsonHeaders(configured, {}), ...(signal ? { signal } : {}) });
      const listed = copilotModels(configured, json);
      endpoints = listed.endpoints;
      fallback = listed.fallback;
      return listed.models;
    } catch (e) {
      // Not signed in is the person's to fix in Settings; health says so.
      if (e instanceof ProviderHttpError && e.error.code === 'provider_auth') return [];
      throw e;
    }
  }

  /** How to reach a model: as last listed, else listed now, else Chat Completions. */
  async function endpointFor(model: string, signal: AbortSignal): Promise<CopilotEndpoint> {
    if (!endpoints.has(model)) await listModels(signal).catch(() => undefined);
    return endpoints.get(model) ?? 'chat';
  }

  /** Asks the router for the conversation's model, once per conversation, tier and image need, until its token runs out. */
  async function route(request: ChatRequest): Promise<AutoRoute> {
    const tier = autoTier(request.effort);
    const image = request.messages.some((m) => hasImage(m.parts));
    const key = request.queue?.owner ? `${request.queue.owner}|${tier}|${image}` : null;
    const cached = key ? routes.get(key) : undefined;
    if (cached) {
      const known = await cached.catch(() => null);
      if (known && known.until > Date.now()) return known;
    }
    const fresh = (async (): Promise<AutoRoute> => {
      try {
        const json = await requestJson(wrapped, configured, AUTO_URL, {
          method: 'POST',
          headers: jsonHeaders(configured, {}),
          body: { prompt: lastPrompt(request.messages), tier, ...(image ? { has_image: true } : {}) },
          signal: request.signal,
        });
        const answer = AutoAnswer.parse(json);
        // Renewed early so a long request can't outlive its token.
        return { model: answer.selected_model.id, token: answer.session_token, endpoint: answer.selected_model.supported_endpoints ? endpointOf(answer.selected_model.supported_endpoints) : null, until: answer.expires_at * 1000 - 5 * 60_000 };
      } catch (e) {
        if (request.signal.aborted) throw e;
        if (!fallback) await listModels(request.signal).catch(() => undefined);
        // Without the router the plan's fallback model still answers, as opencode does; tried again in five minutes.
        if (fallback) return { model: fallback, token: null, endpoint: null, until: Date.now() + 5 * 60_000 };
        throw e;
      }
    })();
    if (key) {
      routes.set(key, fresh);
      fresh.catch(() => routes.get(key) === fresh && routes.delete(key));
      // Bounded: each conversation keeps one entry, the oldest go first.
      while (routes.size > 100) routes.delete(routes.keys().next().value!);
    }
    return fresh;
  }

  async function* streamTo(request: ChatRequest, headers: Record<string, string>, endpoint: CopilotEndpoint): AsyncGenerator<StreamEvent> {
    const target: ProviderInstance = { ...configured, headers: { ...configured.headers, ...requestHeaders(request), ...headers } };
    if (endpoint === 'responses') {
      yield* createOpenAIAdapter(target, wrapped).stream(request);
      return;
    }
    yield* streamChatCompletions({ instance: target, deps: wrapped, url: `${COPILOT_BASE_URL}/chat/completions`, headers: () => jsonHeaders(target, {}) }, request);
  }

  async function* streamAuto(request: ChatRequest): AsyncGenerator<StreamEvent> {
    let routed: AutoRoute;
    try {
      routed = await route(request);
    } catch (e) {
      if (e instanceof ProviderHttpError) {
        yield { type: 'finish', reason: 'error', error: e.error };
        return;
      }
      throw e;
    }
    if (!endpoints.has(routed.model)) await listModels(request.signal).catch(() => undefined);
    const endpoint = endpoints.get(routed.model) ?? routed.endpoint ?? 'chat';
    // The effort went to the router as the tier; VS Code sends the routed model none of its own.
    yield* streamTo({ ...request, model: routed.model, effort: null }, routed.token ? { 'copilot-session-token': routed.token } : {}, endpoint);
  }

  async function* stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    if (request.model === AUTO_MODEL) {
      yield* guardStream(request, configured, () => streamAuto(request));
      return;
    }
    yield* streamTo(request, {}, await endpointFor(request.model, request.signal));
  }

  return {
    type: instance.type,
    listModels,
    async health(signal): Promise<HealthResult> {
      try {
        await auth.credentials();
      } catch (e) {
        return { ok: false, latencyMs: null, warnings: [], error: e instanceof Error ? e.message : 'Not signed in.' };
      }
      return probe(wrapped, configured, MODELS_URL, jsonHeaders(configured, {}), signal);
    },
    stream,
  };
}
