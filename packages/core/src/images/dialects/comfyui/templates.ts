/**
 * Built-in recipes as code that writes API-format graphs, one per model family. Every result goes through `PreviewImage`,
 * not `SaveImage`: both give the same pixels and metadata, but `PreviewImage` leaves its file in ComfyUI's temp folder,
 * which empties itself, and not in the person's output folder. Atelier keeps its own copy, so a second one in the
 * output folder would be clutter. The cost is a PNG compressed less, which nobody sees.
 */
import { arr, rec } from '../../../providers/util.ts';
import type { ImageRequest } from '../../types.ts';
import { choices, detailerReady, FAMILIES, type FamilyId, type ModelSource, type ObjectInfo, type Stack } from './discovery.ts';

export type Link = [string, number];
export interface GraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
export type Graph = Record<string, GraphNode>;

export interface GraphPlan {
  graph: Graph;
  /** The node whose images are the result. */
  output: string;
  /** The nodes that take steps, in order: how far the job as a whole is. */
  samplers: string[];
}

export interface TemplateInput {
  file: string;
  source: ModelSource;
  family: FamilyId;
  stack: Stack;
  request: ImageRequest;
  seed: number;
  /** Uploaded names of the input images, in `LoadImage` form. */
  images: string[];
  mask?: string;
  /** Pixel size of the first input image, to keep its shape. */
  inputSize?: { width: number; height: number };
  info: ObjectInfo;
}

/** How far an edit may move from the input: enough to change it, and not enough to lose what's in it. */
const EDIT_DENOISE = 0.6;
/** A mask already protects everything outside it, so inside it can change freely. */
const MASK_DENOISE = 0.9;
const HIRES_SCALE = 1.5;
const HIRES_DENOISE = 0.45;
/** A second pass redraws under half the image's noise, so it needs fewer steps than the first. */
const HIRES_STEP_SHARE = 0.6;
const HIRES_MIN_STEPS = 6;
const DRAFT_STEP_SHARE = 0.6;
const FACE_MAX_STEPS = 20;
const FACE_DENOISE = 0.5;

class Builder {
  readonly graph: Graph = {};
  private next = 1;

  add(class_type: string, inputs: Record<string, unknown>): string {
    const id = String(this.next++);
    this.graph[id] = { class_type, inputs };
    return id;
  }

  /** A node with one output worth having: a link to it. */
  link(class_type: string, inputs: Record<string, unknown>): Link {
    return [this.add(class_type, inputs), 0];
  }
}

interface Models {
  model: Link;
  clip: Link;
  vae: Link;
}

function loadModels(g: Builder, { file, source, stack, request }: TemplateInput): Models {
  let model: Link;
  let clip: Link | undefined;
  let vae: Link | undefined;
  if (source === 'checkpoint') {
    const loader = g.add('CheckpointLoaderSimple', { ckpt_name: file });
    [model, clip, vae] = [[loader, 0], [loader, 1], [loader, 2]];
  } else model = g.link('UNETLoader', { unet_name: file, weight_dtype: 'default' });
  if (stack.clip) clip = g.link(stack.clip.class_type, stack.clip.inputs);
  if (stack.vae) vae = g.link('VAELoader', { vae_name: stack.vae });
  if (!clip || !vae) throw new Error(`${file} needs a text encoder and a VAE, and this server has none to go with it.`);
  for (const lora of request.loras) {
    const loader = g.add('LoraLoader', { model, clip, lora_name: lora.name, strength_model: lora.weight, strength_clip: lora.weight });
    [model, clip] = [[loader, 0], [loader, 1]];
  }
  return { model, clip, vae };
}

const RESAMPLE = { upscale_method: 'lanczos', crop: 'disabled' };

/** An input image keeps its shape, at about the area asked for: stretching it to fit a frame would warp what's in it. */
export function editSize(asked: { width: number; height: number }, input: { width: number; height: number } | undefined, multiple: number): { width: number; height: number } {
  if (!input || input.width === 0 || input.height === 0) return asked;
  const scale = Math.sqrt((asked.width * asked.height) / (input.width * input.height));
  const fit = (side: number) => Math.max(multiple, Math.round((side * scale) / multiple) * multiple);
  return { width: fit(input.width), height: fit(input.height) };
}

