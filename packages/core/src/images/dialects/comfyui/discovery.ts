/**
 * What a ComfyUI server can run, read from `/object_info` and never assumed: file names change, and so do the nodes a
 * server has. A file becomes a model when its family is known and every part its recipe needs is there, so nothing is
 * offered that can only fail. Anything else needs an imported workflow.
 */
import { modelRef, type ImageCapabilities, type ImageSizes, type ImageTuning } from '@atelier/protocol';
import { rec, strings } from '../../../providers/util.ts';
import type { ImageInstance, ListedImageModel } from '../../types.ts';
import { workflowCapabilities, workflowModelId } from './workflow.ts';

export type NodeInfo = Record<string, unknown>;
export type ObjectInfo = Record<string, NodeInfo>;

export type FamilyId = 'sd15' | 'sdxl' | 'sdxl-distilled' | 'sd3' | 'flux' | 'flux2' | 'z-image';
export type ModelSource = 'checkpoint' | 'unet';

/** The nodes discovery asks about. Asking for all of `/object_info` can stop that server answering for minutes. */
export const DISCOVERY_NODES = [
  'CheckpointLoaderSimple',
  'UNETLoader',
  'CLIPLoader',
  'DualCLIPLoader',
  'TripleCLIPLoader',
  'VAELoader',
  'LoraLoader',
  'KSampler',
  'KSamplerSelect',
  'EmptySD3LatentImage',
  'EmptyFlux2LatentImage',
  'ModelSamplingAuraFlow',
  'ModelSamplingSD3',
  'FluxGuidance',
  'ConditioningZeroOut',
  'Flux2Scheduler',
  'CFGGuider',
  'SamplerCustomAdvanced',
  'RandomNoise',
  'ReferenceLatent',
  'FaceDetailer',
  'UltralyticsDetectorProvider',
] as const;

const inputSpec = (info: NodeInfo | undefined, input: string): unknown => {
  const inputs = rec(rec(info).input);
  return rec(inputs.required)[input] ?? rec(inputs.optional)[input];
};

/** The values a choice input takes. Servers write these as `[[...]]`, or as `["COMBO", { options }]`. */
export function choices(info: NodeInfo | undefined, input: string): string[] {
  const spec = inputSpec(info, input);
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return strings(spec[0]);
  return spec[0] === 'COMBO' ? strings(rec(spec[1]).options) : [];
}

type FreeSizes = Extract<ImageSizes, { kind: 'free' }>;

interface Family {
  id: FamilyId;
  label: string;
  promptStyle: ImageCapabilities['promptStyle'];
  /** Off where guidance is 1, since the sampler never reads a negative prompt there. */
  negativePrompt: boolean;
  sizes: FreeSizes;
  defaults: ImageTuning & { steps: number; guidance: number; sampler: string; scheduler: string };
  /** `draft` goes no lower: fewer steps than this makes noise, not a quick look. */
  minSteps: number;
  /** Takes an input image through its latent. */
  edit: boolean;
  maxReferences: number;
  mask: boolean;
  needs: readonly string[];
}

const free = (base: number, multiple: number, min: number, max: number): FreeSizes => ({ kind: 'free', min, max, multiple, base });
const XL_SIZES = free(1024, 8, 512, 2048);

export const FAMILIES: Record<FamilyId, Family> = {
  sd15: { id: 'sd15', label: 'SD 1.5', promptStyle: 'tags', negativePrompt: true, sizes: free(512, 8, 256, 1024), defaults: { steps: 25, guidance: 7, sampler: 'dpmpp_2m', scheduler: 'karras' }, minSteps: 12, edit: true, maxReferences: 1, mask: true, needs: [] },
  sdxl: { id: 'sdxl', label: 'SDXL', promptStyle: 'tags', negativePrompt: true, sizes: XL_SIZES, defaults: { steps: 30, guidance: 6, sampler: 'dpmpp_2m_sde', scheduler: 'karras' }, minSteps: 15, edit: true, maxReferences: 1, mask: true, needs: [] },
  'sdxl-distilled': { id: 'sdxl-distilled', label: 'SDXL, distilled: fast', promptStyle: 'tags', negativePrompt: false, sizes: XL_SIZES, defaults: { steps: 8, guidance: 1, sampler: 'dpmpp_sde', scheduler: 'karras' }, minSteps: 4, edit: true, maxReferences: 1, mask: true, needs: ['ConditioningZeroOut'] },
  sd3: { id: 'sd3', label: 'Stable Diffusion 3', promptStyle: 'natural', negativePrompt: true, sizes: free(1024, 16, 512, 2048), defaults: { steps: 28, guidance: 4.5, sampler: 'dpmpp_2m', scheduler: 'sgm_uniform' }, minSteps: 14, edit: true, maxReferences: 1, mask: true, needs: ['EmptySD3LatentImage', 'ModelSamplingSD3'] },
  flux: { id: 'flux', label: 'FLUX.1', promptStyle: 'natural', negativePrompt: false, sizes: free(1024, 16, 256, 2048), defaults: { steps: 20, guidance: 3.5, sampler: 'euler', scheduler: 'simple' }, minSteps: 4, edit: true, maxReferences: 1, mask: true, needs: ['EmptySD3LatentImage', 'FluxGuidance', 'ConditioningZeroOut'] },
  flux2: { id: 'flux2', label: 'FLUX.2 Klein: fast', promptStyle: 'natural', negativePrompt: false, sizes: free(1024, 16, 256, 2048), defaults: { steps: 4, guidance: 1, sampler: 'euler', scheduler: 'simple' }, minSteps: 4, edit: true, maxReferences: 4, mask: false, needs: ['EmptyFlux2LatentImage', 'Flux2Scheduler', 'CFGGuider', 'SamplerCustomAdvanced', 'RandomNoise', 'KSamplerSelect', 'ConditioningZeroOut'] },
  'z-image': { id: 'z-image', label: 'Z-Image: fast and general purpose', promptStyle: 'natural', negativePrompt: false, sizes: free(1024, 16, 256, 2048), defaults: { steps: 8, guidance: 1, sampler: 'res_multistep', scheduler: 'simple' }, minSteps: 6, edit: true, maxReferences: 1, mask: true, needs: ['EmptySD3LatentImage', 'ModelSamplingAuraFlow', 'ConditioningZeroOut'] },
};

