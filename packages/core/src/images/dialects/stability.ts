/**
 * Stability AI: multipart under `/v2beta/stable-image`. An output its moderation catches comes back blurred, with
 * `finish_reason: CONTENT_FILTERED`, and that is a refusal: the blurred picture is never kept.
 *
 * Read on 2026-11-02: https://docs.stability.ai/api-reference, https://docs.stability.ai/api-reference/generate/stable-image-ultra.md,
 * https://docs.stability.ai/api-reference/generate/stable-image-core.md, https://docs.stability.ai/api-reference/generate/stable-diffusion-35.md,
 * https://docs.stability.ai/api-reference/edit/inpaint.md, https://docs.stability.ai/pricing
 */
import { probe } from '../../providers/http.ts';
import { num, rec, str } from '../../providers/util.ts';
import { lookUp, STABILITY_MODEL_IDS, STABILITY_MODELS } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import { multipart, type MultipartField } from '../multipart.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { failureOf, listedModel, noImage, refusal } from './hosted.ts';
import { stabilityAudio, stabilityAudioModels } from './stability-audio.ts';

/** How far an input image may be changed; Stability has no default for this and the tool has no field for it. */
const IMAGE_STRENGTH = 0.7;

const authorized = (instance: ImageInstance): Record<string, string> => ({ ...instance.headers, ...(instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {}) });

const ROUTES: Record<string, string> = { 'stable-image-ultra': 'generate/ultra', 'stable-image-core': 'generate/core' };

function route(request: ImageRequest): string {
  if (request.mask && request.references.length > 0) return 'edit/inpaint';
  return ROUTES[request.model] ?? 'generate/sd3';
}

function form(request: ImageRequest, path: string): MultipartField[] {
  const input = request.references[0];
  const text = (name: string, value: string | number | undefined): MultipartField[] => (value === undefined ? [] : [{ name, value: String(value) }]);
  const file = (name: string, image: ImageRequest['references'][number]): MultipartField => ({ name, filename: image.name, mime: image.mime, bytes: image.bytes });
  const inpainting = path === 'edit/inpaint';
  const sd3 = path === 'generate/sd3';
  return [
    ...text('prompt', request.prompt),
    ...text('negative_prompt', request.negativePrompt),
    ...text('seed', request.seed),
    ...text('output_format', 'png'),
    ...(sd3 ? text('model', request.model) : []),
    ...(inpainting || !input
      ? text('aspect_ratio', inpainting ? undefined : request.aspectRatio)
      : // An input image sets the shape, and `aspect_ratio` is only valid without one.
        [...(sd3 ? text('mode', 'image-to-image') : []), ...text('strength', IMAGE_STRENGTH), file('image', input)]),
    // White changes, black stays: the internal convention, so the mask goes as it is (images/mask.ts).
    ...(inpainting && input && request.mask ? [file('image', input), file('mask', request.mask)] : []),
  ];
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const path = route(request);
  const { body, contentType } = multipart(form(request, path));
  const res = await deps.fetch(`${instance.baseUrl}/v2beta/stable-image/${path}`, { method: 'POST', headers: { ...authorized(instance), accept: 'application/json', 'content-type': contentType }, body, signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const answer = rec(await res.json());
  if (str(answer.finish_reason) === 'CONTENT_FILTERED') {
    yield refusal(instance);
    return;
  }
  const image = str(answer.image);
  if (!image) {
    yield noImage(instance);
    return;
  }
  const seed = num(answer.seed);
  yield { type: 'image', bytes: Buffer.from(image, 'base64'), ...(seed !== undefined ? { seed } : {}) };
  yield { type: 'finish', reason: 'done' };
}

export function createStability(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const ids = [...new Set([...STABILITY_MODEL_IDS, ...instance.models])];
  // Added for sound, it lists Stable Audio's models and makes music and effects instead of pictures.
  const sound = instance.preset === 'stability-audio';
  return {
    type: 'stability',
    listModels: () => Promise.resolve(sound ? stabilityAudioModels(instance) : ids.map((id) => listedModel(instance, id, lookUp(STABILITY_MODELS, id), instance.models.includes(id) ? 'default' : 'catalog'))),
    health(signal) {
      return probe(deps, instance, `${instance.baseUrl}/v1/user/account`, authorized(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => (request.audio ? stabilityAudio(instance, deps, request) : run(instance, deps, request)));
    },
  };
}
