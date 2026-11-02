/**
 * The OpenAI images wire format: `POST /v1/images/generations` and `/v1/images/edits`. OpenAI, and most servers that
 * copy it: stable-diffusion.cpp's sd-server, LocalAI, Together, xAI, Recraft, LiteLLM, Azure (other paths and
 * header). `IMAGE_PROVIDER_PRESETS` says which; services differ in what they accept, not in how they're spoken to.
 *
 * Read on 2026-11-02:
 * - OpenAI: https://developers.openai.com/api/reference/resources/images/methods/generate,
 *   https://developers.openai.com/api/reference/resources/images/methods/edit,
 *   https://developers.openai.com/api/docs/guides/image-generation
 * - Azure: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/dall-e
 * - xAI: https://docs.x.ai/developers/rest-api-reference/inference/images
 * - Together: https://docs.together.ai/reference/post-images-generations
 * - Recraft: https://www.recraft.ai/docs/api-reference/endpoints, https://www.recraft.ai/docs/api-reference/appendix
 */
import { imagePreset, type ImageCapabilities } from '@atelier/protocol';
import { probe, requestJson } from '../../providers/http.ts';
import { arr, dataUrl, isRecord, num, rec, str } from '../../providers/util.ts';
import { GPT_IMAGE_1, HOSTED_DEFAULTS, lookUp, OPENAI_MODELS, RECRAFT_MODEL_IDS, RECRAFT_MODELS, SQUARE, TOGETHER_MODELS, XAI_MODEL_IDS, XAI_MODELS, type ModelTable } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import { multipart, type MultipartField } from '../multipart.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { failureOf, imageStream, listedModel, noImage, refusal, usageEvent } from './hosted.ts';
import { fromImg2Img, localEdit, localFields, localModels, localSeed } from './openai-local.ts';

/** Model ids that aren't for images, for servers whose list holds everything. */
const NOT_IMAGES = /embed|whisper|tts|transcri|moderation|rerank|audio|realtime|video|vision/i;
/** On a hosted service that also lists text models, what an image model looks like. */
const LOOKS_LIKE_IMAGES = /image|flux|stable-?diffusion|sdxl|imagine|recraft/i;

const LOCAL_CAPABILITIES: ImageCapabilities = { ...HOSTED_DEFAULTS, family: 'local', sizes: SQUARE, seed: true };

const TABLES: Record<string, ModelTable> = { xai: XAI_MODELS, together: TOGETHER_MODELS, recraft: RECRAFT_MODELS };
/** Models a service doesn't report, or that should show even when its list can't be read. */
const KNOWN_IDS: Record<string, readonly string[]> = { xai: XAI_MODEL_IDS, recraft: RECRAFT_MODEL_IDS };

function capabilitiesFor(instance: ImageInstance, modelId: string): ImageCapabilities {
  const local = imagePreset(instance.preset)?.group === 'local';
  // Azure names deployments anything, and every image model it still offers is a GPT Image model.
  const base = local ? LOCAL_CAPABILITIES : isAzure(instance) ? { ...HOSTED_DEFAULTS, ...GPT_IMAGE_1 } : HOSTED_DEFAULTS;
  const capabilities = lookUp(TABLES[instance.preset ?? ''] ?? OPENAI_MODELS, modelId, base);
  // Azure shows streaming on its `/openai/v1` route only, and the deployment route is the one its edits use.
  return isAzure(instance) ? { ...capabilities, previews: false } : capabilities;
}

const isAzure = (instance: ImageInstance) => instance.preset === 'azure';
/** Azure's sample says "or later"; this is the one its edits and streaming pages are written against. */
const AZURE_API_VERSION = '2025-04-01-preview';

function headers(instance: ImageInstance, json = true): Record<string, string> {
  const auth: Record<string, string> = !instance.apiKey ? {} : isAzure(instance) ? { 'api-key': instance.apiKey } : { authorization: `Bearer ${instance.apiKey}` };
  return { ...(json ? { 'content-type': 'application/json' } : {}), ...instance.headers, ...auth };
}

function endpoint(instance: ImageInstance, model: string, action: 'generations' | 'edits'): string {
  if (isAzure(instance)) return `${instance.baseUrl}/openai/deployments/${encodeURIComponent(model)}/images/${action}?api-version=${AZURE_API_VERSION}`;
  return `${instance.baseUrl}/v1/images/${action}`;
}

const sizeOf = (r: ImageRequest) => (r.width && r.height ? `${r.width}x${r.height}` : undefined);
const many = (r: ImageRequest) => (r.count > 1 ? { n: r.count } : {});
const asDataUrl = (image: ImageRequest['references'][number]) => dataUrl(image.mime, image.bytes);

