/**
 * The ChatGPT subscription as a provider: the OpenAI Responses adapter (openai.ts), pointed at the ChatGPT backend
 * Codex uses and authorized by the person's sign-in (chatgpt-auth.ts). Everything that differs is done in the fetch it
 * is given: the address, the account's headers, and the parts of the body this backend refuses. See also
 * docs/ARCHITECTURE.md §7.
 */
import { createHash, randomUUID } from 'node:crypto';
import { listedModel, openaiCatalog } from './catalog.ts';
import { CHATGPT_BASE_URL, ChatGptSignedOut } from './chatgpt-auth.ts';
import { ProviderHttpError, requestJson } from './http.ts';
import { createOpenAIAdapter } from './openai.ts';
import type { AdapterDeps, ChatGptPort, HealthResult, ListedModel, ProviderAdapter, ProviderFetch, ProviderInstance } from './types.ts';
import { arr, isRecord, num, rec, str } from './util.ts';

/** Sent as the client's own name. */
const ORIGINATOR = 'atelier';
/**
 * The account's model list is keyed to a Codex client version: newer models are listed only to a client that is at least
 * the version they need. So the version asked with is the current one Codex has (looked up, cached), and this one only
 * when that can't be.
 */
const FALLBACK_CLIENT_VERSION = '0.162.1';
const VERSION_URL = 'https://registry.npmjs.org/@openai/codex/latest';
const VERSION_TTL_MS = 6 * 60 * 60_000;
/** What the account's models list answers with when it can't be reached: ids the plan has carried. */
const FALLBACK_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

let latest: { version: string; at: number } | null = null;

