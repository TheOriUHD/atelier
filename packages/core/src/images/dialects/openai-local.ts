/**
 * The local servers behind the OpenAI images dialect. Each copies the format's two routes and then differs, and these
 * differences come from their source:
 *
 * - stable-diffusion.cpp's sd-server reads only `prompt`, `n`, `size` and the output fields. Everything else travels as
 *   JSON in a tag inside the prompt. `/v1/models` always says `sd-cpp-local`; the real name is in `/sdcpp/v1/capabilities`.
 *   `/v1/images/edits` passes pictures as reference images, which SD models ignore, so edits go to its `/sdapi/v1/img2img`.
 * - LocalAI calls steps `step`, takes the negative prompt after a `|`, and has no `/v1/images/edits`: the input picture
 *   is a `file` field on the generation route. `/v1/models` lists its text models too; `/v1/models/capabilities` tells them apart.
 * - Ollama has no list of image models, only an `image` capability per model in `/api/show`. Version 0.33 removed image
 *   generation and its routes, while models pulled earlier keep reporting the capability, so the route is checked too.
 */
import type { ImageCapabilities } from '@atelier/protocol';
import { probe, requestJson } from '../../providers/http.ts';
import type { HealthResult } from '../../providers/types.ts';
import { arr, num, rec, str, strings, toBase64 } from '../../providers/util.ts';
import { HOSTED_DEFAULTS, SQUARE } from '../catalog.ts';
import { checkpointFamily, checkpointLabel, editSize } from '../families.ts';
import type { ImageAdapterDeps, ImageInstance, ImageRequest } from '../types.ts';

type Headers = Record<string, string>;

const SD_CPP_TAG = 'sd_cpp_extra_args';
const SD_CPP_MODEL_ID = 'sd-cpp-local';
const SD_CPP_MAX_COUNT = 4;
/** How much an edit may change the picture: enough to act on the prompt, while it stays the same picture. */
const EDIT_STRENGTH = 0.6;
/** Enough to fill a Settings page without opening every model at once. */
const SHOW_AT_ONCE = 6;
const IMAGE_CAPABILITY = 'image';

export const OLLAMA_NO_IMAGES = 'Ollama removed image generation in version 0.33, so this server can\'t make images. Use an older Ollama, or another image server.';

/** Everything a local server's image model starts from; each server then says what it really takes. */
const LOCAL: ImageCapabilities = { ...HOSTED_DEFAULTS, family: 'local', sizes: SQUARE, seed: true };

export interface LocalModel {
  id: string;
  displayName?: string;
  capabilities: ImageCapabilities;
}

const family = (name: string) => {
  const { defaults, ...traits } = checkpointFamily(name);
  return { traits, defaults };
};

/** Everything sd-server doesn't read from the request itself, in the tag it takes out of the prompt again. */
function sdCppPrompt(request: ImageRequest): string {
  const { steps, guidance, sampler, scheduler } = request.tuning;
  const sampling = {
    ...(steps !== undefined ? { sample_steps: steps } : {}),
    ...(sampler ? { sample_method: sampler } : {}),
    ...(scheduler ? { scheduler } : {}),
    ...(guidance !== undefined ? { guidance: { txt_cfg: guidance } } : {}),
  };
  const extra = {
    ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(Object.keys(sampling).length ? { sample_params: sampling } : {}),
    // It ignores <lora:…> tags, and wants the path it listed.
    ...(request.loras.length ? { lora: request.loras.map((l) => ({ path: l.name, multiplier: l.weight })) } : {}),
  };
  // A second tag in the prompt would be read instead of this one.
  const prompt = request.prompt.replaceAll(`<${SD_CPP_TAG}>`, '').replaceAll(`</${SD_CPP_TAG}>`, '');
  return Object.keys(extra).length ? `${prompt} <${SD_CPP_TAG}>${JSON.stringify(extra)}</${SD_CPP_TAG}>` : prompt;
}

