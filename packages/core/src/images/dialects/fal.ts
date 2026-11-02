/**
 * fal.ai: submit to the queue, poll status, fetch the result, cancel on stop. Polling rather than the status stream,
 * because it needs one code path and a queue position every second is all the card shows.
 *
 * Read on 2026-11-02: https://fal.ai/docs/documentation/model-apis/inference/queue, https://fal.ai/docs/platform-apis/v1/models,
 * https://docs.fal.ai/model-apis/errors, https://fal.ai/docs/documentation/model-apis/request-errors
 */
import { probe, requestJson } from '../../providers/http.ts';
import { arr, dataUrl, isRecord, num, rec, str } from '../../providers/util.ts';
import { FAL_MODELS, lookUp } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { assertOwnHost, bytesOfDataUrl, failure, failureOf, listedModel, noImage, refusal, soundsRefused, waitFor } from './hosted.ts';

const POLL_MS = 1_000;
const MAX_POLL_FAILURES = 5;
const CANCEL_TIMEOUT_MS = 5_000;
const SEARCH_URL = 'https://api.fal.ai/v1/models';
const SEARCH_LIMIT = 40;
/** A status lookup is on `queue.fal.run` whichever regional name the base URL uses. */
const FAL_HOSTS = /(?:^|\.)fal\.(?:run|ai)$/;

const headers = (instance: ImageInstance): Record<string, string> => ({ 'content-type': 'application/json', ...instance.headers, ...(instance.apiKey ? { authorization: `Key ${instance.apiKey}` } : {}) });
const modelPath = (model: string) => model.split('/').map(encodeURIComponent).join('/');

function body(request: ImageRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    ...(request.width && request.height ? { image_size: { width: request.width, height: request.height } } : {}),
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
    ...(request.count > 1 ? { num_images: request.count } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
    ...(request.tuning.steps !== undefined ? { num_inference_steps: request.tuning.steps } : {}),
    ...(request.tuning.guidance !== undefined ? { guidance_scale: request.tuning.guidance } : {}),
    ...(request.references.length ? { image_urls: request.references.map((image) => dataUrl(image.mime, image.bytes)) } : {}),
    output_format: 'png',
  };
}

async function* result(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, url: string): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(url, { method: 'GET', headers: headers(instance), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const answer = rec(await res.json());
  const flagged = arr(answer.has_nsfw_concepts);
  const seed = num(answer.seed);
  const revisedPrompt = str(answer.prompt);
  let images = 0;
  let blocked = false;
  for (const [index, item] of arr(answer.images).filter(isRecord).entries()) {
    // fal blanks an image its checker caught, so it isn't one.
    if (flagged[index] === true) {
      blocked = true;
      continue;
    }
    const link = str(item.url);
    if (!link) continue;
    images++;
    const bytes = bytesOfDataUrl(link);
    const facts = { ...(seed !== undefined ? { seed } : {}), ...(revisedPrompt && revisedPrompt !== request.prompt ? { revisedPrompt } : {}) };
    yield bytes ? { type: 'image', bytes, ...facts } : { type: 'image', url: link, ...facts };
  }
  yield images > 0 ? { type: 'finish', reason: 'done' } : blocked ? refusal(instance) : noImage(instance);
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, pollMs: number): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/${modelPath(request.model)}`, { method: 'POST', headers: headers(instance), body: JSON.stringify(body(request)), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const submitted = rec(await res.json());
  const statusUrl = str(submitted.status_url);
  const responseUrl = str(submitted.response_url);
  const cancelUrl = str(submitted.cancel_url);
  if (!statusUrl || !responseUrl) {
    yield noImage(instance, 'its answer had no queue addresses');
    return;
  }
  // The answer's own URLs, as these use the app's id, not the full model id, and a wrong one is a 405.
  assertOwnHost(instance, statusUrl, FAL_HOSTS);
  assertOwnHost(instance, responseUrl, FAL_HOSTS);
  if (cancelUrl) assertOwnHost(instance, cancelUrl, FAL_HOSTS);

  const cancel = () => deps.fetch(cancelUrl!, { method: 'PUT', headers: headers(instance), signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) }).catch(() => undefined);
  try {
    let failures = 0;
    for (;;) {
      const status = await deps.fetch(statusUrl, { method: 'GET', headers: headers(instance), signal: request.signal });
      if (!status.ok) {
        if (!(status.status === 429 || status.status >= 500) || ++failures > MAX_POLL_FAILURES) {
          yield await failureOf(instance, status);
          return;
        }
      } else {
        failures = 0;
        const answer = rec(await status.json());
        const state = str(answer.status);
        const position = num(answer.queue_position);
        if (state === 'IN_QUEUE') yield position !== undefined ? { type: 'queued', ahead: position } : { type: 'loading' };
        else if (state === 'IN_PROGRESS') yield { type: 'progress' };
        else if (state === 'COMPLETED') {
          const error = str(answer.error);
          if (!error) {
            yield* result(instance, deps, request, responseUrl);
            return;
          }
          const type = str(answer.error_type) ?? '';
          yield soundsRefused(`${type} ${error}`) ? refusal(instance, error) : failure({ code: 'provider_error', message: `${instance.name}: ${error}`, retryable: /timeout|runner|disconnected/i.test(type) });
          return;
        } else {
          yield noImage(instance, 'its status made no sense');
          return;
        }
      }
      await waitFor(pollMs, request.signal);
    }
  } catch (error) {
    if (request.signal.aborted && cancelUrl) await cancel();
    throw error;
  }
}

export function createFal(instance: ImageInstance, deps: ImageAdapterDeps, options: { pollMs?: number } = {}): ImageAdapter {
  const pollMs = options.pollMs ?? POLL_MS;
  const listed = (id: string, source: ListedImageModel['source'], extra: { displayName?: string; description?: string } = {}) => listedModel(instance, id, lookUp(FAL_MODELS, id), source, extra);
  return {
    type: 'fal',
    async listModels(signal) {
      const typed = instance.models.map((id) => listed(id, 'default'));
      // There are over a thousand, so the search's most relevant ones; the rest are typed in.
      const found = await requestJson(deps, instance, `${SEARCH_URL}?category=text-to-image&status=active&limit=${SEARCH_LIMIT}`, { headers: headers(instance), ...(signal ? { signal } : {}) }).catch(() => null);
      const seen = new Set(instance.models);
      const searched = arr(rec(found).models).filter(isRecord).flatMap((model) => {
        const id = str(model.endpoint_id);
        if (!id || seen.has(id)) return [];
        const displayName = str(rec(model.metadata).display_name);
        return [listed(id, 'detected', displayName ? { displayName } : {})];
      });
      return [...typed, ...searched];
    },
    health(signal) {
      return probe(deps, instance, `${SEARCH_URL}?limit=1`, headers(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request, pollMs));
    },
  };
}
