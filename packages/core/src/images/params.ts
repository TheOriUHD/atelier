/**
 * Fits what the text model asked for to what the image model takes (ARCHITECTURE §23). The tool speaks in aspect
 * ratios and size names so one call works everywhere; this turns them into exact pixels, and says what it had to drop.
 */
import type { ImageCapabilities, ImageSize, ImageSizes, ImageTuning } from '@atelier/protocol';
import type { ImageQuality } from './types.ts';

export type SizeName = 'small' | 'medium' | 'large';

export interface ImageAsk {
  aspectRatio?: string | undefined;
  size?: SizeName | undefined;
  count?: number | undefined;
  quality?: ImageQuality | undefined;
  negativePrompt?: string | undefined;
  seed?: number | undefined;
  transparent?: boolean | undefined;
  tuning?: ImageTuning | undefined;
  loras?: { name: string; weight?: number }[] | undefined;
  references?: number | undefined;
  mask?: boolean | undefined;
}

export interface FittedParams {
  width?: number;
  height?: number;
  aspectRatio?: string;
  sizeClass?: string;
  count: number;
  quality: ImageQuality;
  negativePrompt?: string;
  seed?: number;
  transparent?: boolean;
  tuning: ImageTuning;
  loras: { name: string; weight: number }[];
  /** How many of the input images it can take. */
  references: number;
  mask: boolean;
  /** What the model can't do, for the tool's answer. */
  notes: string[];
}

const SIDE_SCALE: Record<SizeName, number> = { small: 0.75, medium: 1, large: 1.5 };