/** The request fields, changed for the server they're going to. */
export function localFields(instance: ImageInstance, request: ImageRequest, fields: Record<string, unknown>): Record<string, unknown> {
  if (instance.preset === 'sd-server') {
    const { seed: _seed, ...rest } = fields;
    return { ...rest, prompt: sdCppPrompt(request) };
  }
  if (instance.preset === 'localai') {
    const input = request.references[0];
    // A `|` in the prompt itself would cut it short and turn the rest into the negative prompt.
    const prompt = request.prompt.replaceAll('|', ',');
    return {
      ...fields,
      prompt: request.negativePrompt ? `${prompt}|${request.negativePrompt}` : prompt,
      ...(request.tuning.steps !== undefined ? { step: request.tuning.steps } : {}),
      ...(input ? { file: toBase64(input.bytes), ...editSizeField(request) } : {}),
    };
  }
  return fields;
}

const editSizeField = (request: ImageRequest) => {
  const { width, height } = editSize(request);
  return width && height ? { size: `${width}x${height}` } : {};
};

/** The body of an edit on a server that has no `/v1/images/edits` worth using, and where it goes. Null: the usual route. */
export function localEdit(instance: ImageInstance, request: ImageRequest, fields: Record<string, unknown>): { url: string; body: Record<string, unknown> } | null {
  if (request.references.length === 0) return null;
  if (instance.preset === 'localai') return { url: `${instance.baseUrl}/v1/images/generations`, body: fields };
  if (instance.preset !== 'sd-server') return null;
  const input = request.references[0]!;
  return {
    url: `${instance.baseUrl}/sdapi/v1/img2img`,
    body: {
      prompt: sdCppPrompt(request),
      ...editSize(request),
      batch_size: request.count,
      init_images: [toBase64(input.bytes)],
      denoising_strength: EDIT_STRENGTH,
      ...(request.mask ? { mask: toBase64(request.mask.bytes) } : {}),
    },
  };
}

/** `/sdapi/v1/img2img` answers in the other API's shape. */
export function fromImg2Img(body: unknown): unknown {
  const answer = rec(body);
  if (!Array.isArray(answer.images)) return body;
  let seeds: unknown[] = [];
  try {
    seeds = arr(rec(JSON.parse(str(answer.info) ?? '')).all_seeds);
  } catch {
    // `info` is empty on older servers.
  }
  return { data: strings(answer.images).map((b64_json, i) => ({ b64_json, seed: num(seeds[i]) })) };
}

