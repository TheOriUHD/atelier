/**
 * What a checkpoint needs, read from its name. AUTOMATIC1111 and its forks list files, not architectures, so the name
 * is all there is to go on, and the sizes and settings a model was made for are what make its pictures good or melted.
 * A name that says nothing is treated as SD 1.5: its 512 pixels work on every other family, just not the other way.
 */
import type { ImageCapabilities, ImageSizes, ImageTuning } from '@atelier/protocol';
import { imageSize } from '../providers/image-size.ts';
import { freeSize } from './params.ts';
import type { ImageRequest } from './types.ts';

export type FamilyTraits = Pick<ImageCapabilities, 'family' | 'promptStyle' | 'negativePrompt' | 'sizes'> & {
  defaults: ImageTuning;
};

const free = (base: number, multiple = 8): ImageSizes => ({ kind: 'free', min: 256, max: 2048, multiple, base });

const tags = (family: string, base: number, defaults: ImageTuning, negativePrompt = true): FamilyTraits => ({ family, promptStyle: 'tags', negativePrompt, sizes: free(base), defaults });
const natural = (family: string, base: number, multiple: number, defaults: ImageTuning, negativePrompt = false): FamilyTraits => ({ family, promptStyle: 'natural', negativePrompt, sizes: free(base, multiple), defaults });

/** "hyper" alone would catch every hyperrealism checkpoint. */
const DISTILLED = '(?:dmd|lightning|hyper[-_ ]?sd|turbo|lcm|tcd)';
const FLUX_SAMPLING: ImageTuning = { guidance: 1, sampler: 'Euler', scheduler: 'Simple' };

/**
 * First match wins, so a name that contains another family's marker comes before it. Distilled models run at a guidance
 * of about 1, where a negative prompt does nothing, so they don't claim to take one.
 */
const FAMILIES: readonly (readonly [RegExp, FamilyTraits])[] = [
  [/klein/i, natural('flux2', 1024, 16, { ...FLUX_SAMPLING, steps: 4 })],
  [/flux[-_. ]?2/i, natural('flux2', 1024, 16, { ...FLUX_SAMPLING, steps: 28 })],
  [/schnell/i, natural('flux', 1024, 16, { ...FLUX_SAMPLING, steps: 4 })],
  [/flux/i, natural('flux', 1024, 16, { ...FLUX_SAMPLING, steps: 20 })],
  [/z[-_. ]?image/i, natural('z-image', 1024, 16, { ...FLUX_SAMPLING, steps: 8 })],
  [/sd[-_. ]?3|stable[-_ ]?diffusion[-_ ]?v?3/i, natural('sd3', 1024, 16, { steps: 28, guidance: 4.5, sampler: 'Euler' }, true)],
  // SDXL Turbo was trained at 512 pixels, unlike the rest of SDXL.
  [/xl[-_ ]?turbo/i, tags('sdxl-distilled', 512, { steps: 4, guidance: 1, sampler: 'Euler a' }, false)],
  [/sd[-_. ]?turbo/i, tags('sd-turbo', 512, { steps: 4, guidance: 1, sampler: 'Euler a' }, false)],
  [new RegExp(`xl.*${DISTILLED}|${DISTILLED}.*xl`, 'i'), tags('sdxl-distilled', 1024, { steps: 8, guidance: 1, sampler: 'DPM++ SDE' }, false)],
  [new RegExp(DISTILLED, 'i'), tags('sd15-distilled', 512, { steps: 6, guidance: 1.5, sampler: 'Euler a' }, false)],
  [/xl|illustrious|noob|pony|animagine/i, tags('sdxl', 1024, { steps: 30, guidance: 6, sampler: 'DPM++ 2M SDE', scheduler: 'Karras' })],
  [/sd[-_. ]?2|stable[-_ ]?diffusion[-_ ]?v?2|v2-1/i, tags('sd2', 768, { steps: 25, guidance: 7, sampler: 'DPM++ 2M', scheduler: 'Karras' })],
];

const SD15 = tags('sd15', 512, { steps: 25, guidance: 7, sampler: 'DPM++ 2M', scheduler: 'Karras' });

export function checkpointFamily(name: string): FamilyTraits {
  return FAMILIES.find(([match]) => match.test(name))?.[1] ?? SD15;
}

/** "models/sd/dreamshaper_8.safetensors [879db523c3]" as "dreamshaper_8". */
export function checkpointLabel(name: string): string {
  return name
    .replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '')
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(?:safetensors|ckpt|gguf|pth?|sft|bin)$/i, '');
}

const spelling = (name: string) => name.toLowerCase().replace(/[\s_-]/g, '');

/** The sampler a server calls `wanted`, in its own spelling, when it has it: "Euler a" is `euler_a` on sd-server. */
export function pickName(list: readonly string[] | undefined, wanted: string | undefined): string | undefined {
  if (!wanted) return undefined;
  return list?.find((name) => spelling(name) === spelling(wanted));
}

/** Past this, a picture is more than the model can work on well, as `large` is in `params.ts`. */
const EDIT_MAX_SCALE = 1.5;

/**
 * The size for an edit. `params.ts` only knows what the text model asked for, and its default is a square; only the
 * adapter has the image. Changing a picture shouldn't resize it, so it keeps its own size where the model can work at
 * that, and otherwise its shape at the size the model was made for: a phone photo would be too much for SD 1.5.
 */
export function editSize(request: Pick<ImageRequest, 'references' | 'width' | 'height' | 'capabilities'>): { width?: number; height?: number } {
  const given = { ...(request.width ? { width: request.width } : {}), ...(request.height ? { height: request.height } : {}) };
  const input = request.references[0];
  const size = input ? imageSize(input.bytes) : null;
  const { sizes } = request.capabilities;
  if (!size || size.width === 0 || size.height === 0 || sizes.kind !== 'free') return given;
  const { width, height } = size;
  if (Math.max(width, height) > sizes.base * EDIT_MAX_SCALE || Math.min(width, height) < sizes.min) return freeSize(sizes, width / height, 'medium');
  const nearest = (side: number) => Math.max(sizes.multiple, Math.round(side / sizes.multiple) * sizes.multiple);
  return { width: nearest(width), height: nearest(height) };
}
