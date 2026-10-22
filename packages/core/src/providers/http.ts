/**
 * HTTP plumbing shared by the adapters: headers, error mapping to `MessageError`, the stream guard that turns
 * exceptions and aborts into a single `finish`, and the timed health probe.
 * Error messages never include API keys or configured header values.
 */
import type { MessageError } from '@atelier/protocol';
import type { AdapterDeps, ChatRequest, HealthResult, ProviderInstance, StreamEvent } from './types.ts';
import { isRecord, rec, str } from './util.ts';

const PROVIDERS_FIX = 'settings/providers';
const MODELS_FIX = 'settings/models';

export function jsonHeaders(instance: ProviderInstance, auth: Record<string, string>): Record<string, string> {
  return { 'content-type': 'application/json', ...instance.headers, ...auth };
}

export function bearer(instance: ProviderInstance): Record<string, string> {
  return instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {};
}

/** Remove secrets (API key, custom header values) from text that may echo them back. */
export function redact(text: string, instance: ProviderInstance): string {
  const secrets = [instance.apiKey, ...Object.values(instance.headers)].filter(
    (s): s is string => typeof s === 'string' && s.length >= 8,
  );
  return secrets.reduce((acc, secret) => acc.split(secret).join('***'), text);
}

/** Pull a human-readable message out of the usual error body shapes (OpenAI, Anthropic, Ollama, FastAPI). */
export function extractErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return '';
  try {
    const json: unknown = JSON.parse(trimmed);
    if (isRecord(json)) {
      const error = json.error;
      const fromError = str(error) ?? str(rec(error).message);
      const message = fromError ?? str(json.message) ?? str(json.detail);
      if (message) return message;
    }
  } catch {
    // not JSON
  }
  if (trimmed.startsWith('<')) return '';
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** Anthropic, OpenAI, vLLM/OpenRouter/Mistral, llama.cpp, Ollama, LM Studio, Gemini and Groq phrasings of "the request is too long". */
const CONTEXT_OVERFLOW =
  /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceed(?:s|ed)? (?:the )?(?:available )?context|context window|too many tokens|greater than the context length|exceeds? the maximum number of tokens|reduce the length of the messages/i;

/**
 * The server generated a reply but couldn't parse it in the model's own format (a malformed tool call or channel
 * header): llama.cpp's "does not match the expected … format", Ollama's "error parsing tool call", vLLM's "failed
 * to parse". A sampling accident rather than an outage, so asking again usually works.
 */
const MODEL_OUTPUT_INVALID =
  /does not match the expected [\w-]+ format|error parsing tool call|failed to parse (?:the )?(?:tool call|model output|input at pos)|unparsed [\w-]+ output/i;

