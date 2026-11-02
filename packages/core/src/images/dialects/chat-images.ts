/**
 * OpenRouter. Its current guide documents `POST /api/v1/images`, which takes every model in `GET /api/v1/images/models`
 * and reports each call's cost. `/api/v1/chat/completions` with `modalities` still works, and some models (those listed
 * only by `GET /api/v1/models?output_modalities=image`) generate nowhere else, so those go there.
 *
 * Read on 2026-11-02: https://openrouter.ai/docs/guides/overview/multimodal/image-generation,
 * https://openrouter.ai/docs/api/api-reference/images/generate-an-image, https://openrouter.ai/docs/api/api-reference/models/get-models,
 * https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion,
 * https://openrouter.ai/blog/tutorials/image-generation-models/, https://openrouter.ai/docs/api/reference/errors-and-debugging
 */
import type { ImageCapabilities } from '@atelier/protocol';
import { bearer, jsonHeaders, probe, requestJson } from '../../providers/http.ts';
import { OPENROUTER_ATTRIBUTION } from '../../providers/openai-compatible.ts';
import { apiUrl, arr, dataUrl, isRecord, num, rec, str, strings } from '../../providers/util.ts';
import { ASPECT_DEFAULTS, HOSTED_DEFAULTS } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { bytesOfDataUrl, failureOf, imageStream, listedModel, noImage, refusal, usageEvent } from './hosted.ts';

/** Marks a model that generates only through chat completions. */
const CHAT_ONLY = 'chat-completions';
/** Vector models answer in SVG, which Atelier won't show. */
const NOT_SHOWN = /vector/i;
/** A model that can show its work in chat replies, but takes no more than a few pictures that way. */
const CHAT_REFERENCES = 4;

const headers = (instance: ImageInstance): Record<string, string> => ({ ...OPENROUTER_ATTRIBUTION, ...jsonHeaders(instance, bearer(instance)) });

/** Sizes as OpenRouter describes a model. 4K is left out for the reason `catalog.ts` gives for Gemini. */
function capabilitiesOf(model: Record<string, unknown>): ImageCapabilities {
  const params = rec(model.supported_parameters);
  const ratios = strings(rec(params.aspect_ratio).values).filter((r) => r !== 'auto');
  const classes = strings(rec(params.resolution).values).filter((r) => !/^4k$/i.test(r));
  const references = num(rec(params.input_references).max) ?? 0;
  return {
    ...HOSTED_DEFAULTS,
    ...(ratios.length ? { sizes: { kind: 'aspect' as const, ratios, classes } } : {}),
    maxCount: Math.max(1, num(rec(params.n).max) ?? 1),
    edit: references > 0,
    maxReferences: references,
    transparent: strings(rec(params.background).values).includes('transparent'),
    seed: 'seed' in params,
    previews: model.supports_streaming === true,
  };
}

function chatOnlyCapabilities(model: Record<string, unknown>): ImageCapabilities {
  const seesImages = strings(rec(model.architecture).input_modalities).includes('image');
  return { ...ASPECT_DEFAULTS, family: CHAT_ONLY, edit: seesImages, maxReferences: seesImages ? CHAT_REFERENCES : 0 };
}

const inputImage = (image: ImageRequest['references'][number]) => ({ type: 'image_url', image_url: { url: dataUrl(image.mime, image.bytes) } });

function imagesBody(request: ImageRequest, stream: boolean): Record<string, unknown> {
  return {
    model: request.model,
    prompt: request.prompt,
    ...(request.count > 1 ? { n: request.count } : {}),
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
    ...(request.sizeClass ? { resolution: request.sizeClass } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.transparent ? { background: 'transparent', output_format: 'png' } : {}),
    ...(request.references.length ? { input_references: request.references.map(inputImage) } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

async function* throughImages(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  // Asking for a stream with n > 1 is a 400.
  const stream = request.capabilities.previews && request.count === 1;
  const res = await deps.fetch(apiUrl(instance.baseUrl, '/v1/images'), { method: 'POST', headers: headers(instance), body: JSON.stringify(imagesBody(request, stream)), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  if (stream) {
    yield* imageStream(instance, res, request.signal);
    return;
  }
  const answer = rec(await res.json());
  let images = 0;
  for (const item of arr(answer.data).filter(isRecord)) {
    const b64 = str(item.b64_json);
    if (!b64) continue;
    images++;
    yield { type: 'image', bytes: Buffer.from(b64, 'base64') };
  }
  const usage = usageEvent(answer.usage);
  if (usage) yield usage;
  yield images > 0 ? { type: 'finish', reason: 'done' } : noImage(instance);
}

async function* throughChat(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const body = {
    model: request.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }, ...request.references.map(inputImage)] }],
    modalities: ['image', 'text'],
    ...(request.aspectRatio ? { image_config: { aspect_ratio: request.aspectRatio } } : {}),
    stream: false,
  };
  const res = await deps.fetch(apiUrl(instance.baseUrl, '/v1/chat/completions'), { method: 'POST', headers: headers(instance), body: JSON.stringify(body), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const answer = rec(await res.json());
  const choice = rec(arr(answer.choices)[0]);
  const message = rec(choice.message);
  let images = 0;
  for (const item of arr(message.images).filter(isRecord)) {
    const url = str(rec(item.image_url).url);
    if (!url) continue;
    const bytes = bytesOfDataUrl(url);
    images++;
    yield bytes ? { type: 'image', bytes } : { type: 'image', url };
  }
  const usage = usageEvent(answer.usage);
  if (usage) yield usage;
  if (images > 0) yield { type: 'finish', reason: 'done' };
  else if (str(choice.finish_reason) === 'content_filter') yield refusal(instance, str(message.content));
  else yield noImage(instance, str(message.content));
}

export function createChatImages(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const list = async (path: string, signal?: AbortSignal) => arr(rec(await requestJson(deps, instance, apiUrl(instance.baseUrl, path), { headers: headers(instance), ...(signal ? { signal } : {}) })).data).filter(isRecord);
  return {
    type: 'chat-images',
    async listModels(signal) {
      const [direct, all] = await Promise.all([list('/v1/images/models', signal), list('/v1/models?output_modalities=image', signal).catch(() => [])]);
      const models = new Map<string, ListedImageModel>();
      const add = (model: Record<string, unknown>, capabilities: (m: Record<string, unknown>) => ImageCapabilities) => {
        const id = str(model.id);
        if (!id || NOT_SHOWN.test(id) || models.has(id)) return;
        const displayName = str(model.name);
        models.set(id, listedModel(instance, id, capabilities(model), 'detected', displayName ? { displayName } : {}));
      };
      for (const model of direct) add(model, capabilitiesOf);
      for (const model of all) add(model, chatOnlyCapabilities);
      const typed = instance.models.filter((id) => !models.has(id)).map((id) => listedModel(instance, id, ASPECT_DEFAULTS, 'default'));
      return [...typed, ...models.values()];
    },
    health(signal) {
      return probe(deps, instance, apiUrl(instance.baseUrl, '/v1/images/models'), headers(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => (request.capabilities.family === CHAT_ONLY ? throughChat(instance, deps, request) : throughImages(instance, deps, request)));
    },
  };
}