function loadImage(g: Builder, image: string, size: { width: number; height: number }): Link {
  return g.link('ImageScale', { image: g.link('LoadImage', { image }), ...RESAMPLE, ...size });
}

const stepsOf = (input: TemplateInput): number => {
  const family = FAMILIES[input.family];
  const steps = input.request.tuning.steps ?? family.defaults.steps;
  return input.request.quality === 'draft' ? Math.max(family.minSteps, Math.round(steps * DRAFT_STEP_SHARE)) : steps;
};

const askedSize = ({ request, family }: TemplateInput) => {
  const { base } = FAMILIES[family].sizes;
  return { width: request.width ?? base, height: request.height ?? base };
};

/** The latent a sampler starts from: empty, or an input image with its mask. */
function startLatent(g: Builder, input: TemplateInput, vae: Link, latentNode: string): { latent: Link; denoise: number } {
  const { request, images, mask, family, inputSize } = input;
  const { multiple } = FAMILIES[family].sizes;
  const [image] = images;
  if (!image) return { latent: g.link(latentNode, { ...askedSize(input), batch_size: request.count }), denoise: 1 };
  let latent = g.link('VAEEncode', { pixels: loadImage(g, image, editSize(askedSize(input), inputSize, multiple)), vae });
  if (request.count > 1) latent = g.link('RepeatLatentBatch', { samples: latent, amount: request.count });
  if (mask) latent = g.link('SetLatentNoiseMask', { samples: latent, mask: g.link('LoadImageMask', { image: mask, channel: 'red' }) });
  return { latent, denoise: mask ? MASK_DENOISE : EDIT_DENOISE };
}

function shapeModel(g: Builder, family: FamilyId, model: Link): Link {
  if (family === 'z-image') return g.link('ModelSamplingAuraFlow', { model, shift: 3 });
  if (family === 'sd3') return g.link('ModelSamplingSD3', { model, shift: 3 });
  return model;
}

/** `FaceDetailer`'s inputs change between Impact Pack versions, so those it needs are read from this server. */
function faceDetailerInputs(info: ObjectInfo, known: Record<string, unknown>): Record<string, unknown> | null {
  const required = rec(rec(info.FaceDetailer?.input).required);
  const inputs: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(required)) {
    if (name in known) {
      inputs[name] = known[name];
      continue;
    }
    const [type, options] = arr(spec);
    const fallback = rec(options).default ?? choices(info.FaceDetailer, name)[0] ?? (type === 'STRING' ? '' : undefined);
    if (fallback === undefined) return null;
    inputs[name] = fallback;
  }
  return inputs;
}

function detailFaces(g: Builder, input: TemplateInput, models: Models, image: Link, conditioning: { positive: Link; negative: Link }, sampling: Record<string, unknown>): Link | null {
  const { info } = input;
  if (!detailerReady(info)) return null;
  const detector = choices(info.UltralyticsDetectorProvider, 'model_name').find((m) => /face/i.test(m))!;
  const known = { ...sampling, ...models, ...conditioning, image, bbox_detector: null, denoise: FACE_DENOISE, steps: Math.min(FACE_MAX_STEPS, sampling.steps as number) };
  const inputs = faceDetailerInputs(info, known);
  if (!inputs) return null;
  inputs.bbox_detector = g.link('UltralyticsDetectorProvider', { model_name: detector });
  return g.link('FaceDetailer', inputs);
}