/** The newest published Codex version, for the model list; the last one known (or the built-in one) when it can't be read. */
export async function codexClientVersion(inner: ProviderFetch, now = Date.now()): Promise<string> {
  if (latest && now - latest.at < VERSION_TTL_MS) return latest.version;
  try {
    const res = await inner(VERSION_URL, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    const version = res.ok ? str(rec(await res.json()).version) : undefined;
    if (version && /^\d+\.\d+\.\d+$/.test(version)) latest = { version, at: now };
  } catch {
    // Offline or the registry is down: what is known stays.
  }
  // A failed look-up is not retried for every request: the version in hand counts as fresh for a few minutes.
  if (latest && latest.at !== now) latest = { ...latest, at: now - VERSION_TTL_MS + 5 * 60_000 };
  return latest?.version ?? FALLBACK_CLIENT_VERSION;
}

/** Tests: forget what was looked up. */
export function resetCodexClientVersion(): void {
  latest = null;
}
/** Parameters this backend refuses (it sets sampling and output length itself). */
const DROPPED = ['max_output_tokens', 'temperature', 'top_p'];

const signedOutResponse = (message: string): Response =>
  new Response(JSON.stringify({ error: { code: 'unauthorized', message } }), { status: 401, headers: { 'content-type': 'application/json' } });

/** The adapter's fetch, with the backend's address, account headers and body rules applied, and one retry on a 401. */
export function codexFetch(inner: ProviderFetch, auth: ChatGptPort): ProviderFetch {
  return async (input, init) => {
    const path = new URL(input).pathname;
    const models = path.endsWith('/models');
    const target = models ? `${CHATGPT_BASE_URL}/models?client_version=${await codexClientVersion(inner)}` : `${CHATGPT_BASE_URL}/responses`;

    let body = init.body;
    let sessionId: string = randomUUID();
    if (!models && typeof body === 'string') {
      const json = rec(JSON.parse(body));
      for (const key of DROPPED) delete json[key];
      json.store = false;
      json.stream = true;
      // Parallel calls are the model's to ask for; this backend wants it said either way.
      json.parallel_tool_calls ??= false;
      // One cache key per conversation: the system prompt is frozen for a session.
      const instructions = str(json.instructions) ?? '';
      sessionId = createHash('sha256').update(instructions).digest('hex').slice(0, 32);
      json.prompt_cache_key = sessionId;
      body = JSON.stringify(json);
    }

    const send = async (force: boolean): Promise<Response> => {
      let credentials;
      try {
        credentials = await auth.credentials({ force });
      } catch (e) {
        if (e instanceof ChatGptSignedOut) return signedOutResponse(e.message);
        throw e;
      }
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${credentials.accessToken}`);
      headers.set('chatgpt-account-id', credentials.accountId);
      headers.set('originator', ORIGINATOR);
      headers.set('openai-beta', 'responses=experimental');
      headers.set('session-id', sessionId);
      headers.set('x-codex-installation-id', credentials.installationId);
      headers.set('user-agent', 'Atelier');
      if (!models) headers.set('accept', 'text/event-stream');
      const res = await inner(target, { ...init, headers, ...(body !== undefined ? { body } : {}) });
      auth.observe(res.headers);
      return res;
    };

    const first = await send(false);
    if (first.status !== 401) return first;
    // The token may have been revoked or rotated under us: once more with a fresh one.
    void first.body?.cancel().catch(() => undefined);
    return send(true);
  };
}

/** The account's model list: its ids, with what the catalog knows of each and the reasoning levels the account reports. */
export function chatgptModels(instance: ProviderInstance, json: unknown, source: ListedModel['source'] = 'detected'): ListedModel[] {
  const items = arr(rec(json).models).filter(isRecord);
  const visible = items.filter((m) => str(m.slug) && str(m.visibility) === 'list');
  // Without any model marked for listing the account's own marker is of no use: show what is named.
  const chosen = (visible.length ? visible : items.filter((m) => str(m.slug))).sort((a, b) => (num(a.priority) ?? 1e6) - (num(b.priority) ?? 1e6));
  return chosen.map((m) => {
    const id = str(m.slug)!;
    const catalog = openaiCatalog(id);
    const levels = arr(m.supported_reasoning_levels)
      .map((l) => (typeof l === 'string' ? l : str(rec(l).effort)))
      .filter((l): l is string => !!l);
    return listedModel(instance, id, {
      displayName: str(m.display_name) ?? catalog?.displayName ?? id,
      contextLength: num(m.context_window) ?? catalog?.contextLength ?? 272_000,
      maxOutput: catalog?.maxOutput ?? 128_000,
      capabilities: catalog?.capabilities ?? { tools: 'native', vision: true, pdf: false, reasoning: levels.length ? 'effort' : 'none', caching: true },
      source: catalog ? 'catalog' : source,
      ...((catalog?.effortLevels ?? levels).length ? { effortLevels: catalog?.effortLevels ?? levels } : {}),
      tier: 'full',
    });
  });
}

export function createChatGptAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const auth = deps.chatgpt;
  if (!auth) {
    // Every backend passes its sign-in (the desktop app's in the browser, a server's with a device code): only an
    // adapter built without one lands here.
    const unavailable = 'This backend has no way to sign in with ChatGPT.';
    return {
      type: instance.type,
      listModels: async () => [],
      health: async () => ({ ok: false, latencyMs: null, warnings: [], error: unavailable }),
      async *stream() {
        yield { type: 'finish', reason: 'error', error: { code: 'provider_auth', message: unavailable, retryable: false } };
      },
    };
  }
  const configured: ProviderInstance = { ...instance, baseUrl: CHATGPT_BASE_URL, apiKey: 'chatgpt-session' };
  const wrapped: AdapterDeps = { ...deps, fetch: codexFetch(deps.fetch, auth) };
  const responses = createOpenAIAdapter(configured, wrapped);

  async function listAccountModels(signal?: AbortSignal): Promise<ListedModel[]> {
    try {
      const json = await requestJson(wrapped, configured, `${CHATGPT_BASE_URL}/models`, { headers: {}, ...(signal ? { signal } : {}) });
      const listed = chatgptModels(configured, json);
      if (listed.length) return listed;
    } catch (e) {
      // Not signed in is the person's to fix; anything else (the list moved, offline) leaves what the plan is known to carry.
      if (e instanceof ChatGptSignedOut) return [];
      if (e instanceof ProviderHttpError && e.error.code === 'provider_auth') return [];
    }
    return chatgptModels(configured, { models: FALLBACK_MODELS.map((slug) => ({ slug, visibility: 'list' })) }, 'default');
  }

  return {
    ...responses,
    type: instance.type,
    listModels: listAccountModels,
    async health(signal): Promise<HealthResult> {
      const started = Date.now();
      try {
        await auth!.credentials();
      } catch (e) {
        return { ok: false, latencyMs: null, warnings: [], error: e instanceof Error ? e.message : 'Not signed in.' };
      }
      const models = await listAccountModels(signal);
      const warnings = models.every((m) => m.source === 'default') ? ["The account's model list could not be read, so the models shown are the usual ones."] : [];
      return { ok: true, latencyMs: Date.now() - started, warnings };
    },
  };
}