/** "16:9" as a number; null when it isn't a ratio. */
export function parseRatio(ratio: string | undefined): number | null {
  const match = ratio?.trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const value = Number(match[1]) / Number(match[2]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const roundTo = (value: number, multiple: number) => Math.max(multiple, Math.round(value / multiple) * multiple);

/** The pixel size for a ratio on a model that takes any size: around its native area, rounded to what it accepts. */
export function freeSize(sizes: Extract<ImageSizes, { kind: 'free' }>, ratio: number, size: SizeName): ImageSize {
  const side = sizes.base * SIDE_SCALE[size];
  let width = side * Math.sqrt(ratio);
  let height = side / Math.sqrt(ratio);
  // Keep the ratio when a side hits a limit, instead of squashing it towards a square.
  const over = Math.max(width / sizes.max, height / sizes.max, 1);
  width /= over;
  height /= over;
  const under = Math.max(sizes.min / width, sizes.min / height, 1);
  width = Math.min(width * under, sizes.max);
  height = Math.min(height * under, sizes.max);
  const clamp = (v: number) => {
    const rounded = roundTo(v, sizes.multiple);
    return rounded > sizes.max ? Math.floor(sizes.max / sizes.multiple) * sizes.multiple : rounded;
  };
  return { width: clamp(width), height: clamp(height) };
}

/** The listed size closest in shape, then closest to the size asked for. */
export function fixedSize(list: readonly ImageSize[], ratio: number, size: SizeName): ImageSize {
  const shape = (s: ImageSize) => Math.abs(Math.log(s.width / s.height / ratio));
  const best = Math.min(...list.map(shape));
  const closest = list.filter((s) => shape(s) <= best + 0.02).sort((a, b) => a.width * a.height - b.width * b.height);
  return closest[size === 'small' ? 0 : size === 'large' ? closest.length - 1 : Math.floor((closest.length - 1) / 2)]!;
}

/** The ratio in `ratios` closest to `ratio`. */
export function closestRatio(ratios: readonly string[], ratio: number): string {
  const distance = (r: string) => Math.abs(Math.log((parseRatio(r) ?? 1) / ratio));
  return [...ratios].sort((a, b) => distance(a) - distance(b))[0]!;
}

/** The size name closest to `small`, `medium` or `large`, as the model calls it. */
function sizeClass(classes: readonly string[], size: SizeName): string | undefined {
  if (classes.length === 0) return undefined;
  const named = classes.find((c) => c.toLowerCase() === size);
  if (named) return named;
  return classes[size === 'small' ? 0 : size === 'large' ? classes.length - 1 : Math.floor((classes.length - 1) / 2)];
}

export function fitParams(capabilities: ImageCapabilities, ask: ImageAsk, tuning: ImageTuning = {}): FittedParams {
  const notes: string[] = [];
  const ratio = parseRatio(ask.aspectRatio) ?? 1;
  if (ask.aspectRatio && parseRatio(ask.aspectRatio) === null) notes.push(`"${ask.aspectRatio}" isn't an aspect ratio, so it's square.`);
  const size: SizeName = ask.size ?? 'medium';
  const out: FittedParams = {
    count: Math.max(1, Math.min(ask.count ?? 1, capabilities.maxCount)),
    quality: ask.quality ?? 'standard',
    tuning: {},
    loras: [],
    references: 0,
    mask: false,
    notes,
  };
  if ((ask.count ?? 1) > capabilities.maxCount) notes.push(`This model makes ${capabilities.maxCount} at a time.`);

  const sizes = capabilities.sizes;
  if (sizes.kind === 'free') Object.assign(out, freeSize(sizes, ratio, size));
  else if (sizes.kind === 'fixed') Object.assign(out, fixedSize(sizes.list, ratio, size));
  else {
    out.aspectRatio = closestRatio(sizes.ratios, ratio);
    const named = sizeClass(sizes.classes, size);
    if (named) out.sizeClass = named;
  }

  if (ask.negativePrompt) {
    if (capabilities.negativePrompt) out.negativePrompt = ask.negativePrompt;
    else notes.push('This model takes no negative prompt, so it was left out.');
  }
  if (ask.seed !== undefined) {
    if (capabilities.seed) out.seed = ask.seed;
    else notes.push("This model can't repeat a seed.");
  }
  if (ask.transparent) {
    if (capabilities.transparent) out.transparent = true;
    else notes.push("This model can't make a transparent background.");
  }

  // The call wins over the person's settings for the model, and both over what the model works best with.
  if (capabilities.tunable) {
    out.tuning = { ...capabilities.defaults, ...tuning, ...ask.tuning };
    const { sampler, scheduler } = out.tuning;
    if (sampler && capabilities.samplers && !capabilities.samplers.includes(sampler)) {
      notes.push(`Sampler "${sampler}" isn't available here.`);
      delete out.tuning.sampler;
      if (capabilities.defaults?.sampler) out.tuning.sampler = capabilities.defaults.sampler;
    }
    if (scheduler && capabilities.schedulers && !capabilities.schedulers.includes(scheduler)) {
      notes.push(`Scheduler "${scheduler}" isn't available here.`);
      delete out.tuning.scheduler;
      if (capabilities.defaults?.scheduler) out.tuning.scheduler = capabilities.defaults.scheduler;
    }
  } else if (ask.tuning && Object.keys(ask.tuning).length) notes.push('This model takes no sampling settings.');

  for (const lora of ask.loras ?? []) {
    if (capabilities.loras?.includes(lora.name)) out.loras.push({ name: lora.name, weight: lora.weight ?? 1 });
    else notes.push(`LoRA "${lora.name}" isn't available here.`);
  }

  const wanted = ask.references ?? 0;
  if (wanted > 0) {
    if (!capabilities.edit) notes.push("This model can't use input images, so they were left out.");
    else {
      out.references = Math.min(wanted, capabilities.maxReferences);
      if (out.references < wanted) notes.push(`This model takes ${capabilities.maxReferences} input ${capabilities.maxReferences === 1 ? 'image' : 'images'}.`);
    }
  }
  if (ask.mask) {
    if (capabilities.mask) out.mask = true;
    else notes.push("This model can't change one area, so the mask was left out.");
  }
  return out;
}
