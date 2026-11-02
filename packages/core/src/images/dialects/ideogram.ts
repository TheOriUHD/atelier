/**
 * Ideogram's v2 API, `POST /v2/image/{action}/{model}`, which replaced the v1 routes; the v1 pages now say "legacy".
 * Ideogram 4.5 is multipart, 4 is JSON, 3 is multipart with other field names, and each edits differently. All answer
 * with a list whose links expire, so the service downloads them at once.
 *
 * Read on 2026-11-02: https://developer.ideogram.ai/ideogram-api/api-overview,
 * https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-4-5.md, .../generate/ideogram-4.md,
 * .../generate/ideogram-3.md, .../precise-edit/ideogram-4-5.md, .../remix/ideogram-4.md, .../remix/ideogram-3.md,
 * .../inpaint/ideogram-3.md
 */
import { arr, isRecord, num, rec, str } from '../../providers/util.ts';
import { IDEOGRAM_MODEL_IDS, IDEOGRAM_MODELS, lookUp } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import { multipart, type MultipartField } from '../multipart.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInput, ImageInstance, ImageRequest } from '../types.ts';
import { failureOf, listedModel, noImage, refusal } from './hosted.ts';

const authorized = (instance: ImageInstance): Record<string, string> => ({ ...instance.headers, ...(instance.apiKey ? { 'api-key': instance.apiKey } : {}) });

const SPEEDS = { draft: 'turbo', standard: 'default', high: 'quality' } as const;

const text = (name: string, value: string | number | undefined): MultipartField[] => (value === undefined ? [] : [{ name, value: String(value) }]);
const file = (name: string, image: ImageInput): MultipartField => ({ name, filename: image.name, mime: image.mime, bytes: image.bytes });
const sizeOf = (r: ImageRequest) => (r.width && r.height ? `${r.width}x${r.height}` : undefined);
const shared = (r: ImageRequest) => [...text('prompt', r.prompt), ...text('seed', r.seed), ...text('num_images', r.count > 1 ? r.count : undefined)];

/** Ideogram 4.5: `generate`, or `precise-edit` for anything with an input. */
function latest(r: ImageRequest): { path: string; form: MultipartField[] } {
  // There's no quality below medium without an input image, and `high` is its default.
  const quality = text('quality', r.quality === 'draft' ? 'medium' : r.quality === 'high' ? 'high' : undefined);
  const [input, ...guides] = r.references;
  if (!input) return { path: `generate/${r.model}`, form: [...shared(r), ...quality, ...text('size', sizeOf(r)), ...text('background', r.transparent ? 'transparent' : undefined)] };
  return { path: `precise-edit/${r.model}`, form: [...shared(r), ...quality, file('image', input), ...guides.map((g) => file('reference_images', g)), ...(r.mask ? [file('mask', r.mask)] : [])] };
}

/** Ideogram 3: `generate`, `remix` for an input image, `inpaint` with a mask. Its rendering speeds aren't documented for v2, so they're left to its default. */
function third(r: ImageRequest): { path: string; form: MultipartField[] } {
  const input = r.references[0];
  if (input && r.mask) return { path: `inpaint/${r.model}`, form: [...shared(r), file('image', input), file('mask', r.mask)] };
  const shape = [...text('aspect_ratio', r.aspectRatio), ...text('negative_prompt', r.negativePrompt)];
  if (input) return { path: `remix/${r.model}`, form: [...shared(r), ...shape, file('image', input)] };
  return { path: `generate/${r.model}`, form: [...shared(r), ...shape] };
}

function send(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): Promise<Response> {
  const url = (path: string) => `${instance.baseUrl}/v2/image/${path}`;
  const input = request.references[0];
  // Ideogram 4 alone generates from JSON; its remix takes a file like the others.
  if (request.model === 'ideogram-4' && !input) {
    const body = { prompt: request.prompt, rendering_speed: SPEEDS[request.quality], ...(sizeOf(request) ? { resolution: sizeOf(request) } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}), ...(request.count > 1 ? { num_images: request.count } : {}) };
    return deps.fetch(url('generate/ideogram-4'), { method: 'POST', headers: { ...authorized(instance), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.signal });
  }
  const { path, form } = request.model === 'ideogram-4'
    ? { path: 'remix/ideogram-4', form: [...shared(request), ...text('rendering_speed', SPEEDS[request.quality]), ...text('resolution', sizeOf(request)), file('image', input!)] }
    : request.model.startsWith('ideogram-3')
      ? third(request)
      : latest(request);
  const { body, contentType } = multipart(form);
  return deps.fetch(url(path), { method: 'POST', headers: { ...authorized(instance), 'content-type': contentType }, body, signal: request.signal });
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const res = await send(instance, deps, request);
  if (!res.ok) {
    // A 422 here only ever means the safety check, even when its body doesn't say so.
    yield await failureOf(instance, res, (status) => status === 422);
    return;
  }
  const items = arr(rec(await res.json()).data).filter(isRecord);
  let images = 0;
  for (const item of items) {
    const url = str(item.url);
    if (item.is_image_safe === false || !url) continue;
    images++;
    const seed = num(item.seed);
    const prompt = str(item.prompt);
    yield { type: 'image', url, ...(seed !== undefined ? { seed } : {}), ...(prompt && prompt !== request.prompt ? { revisedPrompt: prompt } : {}) };
  }
  if (images > 0) yield { type: 'finish', reason: 'done' };
  else if (items.some((item) => item.is_image_safe === false)) yield refusal(instance);
  else yield noImage(instance);
}

export function createIdeogram(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const ids = [...new Set([...IDEOGRAM_MODEL_IDS, ...instance.models])];
  return {
    type: 'ideogram',
    listModels: () => Promise.resolve(ids.map((id) => listedModel(instance, id, lookUp(IDEOGRAM_MODELS, id), instance.models.includes(id) ? 'default' : 'catalog'))),
    // No route tells whether a key works without generating; a bad key fails the first image plainly.
    health: () => Promise.resolve({ ok: !!instance.apiKey, latencyMs: null, warnings: [], ...(instance.apiKey ? {} : { error: 'This needs an API key.' }) }),
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request));
    },
  };
}