/** Classify a provider failure from its HTTP status (if any) and the provider's own error type/message. */
export function classifyError(
  instance: ProviderInstance,
  status: number | null,
  kind: string,
  message: string,
): MessageError {
  const detail = redact(message, instance);
  const suffix = detail ? `: ${detail}` : '';
  const statusText = status === null ? '' : ` (${status})`;
  const haystack = `${kind} ${message}`;

  if (/insufficient_quota|usage_limit_reached|usage_not_included|billing_hard_limit|rate_limit_exceeded.*(?:week|plan|subscription)|credit balance|quota.{0,30}(?:exceeded|exhausted)|(?:weekly|subscription|usage|spending|billing).{0,40}(?:limit|exhausted)|payment required/i.test(haystack) || status === 402) {
    return { code: 'provider_quota', message: `${instance.name} usage limit reached${suffix}`, retryable: false };
  }
  if (status === 401 || status === 403 || /authentication|permission|unauthori[sz]ed|invalid.*api.key/i.test(kind)) {
    return {
      code: 'provider_auth',
      message: `${instance.name} rejected the credentials${statusText}${suffix}`,
      fix: PROVIDERS_FIX,
      retryable: false,
    };
  }
  if (status === 404 || (status === null && /not_found/i.test(kind))) {
    if (/model/i.test(haystack) || status === null) {
      return { code: 'model_not_found', message: `Model not found${suffix}`, fix: MODELS_FIX, retryable: false };
    }
    return {
      code: 'provider_error',
      message: `${instance.name} endpoint not found (404) — check the base URL${suffix}`,
      fix: PROVIDERS_FIX,
      retryable: false,
    };
  }
  // Some servers answer an over-long prompt with a 5xx; a 429 about tokens is a rate limit, though.
  if (status !== 429 && CONTEXT_OVERFLOW.test(haystack)) {
    return {
      code: 'context_overflow',
      message: `The conversation is too long for this model${suffix}`,
      retryable: false,
    };
  }
  if ((status === null || status >= 500) && MODEL_OUTPUT_INVALID.test(haystack)) {
    return {
      code: 'model_output_invalid',
      message: `The model's reply didn't follow its own format, so ${instance.name} couldn't read it${statusText}${suffix}`,
      retryable: true,
    };
  }
  const busyStatus = status === 408 || status === 429 || (status !== null && status >= 500);
  const busyKind =
    status === null && /overloaded|rate.?limit|server_error|api_error|timeout|unavailable/i.test(haystack);
  if (busyStatus || busyKind) {
    return {
      code: 'provider_busy',
      message: `${instance.name} is busy or unavailable${statusText}${suffix}`,
      retryable: true,
    };
  }
  return {
    code: 'provider_error',
    message: `${instance.name} request failed${statusText}${suffix}`,
    // Untyped streamed errors are often transient service failures, not configuration problems.
    retryable: status === null && /^(?:error)?$/i.test(kind),
  };
}

export async function httpError(res: Response, instance: ProviderInstance): Promise<MessageError> {
  const body = await res.text().catch(() => '');
  let kind = '';
  try {
    const json: unknown = JSON.parse(body);
    kind = str(rec(rec(json).error).type) ?? str(rec(rec(json).error).code) ?? '';
  } catch {
    // not JSON
  }
  return classifyError(instance, res.status, kind, extractErrorMessage(body) || res.statusText);
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error || err instanceof DOMException) && (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

function hostOf(instance: ProviderInstance): string {
  try {
    return new URL(instance.baseUrl).host;
  } catch {
    return instance.baseUrl;
  }
}

/** "192.168.1.50:11434": where a base URL points, with the scheme's port when it names none. */
export function hostPort(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return baseUrl;
  }
}

/** A failed fetch found nothing listening at the address (fetch's and plain-http's TypeError with the socket's error as cause). */
export function isConnectionRefused(err: unknown): boolean {
  const cause: unknown = err instanceof Error ? err.cause : undefined;
  if (!isRecord(cause)) return false;
  // Several addresses tried in turn (IPv6 and IPv4) fail together as an AggregateError.
  return cause.code === 'ECONNREFUSED' || (Array.isArray(cause.errors) && cause.errors.some((e) => isRecord(e) && e.code === 'ECONNREFUSED'));
}

/** What a health probe that got no answer within `timeoutMs` says. */
export function noAnswerError(baseUrl: string, timeoutMs: number): string {
  return `No answer from ${hostPort(baseUrl)} within ${Math.round(timeoutMs / 1000)} seconds. Check that the server is running and that this computer can reach it (firewall, address, port).`;
}

/** Map a thrown exception (network failure, bug) to a message error. */
export function exceptionError(err: unknown, instance: ProviderInstance): MessageError {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return {
      code: 'provider_timeout',
      message: `${instance.name} at ${hostOf(instance)} took too long to respond`,
      retryable: true,
    };
  }
  // A plain-HTTP request that received nothing for its idle limit (providers/plain-http.ts).
  if (err instanceof Error && err.name === 'NoResponseError') {
    return {
      code: 'provider_timeout',
      message: `${instance.name} at ${hostOf(instance)} sent nothing for too long (${err.message.toLowerCase()})`,
      retryable: true,
    };
  }
  if (err instanceof TypeError) {
    return {
      code: 'provider_offline',
      message: `Cannot reach ${instance.name} at ${hostOf(instance)}`,
      retryable: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'provider_error', message: redact(message, instance), retryable: false };
}

