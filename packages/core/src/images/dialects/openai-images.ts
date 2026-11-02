/**
 * The OpenAI images wire format: `POST /v1/images/generations` and `/v1/images/edits`. OpenAI, and most servers that
 * copy it: stable-diffusion.cpp's sd-server, LocalAI, Ollama, Together, xAI, Recraft, LiteLLM, Azure (other paths and
 * header). `IMAGE_PROVIDER_PRESETS` says which; services differ in what they accept, not in how they're spoken to.
 */
import { imagePreset, modelRef, type ImageCapabilities } from '@atelier/protocol';
import { httpError, probe, requestJson } from '../../providers/http.ts';
import { parseSSE } from '../../providers/sse.ts';
import { arr, num, rec, str } from '../../providers/util.ts';
import { HOSTED_DEFAULTS, OPENAI_MODELS, SQUARE } from '../catalog.ts';
import { guardImages, refusedError } from '../guard.ts';
import { multipart, type MultipartField } from '../multipart.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';

/** Model ids that aren't for images, for servers whose list holds everything. */
const NOT_IMAGES = /embed|whisper|tts|transcri|moderation|rerank|audio|realtime/i;
/** On a hosted service that also lists text models, what an image model looks like. */
const LOOKS_LIKE_IMAGES = /image|dall-e|flux|stable-?diffusion|sdxl|imagine|recraft/i;

const LOCAL_CAPABILITIES: ImageCapabilities = { ...HOSTED_DEFAULTS, family: 'local', sizes: SQUARE, seed: true };

function capabilitiesFor(instance: ImageInstance, modelId: string): ImageCapabilities {
  const local = imagePreset(instance.preset)?.group === 'local';
  const base = local ? LOCAL_CAPABILITIES : HOSTED_DEFAULTS;
  const known = OPENAI_MODELS.find(([match]) => match.test(modelId))?.[1];
  return { ...base, ...known };
}

const isAzure = (instance: ImageInstance) => instance.preset === 'azure';
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