/**
 * Fastest and most general first: "the first model" is what the Test button tries and what a person gets before they
 * choose, and a server's checkpoints can be anything, while these families are made for everyday use.
 */
const LISTING_ORDER: readonly FamilyId[] = ['z-image', 'flux2', 'flux', 'sd3', 'sdxl-distilled', 'sdxl', 'sd15'];

const DISTILLED = /dmd2|lcm|turbo|lightning|hyper/i;
const SD15 = /sd[-_. ]?1[-_.]?5|v1[-_.]5/i;
const SCHNELL = /schnell/i;
/** The undistilled Klein: more steps, real guidance. */
const KLEIN_BASE = /klein[-_ ]?base/i;

/** A file's family from its name. A checkpoint with no hint is SDXL: that's what nearly every checkpoint made today is. */
export function detectFamily(file: string, source: ModelSource): FamilyId | null {
  if (/z[-_ ]?image/i.test(file)) return 'z-image';
  if (/flux[-_. ]?2/i.test(file)) return /klein/i.test(file) ? 'flux2' : null;
  if (/flux/i.test(file)) return 'flux';
  if (/sd[-_. ]?3|stable[-_ ]?diffusion[-_ ]?3/i.test(file)) return 'sd3';
  if (source === 'unet') return null;
  if (SD15.test(file)) return 'sd15';
  return DISTILLED.test(file) ? 'sdxl-distilled' : 'sdxl';
}

export interface LoaderNode {
  class_type: 'CLIPLoader' | 'DualCLIPLoader' | 'TripleCLIPLoader';
  inputs: Record<string, string>;
}

/** What a model file doesn't carry itself: a text encoder, a VAE. */
export interface Stack {
  clip?: LoaderNode;
  vae?: string;
}

const find = (list: readonly string[], pattern: RegExp) => list.find((f) => pattern.test(f));

/** FLUX.2 Klein and Z-Image share one encoder, in a size to match the model. */
function qwenEncoder(file: string, clips: readonly string[]): string | undefined {
  const size = /klein[-_ ]?9b/i.test(file) ? /qwen.*8b/i : /qwen.*4b/i;
  return find(clips, size) ?? find(clips, /qwen/i);
}

/** The parts a file needs beside it, or null when one is missing and it can't run. */
export function stackFor(family: FamilyId, file: string, source: ModelSource, info: ObjectInfo): Stack | null {
  const clips = choices(info.CLIPLoader, 'clip_name');
  const clipTypes = choices(info.CLIPLoader, 'type');
  const vaes = choices(info.VAELoader, 'vae_name');
  const single = (clip: string | undefined, type: string): LoaderNode | null => (clip && clipTypes.includes(type) ? { class_type: 'CLIPLoader', inputs: { clip_name: clip, type, device: 'default' } } : null);
  switch (family) {
    case 'sd15':
    case 'sdxl':
    case 'sdxl-distilled':
      return {};
    case 'z-image': {
      const clip = single(qwenEncoder(file, clips), 'lumina2');
      const vae = find(vaes, /(^|[/\\_-])ae\./i);
      return clip && vae ? { clip, vae } : null;
    }
    case 'flux2': {
      const clip = single(qwenEncoder(file, clips), 'flux2');
      const vae = find(vaes, /flux[-_.]?2/i);
      return clip && vae ? { clip, vae } : null;
    }
    case 'flux': {
      if (source === 'checkpoint') return {};
      const names = choices(info.DualCLIPLoader, 'clip_name1');
      const [clipL, t5] = [find(names, /clip[-_]?l/i), find(names, /t5/i)];
      const vae = find(vaes, /(^|[/\\_-])ae\./i);
      return clipL && t5 && vae ? { clip: { class_type: 'DualCLIPLoader', inputs: { clip_name1: clipL, clip_name2: t5, type: 'flux', device: 'default' } }, vae } : null;
    }
    case 'sd3': {
      const names = choices(info.TripleCLIPLoader, 'clip_name1');
      const [clipL, clipG, t5] = [find(names, /clip[-_]?l/i), find(names, /clip[-_]?g/i), find(names, /t5/i)];
      // A checkpoint may carry its own encoders; a separate set works either way, so it's preferred when it's there.
      if (clipL && clipG && t5) return { clip: { class_type: 'TripleCLIPLoader', inputs: { clip_name1: clipL, clip_name2: clipG, clip_name3: t5 } } };
      return source === 'checkpoint' ? {} : null;
    }
  }
}

