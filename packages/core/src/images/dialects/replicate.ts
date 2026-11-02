/**
 * Replicate: `POST /v1/predictions`, waiting with `Prefer: wait`, then polling `urls.get`. The `version` field takes
 * `owner/name` or `owner/name:version`, so one route covers official and community models.
 *
 * Read on 2026-11-02: https://replicate.com/docs/topics/predictions/create-a-prediction, https://replicate.com/docs/reference/http,
 * https://replicate.com/docs/reference/error-codes
 */
import { probe, requestJson } from '../../providers/http.ts';
import { arr, isRecord, rec, str } from '../../providers/util.ts';
import { ASPECT_DEFAULTS, lookUp, REPLICATE_MODELS } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { assertOwnHost, failure, failureOf, listedModel, noImage, refusal, soundsRefused, waitFor } from './hosted.ts';

const POLL_MS = 1_500;
const MAX_POLL_FAILURES = 5;
const CANCEL_TIMEOUT_MS = 5_000;
/** Replicate waits at most this long, in seconds. */
const WAIT_SECONDS = 60;
/** A prediction left behind by a dropped connection stops by itself. */
const CANCEL_AFTER = '30m';
const COLLECTION = 'text-to-image';
const REPLICATE_HOSTS = /(?:^|\.)replicate\.com$/;

const headers = (instance: ImageInstance): Record<string, string> => ({ 'content-type': 'application/json', ...instance.headers, ...(instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {}) });

function input(request: ImageRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
    ...(request.count > 1 ? { num_outputs: request.count } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
    output_format: 'png',
  };
}

/** `output` is a URL, a list of URLs, or a list of objects holding one, depending on the model. */
function outputUrls(output: unknown): string[] {
  const items = Array.isArray(output) ? output : [output];
  return items.flatMap((item) => str(item) ?? str(rec(item).url) ?? []);
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, pollMs: number): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/v1/predictions`, {
    method: 'POST',
    headers: { ...headers(instance), prefer: `wait=${WAIT_SECONDS}`, 'cancel-after': CANCEL_AFTER },
    body: JSON.stringify({ version: request.model, input: input(request) }),
    signal: request.signal,
  });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  let prediction = rec(await res.json());
  const urls = rec(prediction.urls);
  const getUrl = str(urls.get) ?? str(res.headers.get('location'));
  const cancelUrl = str(urls.cancel);
  if (getUrl) assertOwnHost(instance, getUrl, REPLICATE_HOSTS);
  if (cancelUrl) assertOwnHost(instance, cancelUrl, REPLICATE_HOSTS);
  const cancel = () => deps.fetch(cancelUrl!, { method: 'POST', headers: headers(instance), signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) }).catch(() => undefined);
  try {
    let failures = 0;
    for (;;) {
      const status = str(prediction.status);
      if (status === 'succeeded') {
        const links = outputUrls(prediction.output);
        for (const url of links) yield { type: 'image', url };
        yield links.length ? { type: 'finish', reason: 'done' } : noImage(instance);
        return;
      }
      if (status === 'failed' || status === 'canceled' || status === 'aborted') {
        const message = str(prediction.error) ?? status;
        yield soundsRefused(message) ? refusal(instance, message) : failure({ code: 'provider_error', message: `${instance.name}: ${message}`, retryable: /E1000|E6716|E8765|E8367/.test(message) });
        return;
      }
      if (status === 'processing') yield { type: 'progress' };
      else yield { type: 'loading' };
      if (!getUrl) {
        yield noImage(instance, 'its answer had no address to follow');
        return;
      }
      await waitFor(pollMs, request.signal);
      const next = await deps.fetch(getUrl, { method: 'GET', headers: headers(instance), signal: request.signal });
      if (next.ok) {
        failures = 0;
        prediction = rec(await next.json());
      } else if (!(next.status === 429 || next.status >= 500) || ++failures > MAX_POLL_FAILURES) {
        yield await failureOf(instance, next);
        return;
      }
    }
  } catch (error) {
    if (request.signal.aborted && cancelUrl) await cancel();
    throw error;
  }
}

export function createReplicate(instance: ImageInstance, deps: ImageAdapterDeps, options: { pollMs?: number } = {}): ImageAdapter {
  const pollMs = options.pollMs ?? POLL_MS;
  const listed = (id: string, source: ListedImageModel['source'], description?: string) => listedModel(instance, id, lookUp(REPLICATE_MODELS, id, ASPECT_DEFAULTS), source, description ? { description } : {});
  return {
    type: 'replicate',
    async listModels(signal) {
      const typed = instance.models.map((id) => listed(id, 'default'));
      const collection = await requestJson(deps, instance, `${instance.baseUrl}/v1/collections/${COLLECTION}`, { headers: headers(instance), ...(signal ? { signal } : {}) }).catch(() => null);
      const seen = new Set(instance.models);
      const found = arr(rec(collection).models).filter(isRecord).flatMap((model) => {
        const owner = str(model.owner);
        const name = str(model.name);
        const id = owner && name ? `${owner}/${name}` : undefined;
        return id && !seen.has(id) ? [listed(id, 'detected', str(model.description)?.slice(0, 200))] : [];
      });
      return [...typed, ...found];
    },
    health(signal) {
      return probe(deps, instance, `${instance.baseUrl}/v1/account`, headers(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request, pollMs));
    },
  };
}