/** The fields every request shares, leaving out what a service doesn't take. */
function fields(instance: ImageInstance, request: ImageRequest): Record<string, unknown> {
  const gpt = request.capabilities.family === 'gpt-image';
  const size = sizeOf(request);
  return {
    model: request.model,
    prompt: instance.preset === 'localai' && request.negativePrompt ? `${request.prompt}|${request.negativePrompt}` : request.prompt,
    ...(request.count > 1 ? { n: request.count } : {}),
    ...(size ? { size } : {}),
    ...(gpt ? { quality: request.quality === 'draft' ? 'low' : request.quality === 'high' ? 'high' : 'medium' } : {}),
    ...(gpt && request.transparent ? { background: 'transparent', output_format: 'png' } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(instance.preset === 'together' ? { response_format: 'base64', steps: request.tuning.steps } : {}),
    // GPT image models always answer in base64 and refuse the field.
    ...(!gpt && instance.preset !== 'together' && instance.preset !== 'xai' ? { response_format: 'b64_json' } : {}),
  };
}

const PARTIAL_IMAGES = 2;

async function* eventsFromResult(instance: ImageInstance, deps: ImageAdapterDeps, body: unknown, signal: AbortSignal): AsyncGenerator<ImageEvent> {
  for (const item of arr(rec(body).data)) {
    const image = rec(item);
    const b64 = str(image.b64_json) ?? str(image.b64);
    const url = str(image.url);
    const seed = num(image.seed);
    const revisedPrompt = str(image.revised_prompt);
    const extra = { ...(seed !== undefined ? { seed } : {}), ...(revisedPrompt ? { revisedPrompt } : {}) };
    if (b64) yield { type: 'image', bytes: Buffer.from(b64, 'base64'), ...extra };
    else if (url && URL.canParse(url) && new URL(url).origin === new URL(instance.baseUrl).origin) {
      // A local server's own file: its address may be private, and it may want the same key.
      const res = await deps.fetch(url, { method: 'GET', headers: headers(instance, false), signal });
      if (!res.ok) throw new Error(`Fetching the image failed (${res.status}).`);
      yield { type: 'image', bytes: new Uint8Array(await res.arrayBuffer()), ...extra };
    } else if (url) yield { type: 'image', url, ...extra };
  }
}

async function* streamed(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(endpoint(instance, request.model, 'generations'), {
    method: 'POST',
    headers: headers(instance),
    body: JSON.stringify({ ...fields(instance, request), stream: true, partial_images: PARTIAL_IMAGES }),
    signal: request.signal,
  });
  if (!res.ok) {
    yield* failed(instance, res);
    return;
  }
  if (!res.body) throw new Error(`${instance.name} sent an empty answer.`);
  for await (const event of parseSSE(res.body, request.signal)) {
    const data = rec(JSON.parse(event.data));
    const type = str(data.type) ?? event.event ?? '';
    const b64 = str(data.b64_json);
    if (type.endsWith('partial_image') && b64) yield { type: 'preview', mime: 'image/png', data: b64 };
    else if (type.endsWith('completed') && b64) {
      yield { type: 'image', bytes: Buffer.from(b64, 'base64') };
      const usage = rec(data.usage);
      const input = num(usage.input_tokens);
      const output = num(usage.output_tokens);
      if (input !== undefined || output !== undefined) yield { type: 'usage', ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
    }
  }
  yield { type: 'finish', reason: 'done' };
}

/** A refusal is the provider's answer to the prompt, not a fault: the tool says so, and the model doesn't retry it. */
async function* failed(instance: ImageInstance, res: Response): AsyncGenerator<ImageEvent> {
  const error = await httpError(res, instance);
  if (res.status === 400 && /moderation|safety|content.?policy|refused|blocked/i.test(error.message)) yield { type: 'finish', reason: 'refused', error: refusedError(instance.name, error.message) };
  else yield { type: 'finish', reason: 'error', error };
}

async function* plain(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const editing = request.references.length > 0;
  let res: Response;
  if (editing) {
    const form: MultipartField[] = Object.entries(fields(instance, request)).map(([name, value]) => ({ name, value: String(value) }));
    for (const image of request.references) form.push({ name: request.references.length > 1 ? 'image[]' : 'image', filename: image.name, mime: image.mime, bytes: image.bytes });
    if (request.mask) form.push({ name: 'mask', filename: request.mask.name, mime: request.mask.mime, bytes: request.mask.bytes });
    const { body, contentType } = multipart(form);
    res = await deps.fetch(endpoint(instance, request.model, 'edits'), { method: 'POST', headers: { ...headers(instance, false), 'content-type': contentType }, body, signal: request.signal });
  } else {
    res = await deps.fetch(endpoint(instance, request.model, 'generations'), { method: 'POST', headers: headers(instance), body: JSON.stringify(fields(instance, request)), signal: request.signal });
  }
  if (!res.ok) {
    yield* failed(instance, res);
    return;
  }
  yield* eventsFromResult(instance, deps, await res.json(), request.signal);
  yield { type: 'finish', reason: 'done' };
}

export function createOpenAiImages(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const listed = (modelId: string, source: ListedImageModel['source']): ListedImageModel => ({
    ref: modelRef(instance.id, modelId),
    providerId: instance.id,
    modelId,
    displayName: modelId,
    capabilities: capabilitiesFor(instance, modelId),
    source,
  });
  const typedIn = () => instance.models.map((id) => listed(id, 'default'));
  const local = imagePreset(instance.preset)?.group === 'local';
  return {
    type: 'openai-images',
    async listModels(signal) {
      // Azure names deployments, and some services report nothing: those are typed in.
      if (isAzure(instance)) return typedIn();
      const body = await requestJson(deps, instance, `${instance.baseUrl}/v1/models`, { headers: headers(instance), ...(signal ? { signal } : {}) }).catch(() => null);
      const ids = arr(rec(body).data).flatMap((m) => str(rec(m).id) ?? []);
      const useful = ids.filter((id) => !NOT_IMAGES.test(id) && (local || LOOKS_LIKE_IMAGES.test(id)));
      const typed = new Set(instance.models);
      return [...typedIn(), ...useful.filter((id) => !typed.has(id)).map((id) => listed(id, 'detected'))];
    },
    health(signal) {
      if (isAzure(instance)) return Promise.resolve({ ok: true, latencyMs: null, warnings: [] });
      return probe(deps, instance, `${instance.baseUrl}/v1/models`, headers(instance), signal);
    },
    generate(request) {
      const preview = request.capabilities.previews && request.references.length === 0 && request.count === 1;
      return guardImages(request, instance, () => (preview ? streamed(instance, deps, request) : plain(instance, deps, request)));
    },
  };
}