/** A person recognises their own file names, so those stay; the two with awkward ones read better cleaned up. */
function displayName(file: string): string {
  const base = (file.split(/[/\\]/).pop() ?? file).replace(/\.(safetensors|sft|ckpt|pt|pth|bin)$/i, '');
  if (/z[-_ ]?image[-_ ]?turbo/i.test(base)) return 'Z-Image Turbo';
  const klein = /flux[-_. ]?2[-_ ]?klein[-_ ]?(\d+b)?/i.exec(base);
  return klein ? `FLUX.2 Klein${klein[1] ? ` ${klein[1].toUpperCase()}` : ''}` : base;
}

export function detailerReady(info: ObjectInfo): boolean {
  return !!info.FaceDetailer && choices(info.UltralyticsDetectorProvider, 'model_name').some((m) => /face/i.test(m));
}

function capabilities(family: Family, file: string, info: ObjectInfo): ImageCapabilities {
  const samplers = choices(info.KSampler, 'sampler_name');
  const schedulers = choices(info.KSampler, 'scheduler');
  // A recipe's sampler may be newer than the server. Euler and simple are on all of them.
  const defaults: ImageTuning = {
    ...family.defaults,
    ...(family.id === 'flux' && SCHNELL.test(file) ? { steps: 4 } : {}),
    ...(family.id === 'flux2' && KLEIN_BASE.test(file) ? { steps: 20, guidance: 5 } : {}),
    sampler: samplers.length === 0 || samplers.includes(family.defaults.sampler) ? family.defaults.sampler : 'euler',
    scheduler: schedulers.length === 0 || schedulers.includes(family.defaults.scheduler) ? family.defaults.scheduler : 'simple',
  };
  const edit = family.id !== 'flux2' || !!info.ReferenceLatent;
  const loras = choices(info.LoraLoader, 'lora_name');
  return {
    family: family.id,
    promptStyle: family.promptStyle,
    negativePrompt: family.negativePrompt,
    sizes: family.sizes,
    maxCount: 4,
    edit,
    mask: family.mask,
    maxReferences: edit ? family.maxReferences : 0,
    transparent: false,
    seed: true,
    previews: true,
    tunable: true,
    defaults,
    ...(samplers.length ? { samplers } : {}),
    ...(schedulers.length ? { schedulers } : {}),
    ...(loras.length ? { loras } : {}),
  };
}

export function sourceOf(file: string, info: ObjectInfo): ModelSource | null {
  if (choices(info.CheckpointLoaderSimple, 'ckpt_name').includes(file)) return 'checkpoint';
  return choices(info.UNETLoader, 'unet_name').includes(file) ? 'unet' : null;
}

/** Every checkpoint and diffusion model file with a recipe, then the imported workflows. */
export function discoverModels(instance: ImageInstance, info: ObjectInfo): ListedImageModel[] {
  const listed = (modelId: string, displayName: string, capabilities: ImageCapabilities, description?: string): ListedImageModel => ({
    ref: modelRef(instance.id, modelId),
    providerId: instance.id,
    modelId,
    displayName,
    capabilities,
    source: 'detected',
    ...(description ? { description } : {}),
  });
  const files: [string, ModelSource][] = [...choices(info.CheckpointLoaderSimple, 'ckpt_name').map((f): [string, ModelSource] => [f, 'checkpoint']), ...choices(info.UNETLoader, 'unet_name').map((f): [string, ModelSource] => [f, 'unet'])];
  const models = files
    .flatMap(([file, source]) => {
      const id = detectFamily(file, source);
      if (!id) return [];
      const family = FAMILIES[id];
      if (family.needs.some((node) => !info[node]) || !stackFor(id, file, source, info)) return [];
      return [{ id, model: listed(file, displayName(file), capabilities(family, file, info), family.label) }];
    })
    .sort((a, b) => LISTING_ORDER.indexOf(a.id) - LISTING_ORDER.indexOf(b.id))
    .map((entry) => entry.model);
  const samplers = choices(info.KSampler, 'sampler_name');
  const workflows = instance.workflows.map((w) => listed(workflowModelId(w), w.name, workflowCapabilities(w, samplers)));
  return [...models, ...workflows];
}