/** SD 1.5, SDXL, SD3, FLUX.1 and Z-Image all reduce to one `KSampler` graph. */
function samplerGraph(input: TemplateInput): GraphPlan {
  const { request, family: id, seed, images } = input;
  const family = FAMILIES[id];
  const g = new Builder();
  const models = loadModels(g, input);
  const model = shapeModel(g, id, models.model);
  const text = g.link('CLIPTextEncode', { clip: models.clip, text: request.prompt });
  const guidance = request.tuning.guidance ?? family.defaults.guidance;
  // FLUX.1 reads its guidance from the conditioning; its sampler stays at 1 or it slows down and burns the image.
  const positive = id === 'flux' ? g.link('FluxGuidance', { conditioning: text, guidance }) : text;
  const negative = family.negativePrompt ? g.link('CLIPTextEncode', { clip: models.clip, text: request.negativePrompt ?? '' }) : g.link('ConditioningZeroOut', { conditioning: text });
  const latentNode = id === 'sd15' || id === 'sdxl' || id === 'sdxl-distilled' ? 'EmptyLatentImage' : 'EmptySD3LatentImage';
  const { latent, denoise } = startLatent(g, input, models.vae, latentNode);
  const steps = stepsOf(input);
  const sampling = { seed, cfg: id === 'flux' ? 1 : guidance, sampler_name: request.tuning.sampler ?? family.defaults.sampler, scheduler: request.tuning.scheduler ?? family.defaults.scheduler };
  const first = g.add('KSampler', { model, positive, negative, latent_image: latent, ...sampling, steps, denoise });
  const samplers = [first];
  let samples: Link = [first, 0];

  const polish = request.quality === 'high' && (id === 'sdxl' || id === 'sdxl-distilled') && images.length === 0;
  if (polish) {
    const larger = g.link('LatentUpscaleBy', { samples, upscale_method: 'bislerp', scale_by: HIRES_SCALE });
    const second = g.add('KSampler', { model, positive, negative, latent_image: larger, ...sampling, steps: Math.max(HIRES_MIN_STEPS, Math.round(steps * HIRES_STEP_SHARE)), denoise: HIRES_DENOISE });
    samplers.push(second);
    samples = [second, 0];
  }
  let image = g.link('VAEDecode', { samples, vae: models.vae });
  if (polish) {
    const faces = detailFaces(g, input, { ...models, model }, image, { positive, negative }, { ...sampling, steps });
    if (faces) {
      image = faces;
      samplers.push(faces[0]);
    }
  }
  return { graph: g.graph, output: g.add('PreviewImage', { images: image }), samplers };
}

/** FLUX.2 samples through a guider and takes input images as references: `Flux2Scheduler` has no denoise to set. */
function flux2Graph(input: TemplateInput): GraphPlan {
  const { request, seed, images, family, inputSize } = input;
  const defaults = FAMILIES.flux2.defaults;
  const g = new Builder();
  const { model, clip, vae } = loadModels(g, input);
  const text = g.link('CLIPTextEncode', { clip, text: request.prompt });
  const size = images.length ? editSize(askedSize(input), inputSize, FAMILIES[family].sizes.multiple) : askedSize(input);
  let positive = text;
  for (const image of images) positive = g.link('ReferenceLatent', { conditioning: positive, latent: g.link('VAEEncode', { pixels: loadImage(g, image, size), vae }) });
  const sampler = g.add('SamplerCustomAdvanced', {
    noise: g.link('RandomNoise', { noise_seed: seed }),
    guider: g.link('CFGGuider', { model, positive, negative: g.link('ConditioningZeroOut', { conditioning: text }), cfg: request.tuning.guidance ?? defaults.guidance }),
    sampler: g.link('KSamplerSelect', { sampler_name: request.tuning.sampler ?? defaults.sampler }),
    sigmas: g.link('Flux2Scheduler', { steps: stepsOf(input), ...size }),
    latent_image: g.link('EmptyFlux2LatentImage', { ...size, batch_size: request.count }),
  });
  const image = g.link('VAEDecode', { samples: [sampler, 0], vae });
  return { graph: g.graph, output: g.add('PreviewImage', { images: image }), samplers: [sampler] };
}

export function buildGraph(input: TemplateInput): GraphPlan {
  return input.family === 'flux2' ? flux2Graph(input) : samplerGraph(input);
}
