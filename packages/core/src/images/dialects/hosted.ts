/** What the cloud dialects share: reading a failed answer as a refusal or a fault, waiting between polls, the streamed image events. */
import { modelRef, type ImageCapabilities, type MessageError } from '@atelier/protocol';
import { classifyError, extractErrorMessage, httpError, redact } from '../../providers/http.ts';
import { parseSSE } from '../../providers/sse.ts';
import { arr, isRecord, num, rec, str } from '../../providers/util.ts';
import { refusedError } from '../guard.ts';
import type { ImageEvent, ImageInstance, ListedImageModel } from '../types.ts';

export type ImageFinish = Extract<ImageEvent, { type: 'finish' }>;

export const listedModel = (instance: ImageInstance, modelId: string, capabilities: ImageCapabilities, source: ListedImageModel['source'], extra: { displayName?: string; description?: string } = {}): ListedImageModel => ({
  ref: modelRef(instance.id, modelId),
  providerId: instance.id,
  modelId,
  displayName: extra.displayName ?? modelId,
  capabilities,
  source,
  ...(extra.description ? { description: extra.description } : {}),
});

/** How services word a refusal. Only read on 400, 403 and 422, so a rate limit that mentions safety stays a rate limit. */
const REFUSAL = /moderat|safety|content.?(?:policy|filter)|responsible.?ai|prohibited|flagged|blocked|nsfw|sensitive|public.?figure/i;
const REFUSAL_STATUSES = new Set([400, 403, 422]);

export const soundsRefused = (text: string): boolean => REFUSAL.test(text);

/** The sentence inside an error body, including the list shapes Stability, fal and BFL use. */
export function readableError(raw: string): string {
  try {
    const body = rec(JSON.parse(raw));
    const listed = [...arr(body.errors), ...arr(body.detail)].map((e) => str(e) ?? str(rec(e).msg) ?? '').filter(Boolean);
    if (listed.length) return listed.join(' ');
  } catch {
    // not JSON
  }
  return extractErrorMessage(raw);
}

export const refusal = (instance: ImageInstance, detail?: string): ImageFinish => ({ type: 'finish', reason: 'refused', error: refusedError(instance.name, detail ? redact(detail, instance) : undefined) });

export const failure = (error: MessageError): ImageFinish => ({ type: 'finish', reason: 'error', error });

/** The service answered, and there's no image in it. */
export const noImage = (instance: ImageInstance, detail?: string, retryable = false): ImageFinish =>
  failure({ code: 'provider_error', message: `${instance.name} sent no image${detail ? `: ${redact(detail, instance)}` : '.'}`, retryable });

/**
 * A refusal is the provider's answer to the prompt, not a fault: the tool says so, and neither the service nor the model
 * tries again. Everything else keeps `httpError`'s mapping, where rate limits and 5xx stay retryable.
 */
export async function failureOf(instance: ImageInstance, res: Response, refused: (status: number, raw: string) => boolean = (status, raw) => REFUSAL_STATUSES.has(status) && REFUSAL.test(raw)): Promise<ImageFinish> {
  const raw = await res.clone().text().catch(() => '');
  if (refused(res.status, raw)) return refusal(instance, readableError(raw));
  return failure(await httpError(res, instance));
}

/** Waits between polls, ending at once when the request is stopped. */
export const waitFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Stopped.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });

/** A URL a service told us to call back with our key: it must stay on that service's hosts, whatever the answer said. */
export function assertOwnHost(instance: ImageInstance, url: string, hosts?: RegExp): string {
  const target = URL.parse(url);
  const home = URL.parse(instance.baseUrl);
  const encrypted = target?.protocol === 'https:' || target?.origin === home?.origin;
  const own = target?.hostname === home?.hostname || (target && hosts?.test(target.hostname));
  if (!encrypted || !own) throw new Error(`${instance.name} pointed at an address Atelier won't send the key to.`);
  return url;
}

/** `data:image/png;base64,…` as bytes; null for anything else. */
export function bytesOfDataUrl(url: string): Uint8Array | null {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(url);
  return match ? Buffer.from(match[1]!, 'base64') : null;
}

/** What a service said a call used, in any of the shapes it comes in. */
export function usageEvent(value: unknown): Extract<ImageEvent, { type: 'usage' }> | null {
  const usage = rec(value);
  const ticks = num(usage.cost_in_usd_ticks);
  const costUsd = num(usage.cost) ?? (ticks !== undefined ? ticks / 10_000_000_000 : undefined);
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  if (costUsd === undefined && input === undefined && output === undefined) return null;
  return { type: 'usage', ...(costUsd !== undefined ? { costUsd } : {}), ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
}

const REFUSED_CODES = /moderation|content_policy|content_filter|contentfilter/i;

/** An error sent inside a stream that has already started. */
export function streamedError(instance: ImageInstance, data: Record<string, unknown>): ImageFinish {
  const error = isRecord(data.error) ? data.error : data;
  const code = str(error.code) ?? str(error.type) ?? '';
  const message = str(error.message) ?? '';
  if (REFUSED_CODES.test(code) || REFUSAL.test(message)) return refusal(instance, message);
  return failure(classifyError(instance, null, code, message));
}

/** The image events OpenAI streams and OpenRouter copies: `image_generation.*` and `image_edit.*`. */
export async function* imageStream(instance: ImageInstance, res: Response, signal: AbortSignal): AsyncGenerator<ImageEvent> {
  if (!res.body) throw new Error(`${instance.name} sent an empty answer.`);
  let images = 0;
  for await (const event of parseSSE(res.body, signal)) {
    const data = rec(JSON.parse(event.data));
    const type = str(data.type) ?? event.event;
    const b64 = str(data.b64_json);
    if (type === 'error') {
      yield streamedError(instance, data);
      return;
    }
    if (type.endsWith('partial_image') && b64) yield { type: 'preview', mime: `image/${str(data.output_format) ?? 'png'}`, data: b64 };
    else if (type.endsWith('completed') && b64) {
      images++;
      yield { type: 'image', bytes: Buffer.from(b64, 'base64') };
      const usage = usageEvent(data.usage);
      if (usage) yield usage;
    }
  }
  yield images > 0 ? { type: 'finish', reason: 'done' } : failure({ code: 'stream_truncated', message: `${instance.name} closed the stream before the image came.`, retryable: true });
}