/** OpenAI's fields, which the servers that copy it take as well. */
function openAiFields(instance: ImageInstance, request: ImageRequest): Record<string, unknown> {
  const gpt = request.capabilities.family === 'gpt-image';
  const size = sizeOf(request);
  return localFields(instance, request, {
    model: request.model,
    prompt: request.prompt,
    ...many(request),
    ...(size ? { size } : {}),
    ...(gpt ? { quality: request.quality === 'draft' ? 'low' : request.quality === 'high' ? 'high' : 'medium' } : {}),
    ...(gpt && request.transparent ? { background: 'transparent', output_format: 'png' } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    // GPT image models always answer in base64 and refuse the field.
    ...(gpt ? {} : { response_format: 'b64_json' }),
  });
}

/** How a service words the same thing, where that isn't OpenAI's way. */
const FIELDS: Record<string, (request: ImageRequest) => Record<string, unknown>> = {
  xai: (r) => ({
    model: r.model,
    prompt: r.prompt,
    ...many(r),
    ...(r.aspectRatio ? { aspect_ratio: r.aspectRatio } : {}),
    ...(r.sizeClass ? { resolution: r.sizeClass } : {}),
    response_format: 'b64_json',
  }),
  together: (r) => ({
    model: r.model,
    prompt: r.prompt,
    ...many(r),
    ...(r.width && r.height ? { width: r.width, height: r.height } : {}),
    ...(r.negativePrompt ? { negative_prompt: r.negativePrompt } : {}),
    ...(r.seed !== undefined ? { seed: r.seed } : {}),
    ...(r.tuning.steps !== undefined ? { steps: r.tuning.steps } : {}),
    ...(r.tuning.guidance !== undefined ? { guidance_scale: r.tuning.guidance } : {}),
    response_format: 'base64',
    output_format: 'png',
    // FLUX.1 Kontext takes `image_url`, everything else `reference_images`, and never both.
    ...(r.references.length === 0 ? {} : /kontext/i.test(r.model) ? { image_url: asDataUrl(r.references[0]!) } : { reference_images: r.references.map(asDataUrl) }),
  }),
  recraft: (r) => ({
    model: r.model,
    prompt: r.prompt,
    ...many(r),
    ...(r.aspectRatio ? { size: r.aspectRatio } : {}),
    ...(r.negativePrompt ? { negative_prompt: r.negativePrompt } : {}),
    ...(r.seed !== undefined ? { random_seed: r.seed } : {}),
    response_format: 'b64_json',
    image_format: 'png',
  }),
};

const fields = (instance: ImageInstance, request: ImageRequest) => FIELDS[instance.preset ?? '']?.(request) ?? openAiFields(instance, request);

const PARTIAL_IMAGES = 2;

async function* eventsFromResult(instance: ImageInstance, deps: ImageAdapterDeps, body: unknown, signal: AbortSignal): AsyncGenerator<ImageEvent> {
  const items = arr(rec(body).data);
  let images = 0;
  let blocked = false;
  for (const item of items) {
    const image = rec(item);
    // xAI's way of leaving one out.
    if (image.respect_moderation === false) {
      blocked = true;
      continue;
    }
    const b64 = str(image.b64_json) ?? str(image.b64);
    const url = str(image.url);
    const seed = num(image.seed) ?? localSeed(image);
    const revisedPrompt = str(image.revised_prompt);
    const extra = { ...(seed !== undefined ? { seed } : {}), ...(revisedPrompt ? { revisedPrompt } : {}) };
    if (b64) yield { type: 'image', bytes: Buffer.from(b64, 'base64'), ...extra };
    else if (url && URL.canParse(url) && new URL(url).origin === new URL(instance.baseUrl).origin) {
      // A local server's own file: its address may be private, and it may want the same key.
      const res = await deps.fetch(url, { method: 'GET', headers: headers(instance, false), signal });
      if (!res.ok) throw new Error(`Fetching the image failed (${res.status}).`);
      yield { type: 'image', bytes: new Uint8Array(await res.arrayBuffer()), ...extra };
    } else if (url) yield { type: 'image', url, ...extra };
    else continue;
    images++;
  }
  const usage = usageEvent(rec(body).usage);
  if (usage) yield usage;
  yield images > 0 ? { type: 'finish', reason: 'done' } : blocked ? refusal(instance) : noImage(instance);
}

/** A multipart edit, in OpenAI's field names. */
function editBody(instance: ImageInstance, request: ImageRequest, extra: Record<string, string> = {}) {
  const form: MultipartField[] = Object.entries({ ...fields(instance, request), ...extra }).map(([name, value]) => ({ name, value: String(value) }));
  for (const image of request.references) form.push({ name: request.references.length > 1 ? 'image[]' : 'image', filename: image.name, mime: image.mime, bytes: image.bytes });
  if (request.mask) form.push({ name: 'mask', filename: request.mask.name, mime: request.mask.mime, bytes: request.mask.bytes });
  return multipart(form);
}

function send(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, stream: boolean): Promise<Response> {
  const extra = stream ? { stream: true, partial_images: PARTIAL_IMAGES } : {};
  // A local server may do edits on another route.
  const elsewhere = localEdit(instance, request, fields(instance, request));
  if (elsewhere) return deps.fetch(elsewhere.url, { method: 'POST', headers: headers(instance), body: JSON.stringify(elsewhere.body), signal: request.signal });
  const editing = request.references.length > 0;
  const json = (url: string, body: Record<string, unknown>) => deps.fetch(url, { method: 'POST', headers: headers(instance), body: JSON.stringify({ ...body, ...extra }), signal: request.signal });
  // xAI's edits are JSON, and Together's go in the generation request.
  if (editing && instance.preset === 'xai') {
    const images = request.references.map((image) => ({ url: asDataUrl(image), type: 'image_url' }));
    return json(endpoint(instance, request.model, 'edits'), { ...fields(instance, request), ...(images.length > 1 ? { images } : { image: images[0] }) });
  }
  if (!editing || instance.preset === 'together') return json(endpoint(instance, request.model, 'generations'), fields(instance, request));
  const { body, contentType } = editBody(instance, request, stream ? { stream: 'true', partial_images: String(PARTIAL_IMAGES) } : {});
  return deps.fetch(endpoint(instance, request.model, 'edits'), { method: 'POST', headers: { ...headers(instance, false), 'content-type': contentType }, body, signal: request.signal });
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  // OpenAI streams GPT image models only; one image at a time, as previews don't say which image they belong to.
  const stream = request.capabilities.previews && request.count === 1;
  const res = await send(instance, deps, request, stream);
  if (!res.ok) yield await failureOf(instance, res);
  else if (stream) yield* imageStream(instance, res, request.signal);
  else yield* eventsFromResult(instance, deps, fromImg2Img(await res.json()), request.signal);
}

/** `{ data: [...] }`, or Together's bare list, with what each entry says it is. */
function reported(body: unknown): { id: string; type?: string; name?: string }[] {
  const list = Array.isArray(body) ? body : arr(rec(body).data);
  return list.filter(isRecord).flatMap((m) => {
    const id = str(m.id);
    const type = str(m.type);
    const name = str(m.display_name);
    return id ? [{ id, ...(type ? { type } : {}), ...(name ? { name } : {}) }] : [];
  });
}

export function createOpenAiImages(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const listed = (modelId: string, source: ListedImageModel['source'], displayName?: string) => listedModel(instance, modelId, capabilitiesFor(instance, modelId), source, displayName ? { displayName } : {});
  const local = imagePreset(instance.preset)?.group === 'local';
  const known = KNOWN_IDS[instance.preset ?? ''] ?? [];
  /** Azure names deployments and Recraft has no list of models: those are typed in or known. */
  const noList = isAzure(instance) || instance.preset === 'recraft';
  const typedIn = () => [...new Set([...instance.models, ...known])].map((id) => listed(id, instance.models.includes(id) ? 'default' : 'catalog'));
  return {
    type: 'openai-images',
    async listModels(signal) {
      if (noList) return typedIn();
      const own = await localModels(instance, deps, headers(instance), signal);
      if (own) {
        const reportedHere = own.map((m): ListedImageModel => ({ ...listed(m.id, 'detected'), displayName: m.displayName ?? m.id, capabilities: m.capabilities }));
        return [...typedIn().filter((m) => !reportedHere.some((k) => k.modelId === m.modelId)), ...reportedHere];
      }
      const body = await requestJson(deps, instance, `${instance.baseUrl}/v1/models`, { headers: headers(instance), ...(signal ? { signal } : {}) }).catch(() => null);
      // LocalAI lists its text models too, and landing here means it couldn't say which are which.
      const entries = reported(body).filter((m) => !NOT_IMAGES.test(m.id) && (m.type ? m.type === 'image' : (local && instance.preset !== 'localai') || LOOKS_LIKE_IMAGES.test(m.id)));
      const seen = new Set([...instance.models, ...known]);
      return [...typedIn(), ...entries.filter((m) => !seen.has(m.id)).map((m) => listed(m.id, 'detected', m.name))];
    },
    health(signal) {
      if (noList) return Promise.resolve({ ok: true, latencyMs: null, warnings: [] });
      return probe(deps, instance, `${instance.baseUrl}/v1/models`, headers(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request));
    },
  };
}
