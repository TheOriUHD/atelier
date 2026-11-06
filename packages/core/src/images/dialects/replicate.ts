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
import { replicateVideoCapabilities, replicateVideoInput, replicateVideoSchema, modelDescription, type ReplicateVideoSchema } from './replicate-video.ts';
import { audioBody, audioCapabilities, audioKinds, readAudioInputs, type AudioInputSchema } from './audio-schema.ts';
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

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, pollMs: number, payload: Record<string, unknown>): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/v1/predictions`, {
    method: 'POST',
    headers: { ...headers(instance), prefer: `wait=${WAIT_SECONDS}`, 'cancel-after': CANCEL_AFTER },
    body: JSON.stringify({ version: request.model, input: payload }),
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
        // A model that makes video answers with one address; more than one would be extra files, and one clip is what was asked for.
        if (request.video) {
          const clip = links[0];
          yield clip ? { type: 'video', url: clip } : noImage(instance, 'its answer had no video');
          if (clip) yield { type: 'finish', reason: 'done' };
          return;
        }
        // The same for a sound: one file.
        if (request.audio) {
          const sound = links[0];
          yield sound ? { type: 'audio', url: sound } : noImage(instance, 'its answer had no sound');
          if (sound) yield { type: 'finish', reason: 'done' };
          return;
        }
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

/** Video models are listed up to this many, each needing a look at its schema. */
const VIDEO_COLLECTIONS = ['text-to-video', 'image-to-video'];
const VIDEO_LIMIT = 24;
const VIDEO_CONCURRENCY = 6;
/** A clip takes minutes. */
const VIDEO_POLL_MS = 3_000;
/** Sound models are listed from these collections, read the same way. */
const AUDIO_COLLECTIONS = ['text-to-speech', 'ai-music-generation'];

/** A sound model's input schema out of a model answer. */
function replicateAudioSchema(model: unknown): AudioInputSchema | null {
  const all = rec(rec(rec(rec(rec(model).latest_version).openapi_schema).components).schemas);
  return readAudioInputs(rec(all.Input), all);
}

export function createReplicate(instance: ImageInstance, deps: ImageAdapterDeps, options: { pollMs?: number } = {}): ImageAdapter {
  const pollMs = options.pollMs ?? POLL_MS;
  const videoPollMs = options.pollMs ?? VIDEO_POLL_MS;
  const forVideo = instance.preset === 'replicate-video';
  const forAudio = instance.preset === 'replicate-audio';
  const audioSchemas = new Map<string, AudioInputSchema>();
  const audioModel = async (id: string, source: ListedImageModel['source'], collection: string | undefined, signal?: AbortSignal): Promise<ListedImageModel> => {
    const model = await requestJson(deps, instance, `${instance.baseUrl}/v1/models/${id.split(':')[0]!.split('/').map(encodeURIComponent).join('/')}`, { headers: headers(instance), ...(signal ? { signal } : {}) }).catch(() => null);
    const schema = replicateAudioSchema(model) ?? { fields: {}, required: [] };
    audioSchemas.set(id, schema);
    const description = modelDescription(model);
    const kinds = audioKinds(schema, { category: collection === 'text-to-speech' ? 'text-to-speech' : undefined, id });
    return listedModel(instance, id, audioCapabilities(schema, kinds, 'replicate-audio'), source, description ? { description } : {});
  };
  const audioModels = async (signal?: AbortSignal): Promise<ListedImageModel[]> => {
    const seen = new Set(instance.models);
    const found = await Promise.all(AUDIO_COLLECTIONS.map(async (slug) => ({ slug, body: await requestJson(deps, instance, `${instance.baseUrl}/v1/collections/${slug}`, { headers: headers(instance), ...(signal ? { signal } : {}) }).catch(() => null) })));
    const ids = new Map<string, string>();
    for (const { slug, body } of found) for (const m of arr(rec(body).models).filter(isRecord)) if (str(m.owner) && str(m.name) && !seen.has(`${str(m.owner)}/${str(m.name)}`)) ids.set(`${str(m.owner)}/${str(m.name)}`, slug);
    const queue = [...instance.models.map((id) => [id, 'default', undefined] as const), ...[...ids].slice(0, VIDEO_LIMIT).map(([id, slug]) => [id, 'detected', slug] as const)];
    const listed: ListedImageModel[] = [];
    for (let at = 0; at < queue.length; at += VIDEO_CONCURRENCY) listed.push(...(await Promise.all(queue.slice(at, at + VIDEO_CONCURRENCY).map(([id, source, slug]) => audioModel(id, source, slug, signal)))));
    return listed;
  };
  const schemas = new Map<string, ReplicateVideoSchema>();
  /** A model's schema, from its own page of the API (it takes the key). */
  const schemaOf = async (id: string, signal?: AbortSignal): Promise<{ schema: ReplicateVideoSchema | null; model: unknown }> => {
    const model = await requestJson(deps, instance, `${instance.baseUrl}/v1/models/${id.split(':')[0]!.split('/').map(encodeURIComponent).join('/')}`, { headers: headers(instance), ...(signal ? { signal } : {}) }).catch(() => null);
    const schema = replicateVideoSchema(model);
    if (schema) schemas.set(id, schema);
    return { schema, model };
  };
  const videoModel = async (id: string, source: ListedImageModel['source'], signal?: AbortSignal): Promise<ListedImageModel> => {
    const { schema, model } = await schemaOf(id, signal);
    const description = modelDescription(model);
    return listedModel(instance, id, replicateVideoCapabilities(schema ?? { fields: {}, required: [] }), source, description ? { description } : {});
  };
  const videoModels = async (signal?: AbortSignal): Promise<ListedImageModel[]> => {
    const seen = new Set(instance.models);
    const found = await Promise.all(VIDEO_COLLECTIONS.map((slug) => requestJson(deps, instance, `${instance.baseUrl}/v1/collections/${slug}`, { headers: headers(instance), ...(signal ? { signal } : {}) }).catch(() => null)));
    const ids = [...new Set(found.flatMap((collection) => arr(rec(collection).models).filter(isRecord).flatMap((m) => (str(m.owner) && str(m.name) ? [`${str(m.owner)}/${str(m.name)}`] : []))))].filter((id) => !seen.has(id)).slice(0, VIDEO_LIMIT);
    const queue = [...instance.models.map((id) => [id, 'default'] as const), ...ids.map((id) => [id, 'detected'] as const)];
    const listed: ListedImageModel[] = [];
    // A few at a time: each is a call to Replicate, and the list is refreshed while a person waits.
    for (let at = 0; at < queue.length; at += VIDEO_CONCURRENCY) listed.push(...(await Promise.all(queue.slice(at, at + VIDEO_CONCURRENCY).map(([id, source]) => videoModel(id, source, signal)))));
    return listed;
  };
  const listed = (id: string, source: ListedImageModel['source'], description?: string) => listedModel(instance, id, lookUp(REPLICATE_MODELS, id, ASPECT_DEFAULTS), source, description ? { description } : {});
  return {
    type: 'replicate',
    async listModels(signal) {
      if (forVideo) return videoModels(signal);
      if (forAudio) return audioModels(signal);
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
      return guardImages(request, instance, async function* () {
        let payload: Record<string, unknown>;
        if (request.audio) {
          if (!audioSchemas.has(request.model)) await audioModel(request.model, 'default', undefined, request.signal);
          payload = audioBody(audioSchemas.get(request.model) ?? { fields: {}, required: [] }, request);
        } else if (request.video) {
          const schema = schemas.get(request.model) ?? (await schemaOf(request.model, request.signal)).schema ?? { fields: {}, required: [] };
          payload = replicateVideoInput(schema, request);
        } else payload = input(request);
        yield* run(instance, deps, request, request.video ? videoPollMs : pollMs, payload);
      });
    },
  };
}
