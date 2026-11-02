/**
 * Black Forest Labs: submit, then poll the `polling_url` the answer gives. Result URLs last 10 minutes (an hour on
 * FLUX 3), so they go out as `{ url }` and the service downloads them at once.
 *
 * Read on 2026-11-02: https://docs.bfl.ai/quick_start/generating_images, https://docs.bfl.ai/api-reference/utility/get-result,
 * https://docs.bfl.ai/api-reference/models/generate-or-edit-an-image-with-flux2-%5Bpro%5D,
 * https://docs.bfl.ai/api-reference/models/generate-or-edit-an-image-with-flux2-%5Bflex%5D,
 * https://docs.bfl.ai/flux_3/flux3_image_generate, https://docs.us.bfl.ai/api_integration/errors,
 * https://help.bfl.ai/articles/6944273991-what-are-the-flux-2-technical-specifications
 */
import { num, rec, str, strings, toBase64 } from '../../providers/util.ts';
import { BFL_MODEL_IDS, BFL_MODELS, lookUp } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { assertOwnHost, failure, failureOf, listedModel, noImage, refusal, waitFor } from './hosted.ts';

const POLL_MS = 500;
/** A poll that fails for a moment mustn't lose an image that's already paid for. */
const MAX_POLL_FAILURES = 5;
/** `polling_url` can be a regional host (`api.eu.bfl.ai`), and it's used as given. */
const BFL_HOSTS = /(?:^|\.)bfl\.ai$/;
/** One credit is a cent. */
const USD_PER_CREDIT = 0.01;

const headers = (instance: ImageInstance): Record<string, string> => ({ 'content-type': 'application/json', accept: 'application/json', ...instance.headers, ...(instance.apiKey ? { 'x-key': instance.apiKey } : {}) });

function body(request: ImageRequest): Record<string, unknown> {
  const images = request.references.map((image) => toBase64(image.bytes));
  // FLUX 3 refuses unknown fields, including FLUX.2's `seed` and `input_image`.
  if (request.capabilities.family === 'flux3') {
    return { prompt: request.prompt, ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}), ...(request.sizeClass ? { resolution: request.sizeClass } : {}), ...(images.length ? { images } : {}) };
  }
  return {
    prompt: request.prompt,
    ...(request.width && request.height ? { width: request.width, height: request.height } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.tuning.steps !== undefined ? { steps: request.tuning.steps } : {}),
    ...(request.tuning.guidance !== undefined ? { guidance: request.tuning.guidance } : {}),
    output_format: 'png',
    ...Object.fromEntries(images.map((image, i) => [i === 0 ? 'input_image' : `input_image_${i + 1}`, image])),
  };
}

const moderationReasons = (answer: Record<string, unknown>) => strings(rec(answer.details)['Moderation Reasons']).join(', ') || undefined;

async function* poll(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, url: string, pollMs: number): AsyncGenerator<ImageEvent> {
  let failures = 0;
  for (;;) {
    await waitFor(pollMs, request.signal);
    const res = await deps.fetch(url, { method: 'GET', headers: headers(instance), signal: request.signal });
    // A 503 can carry a failed task as JSON, so the body speaks first.
    const answer = rec(await res.clone().json().catch(() => null));
    const status = str(answer.status);
    if (!status) {
      if (res.ok || !(res.status === 429 || res.status >= 500)) {
        yield res.ok ? noImage(instance, 'its answer had no status') : await failureOf(instance, res);
        return;
      }
      if (++failures > MAX_POLL_FAILURES) {
        yield await failureOf(instance, res);
        return;
      }
      continue;
    }
    failures = 0;
    switch (status) {
      case 'Ready': {
        const result = rec(answer.result);
        const sample = str(result.sample);
        if (!sample) {
          yield noImage(instance);
          return;
        }
        const seed = num(result.seed);
        const prompt = str(result.prompt);
        yield { type: 'image', url: sample, ...(seed !== undefined ? { seed } : {}), ...(prompt && prompt !== request.prompt ? { revisedPrompt: prompt } : {}) };
        yield { type: 'finish', reason: 'done' };
        return;
      }
      case 'Request Moderated':
      case 'Content Moderated':
        yield refusal(instance, moderationReasons(answer));
        return;
      case 'Task not found':
        // Unknown or expired, which a new request can get past.
        yield failure({ code: 'provider_error', message: `${instance.name} lost the task.`, retryable: true });
        return;
      case 'Error':
      case 'No Card Generated':
        yield noImage(instance, str(answer.error) ?? str(rec(answer.details).error) ?? status);
        return;
      default: {
        const progress = num(answer.progress);
        yield { type: 'progress', ...(progress !== undefined && progress >= 0 && progress <= 1 ? { fraction: progress } : {}) };
      }
    }
  }
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, pollMs: number): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/v1/${encodeURIComponent(request.model)}`, { method: 'POST', headers: headers(instance), body: JSON.stringify(body(request)), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const submitted = rec(await res.json());
  const pollingUrl = str(submitted.polling_url);
  if (!pollingUrl) {
    yield noImage(instance, 'its answer had no polling address');
    return;
  }
  const credits = num(submitted.cost);
  if (credits !== undefined) yield { type: 'usage', costUsd: credits * USD_PER_CREDIT };
  yield { type: 'loading' };
  yield* poll(instance, deps, request, assertOwnHost(instance, pollingUrl, BFL_HOSTS), pollMs);
}

export function createBfl(instance: ImageInstance, deps: ImageAdapterDeps, options: { pollMs?: number } = {}): ImageAdapter {
  const pollMs = options.pollMs ?? POLL_MS;
  const ids = [...new Set([...BFL_MODEL_IDS, ...instance.models])];
  return {
    type: 'bfl',
    listModels: () => Promise.resolve(ids.map((id) => listedModel(instance, id, lookUp(BFL_MODELS, id), instance.models.includes(id) ? 'default' : 'catalog'))),
    // No route says whether a key works without spending credits on it, so the first image does.
    health: () => Promise.resolve({ ok: !!instance.apiKey, latencyMs: null, warnings: [], ...(instance.apiKey ? {} : { error: 'This needs an API key.' }) }),
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request, pollMs));
    },
  };
}