export class ProviderHttpError extends Error {
  constructor(readonly error: MessageError) {
    super(error.message);
    this.name = 'ProviderHttpError';
  }
}

/** POST a JSON body and return the response, or a ready-made error finish when the request failed. */
export async function postStream(
  deps: AdapterDeps,
  instance: ProviderInstance,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<{ ok: true; body: ReadableStream<Uint8Array> } | { ok: false; error: MessageError; status: number }> {
  const res = await deps.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) return { ok: false, error: await httpError(res, instance), status: res.status };
  if (!res.body)
    return { ok: false, error: classifyError(instance, null, '', 'empty response body'), status: res.status };
  return { ok: true, body: res.body };
}

/** GET/POST returning parsed JSON; non-2xx responses throw `ProviderHttpError`. */
export async function requestJson(
  deps: AdapterDeps,
  instance: ProviderInstance,
  url: string,
  init: { method?: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown; signal?: AbortSignal },
): Promise<unknown> {
  const res = await deps.fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal ?? null,
  });
  if (!res.ok) throw new ProviderHttpError(await httpError(res, instance));
  return (await res.json()) as unknown;
}

/**
 * Run an adapter's event generator so that the consumer always sees exactly one `finish`:
 * aborts become `aborted`, exceptions become a mapped error, and a stream that ends early is reported as truncated.
 */
export async function* guardStream(
  request: ChatRequest,
  instance: ProviderInstance,
  run: () => AsyncGenerator<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  try {
    for await (const event of run()) {
      yield event;
      if (event.type === 'finish') return;
    }
  } catch (err) {
    const timedOut = request.signal.aborted && request.signal.reason instanceof Error && request.signal.reason.name === 'TimeoutError';
    if (request.signal.aborted && !timedOut) {
      yield { type: 'finish', reason: 'aborted' };
    } else {
      yield { type: 'finish', reason: 'error', error: exceptionError(timedOut ? request.signal.reason : err, instance) };
    }
    return;
  }
  if (request.signal.aborted) {
    if (request.signal.reason instanceof Error && request.signal.reason.name === 'TimeoutError') {
      yield { type: 'finish', reason: 'error', error: exceptionError(request.signal.reason, instance) };
    } else {
      yield { type: 'finish', reason: 'aborted' };
    }
    return;
  }
  yield {
    type: 'finish',
    reason: 'error',
    error: {
      code: 'stream_truncated',
      message: `${instance.name} closed the stream before the response finished`,
      retryable: true,
    },
  };
}

/** Time a single probe request and describe the outcome for the Providers page. */
export async function probe(
  deps: AdapterDeps,
  instance: ProviderInstance,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  interpret?: (res: Response, latencyMs: number) => Promise<HealthResult | null>,
): Promise<HealthResult> {
  const started = performance.now();
  let res: Response;
  try {
    res = await deps.fetch(url, { method: 'GET', headers, signal: signal ?? null });
  } catch (err) {
    if (isAbortError(err)) throw err;
    const error = isConnectionRefused(err) ? `Nothing is listening at ${hostPort(instance.baseUrl)}.` : exceptionError(err, instance).message;
    return { ok: false, latencyMs: null, warnings: [], error };
  }
  const latencyMs = Math.round(performance.now() - started);
  const custom = await interpret?.(res, latencyMs);
  if (custom) return custom;
  if (!res.ok) return { ok: false, latencyMs, warnings: [], error: (await httpError(res, instance)).message };
  return { ok: true, latencyMs, warnings: [] };
}