/** The seed sd-server used. It reports it as text, nested when an inpainting step ran. */
export function localSeed(image: Record<string, unknown>): number | undefined {
  const info = rec(image.generation_info);
  const seed = rec(info.inpaint_params).seed ?? info.seed;
  const value = typeof seed === 'string' ? Number(seed) : seed;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function sdServerModels(instance: ImageInstance, deps: ImageAdapterDeps, headers: Headers, signal?: AbortSignal): Promise<LocalModel[] | null> {
  const init = { headers, ...(signal ? { signal } : {}) };
  const ids = arr(rec(await requestJson(deps, instance, `${instance.baseUrl}/v1/models`, init).catch(() => null)).data).flatMap((m) => str(rec(m).id) ?? []);
  // It lists its one id only while a model is loaded.
  if (!ids.includes(SD_CPP_MODEL_ID)) return ids.length ? null : [];
  const info = rec(await requestJson(deps, instance, `${instance.baseUrl}/sdcpp/v1/capabilities`, init).catch(() => null));
  const name = str(rec(info.model).stem) ?? str(rec(info.model).name) ?? '';
  const { traits, defaults } = family(name);
  const set = rec(rec(info.defaults_by_mode).img_gen);
  const sampling = rec((Object.keys(set).length ? set : rec(info.defaults)).sample_params);
  const features = rec(rec(info.features_by_mode).img_gen);
  const limits = rec(info.limits);
  const samplers = strings(info.samplers);
  const schedulers = strings(info.schedulers);
  const loras = arr(info.loras).flatMap((l) => str(rec(l).path) ?? []);
  const sampler = str(sampling.sample_method);
  const scheduler = str(sampling.scheduler);
  const { sizes } = traits;
  const edit = features.init_image === true;
  return [
    {
      id: SD_CPP_MODEL_ID,
      displayName: name ? checkpointLabel(name) : instance.name,
      capabilities: {
        ...LOCAL,
        ...traits,
        sizes: sizes.kind === 'free' ? { ...sizes, min: Math.max(sizes.min, num(limits.min_width) ?? 0), max: Math.min(sizes.max, num(limits.max_width) ?? sizes.max) } : sizes,
        maxCount: Math.max(1, Math.min(SD_CPP_MAX_COUNT, num(limits.max_batch_count) ?? 1)),
        edit,
        mask: edit && features.mask_image === true,
        maxReferences: edit ? 1 : 0,
        tunable: true,
        defaults: {
          ...(defaults.steps ? { steps: defaults.steps } : {}),
          ...(defaults.guidance !== undefined ? { guidance: defaults.guidance } : {}),
          ...(sampler && samplers.includes(sampler) ? { sampler } : {}),
          ...(scheduler && schedulers.includes(scheduler) ? { scheduler } : {}),
        },
        ...(samplers.length ? { samplers } : {}),
        ...(schedulers.length ? { schedulers } : {}),
        ...(loras.length ? { loras } : {}),
      },
    },
  ];
}

async function localAiModels(instance: ImageInstance, deps: ImageAdapterDeps, headers: Headers, signal?: AbortSignal): Promise<LocalModel[] | null> {
  const body = await requestJson(deps, instance, `${instance.baseUrl}/v1/models/capabilities`, { headers, ...(signal ? { signal } : {}) }).catch(() => null);
  // An older LocalAI, without the route: the name-based guess in the caller is all there is.
  if (!body) return null;
  return arr(rec(body).data).flatMap((entry) => {
    const model = rec(entry);
    const id = str(model.id);
    if (!id || !strings(model.capabilities).includes(IMAGE_CAPABILITY)) return [];
    const { traits, defaults } = family(id);
    return [{ id, capabilities: { ...LOCAL, ...traits, negativePrompt: true, edit: true, maxCount: 4, maxReferences: 1, tunable: true, defaults: { ...(defaults.steps ? { steps: defaults.steps } : {}) } } }];
  });
}

async function ollamaModels(instance: ImageInstance, deps: ImageAdapterDeps, headers: Headers, signal?: AbortSignal): Promise<LocalModel[]> {
  const init = { headers, ...(signal ? { signal } : {}) };
  const names = arr(rec(await requestJson(deps, instance, `${instance.baseUrl}/api/tags`, init)).models).flatMap((m) => str(rec(m).name) ?? []);
  const image: string[] = [];
  const next = names[Symbol.iterator]();
  const worker = async () => {
    for (const model of next) {
      // A model it can't describe is left out: a text model must never show as an image model.
      const shown = await requestJson(deps, instance, `${instance.baseUrl}/api/show`, { ...init, method: 'POST', body: { model } }).catch(() => null);
      if (strings(rec(shown).capabilities).includes(IMAGE_CAPABILITY)) image.push(model);
    }
  };
  await Promise.all(Array.from({ length: SHOW_AT_ONCE }, worker));
  return image.sort().map((id) => {
    const { traits } = family(id);
    return { id, capabilities: { ...LOCAL, ...traits, negativePrompt: false, promptStyle: 'natural' as const } };
  });
}

/** The models of a server with its own way of telling them apart. Null: use `/v1/models`. */
export function localModels(instance: ImageInstance, deps: ImageAdapterDeps, headers: Headers, signal?: AbortSignal): Promise<LocalModel[] | null> {
  if (instance.preset === 'sd-server') return sdServerModels(instance, deps, headers, signal);
  if (instance.preset === 'localai') return localAiModels(instance, deps, headers, signal);
  if (instance.preset === 'ollama') return ollamaModels(instance, deps, headers, signal);
  return Promise.resolve(null);
}

/** Whether Ollama still has its images route: a real one answers an empty request with a 400. */
export async function ollamaHealth(instance: ImageInstance, deps: ImageAdapterDeps, headers: Headers, signal?: AbortSignal): Promise<HealthResult> {
  const health = await probe(deps, instance, `${instance.baseUrl}/api/tags`, headers, signal);
  if (!health.ok) return health;
  const res = await deps.fetch(`${instance.baseUrl}/v1/images/generations`, { method: 'POST', headers, body: '{}', signal: signal ?? null });
  return res.status === 404 ? { ...health, ok: false, error: OLLAMA_NO_IMAGES } : health;
}
