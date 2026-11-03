/**
 * Fits what the text model asked for a clip to what the video model takes (ARCHITECTURE §23), as `params.ts` does for
 * images: it reuses that fit for shape, seed and negative prompt, and adds the length, frame rate, resolution, sound
 * and the frames to start and end on. Whatever a model can't do is dropped and said, so one tool call works everywhere.
 */
import type { ImageCapabilities, VideoCapabilities, VideoDurations } from '@atelier/protocol';
import { fitParams, parseRatio, type FittedParams, type SizeName } from './params.ts';

export interface VideoAsk {
  seconds?: number | undefined;
  aspectRatio?: string | undefined;
  /** A resolution by name, like `720p`. */
  resolution?: string | undefined;
  size?: SizeName | undefined;
  audio?: boolean | undefined;
  fps?: number | undefined;
  seed?: number | undefined;
  negativePrompt?: string | undefined;
  firstFrame?: boolean | undefined;
  lastFrame?: boolean | undefined;
}

/** What a person set for one model, used when the call says nothing. */
export interface VideoDefaults {
  seconds?: number | undefined;
  fps?: number | undefined;
  resolution?: string | undefined;
}

export interface FittedVideo extends Omit<FittedParams, 'references' | 'mask' | 'transparent' | 'loras' | 'quality'> {
  seconds: number;
  fps?: number;
  /** The name, for models that take names. */
  resolution?: string;
  /** Set only for a model that can switch sound; the sound of one that can't is its own. */
  audio?: boolean;
  firstFrame: boolean;
  lastFrame: boolean;
}

export class NotAVideoModel extends Error {}

/** The model's video side, or an error: callers hold an image model by mistake only if a registry is wrong. */
export function videoOf(capabilities: ImageCapabilities): VideoCapabilities {
  if (capabilities.output !== 'video' || !capabilities.video) throw new NotAVideoModel('That model makes images, not video.');
  return capabilities.video;
}

const MULTIPLE_OF = (value: number, base: number) => Math.round(value / base) * base;

/** The length closest to `wanted` that the model makes; the shorter one when two are as close, because longer costs more. */
export function fitSeconds(durations: VideoDurations, wanted: number): number {
  if (durations.kind === 'list') {
    return [...durations.seconds].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b)[0]!;
  }
  const clamped = Math.min(durations.max, Math.max(durations.min, wanted));
  if (!durations.step) return Math.round(clamped * 100) / 100;
  const snapped = durations.min + MULTIPLE_OF(clamped - durations.min, durations.step);
  return Math.round(Math.min(durations.max, Math.max(durations.min, snapped)) * 100) / 100;
}

/** The shortest side in pixels a resolution name stands for: `720p` is 720, `1k` is 1024. */
export function shortSide(name: string): number | null {
  const match = /^(\d+)\s*p$/i.exec(name.trim());
  if (match) return Number(match[1]);
  const k = /^(\d+)\s*k$/i.exec(name.trim());
  return k ? Number(k[1]) * 1024 : null;
}

const nearestOf = (list: readonly number[], wanted: number) => [...list].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b)[0]!;

/** A resolution name from the list that matches `wanted`, ignoring case (`720P` and `720p` are one). */
const namedResolution = (list: readonly string[], wanted: string | undefined) => (wanted ? list.find((r) => r.toLowerCase() === wanted.trim().toLowerCase()) : undefined);

/** The default resolution: 720p when offered, as that is where video starts to look right without costing the most, else the smallest. */
function defaultResolution(list: readonly string[]): string {
  return namedResolution(list, '720p') ?? list[0]!;
}

export function fitVideo(capabilities: ImageCapabilities, ask: VideoAsk, defaults: VideoDefaults = {}): FittedVideo {
  const video = videoOf(capabilities);
  const notes: string[] = [];
  const base = fitParams(capabilities, { aspectRatio: ask.aspectRatio ?? '16:9', size: ask.size, count: 1, negativePrompt: ask.negativePrompt, seed: ask.seed });
  notes.push(...base.notes.filter((n) => !n.startsWith('This model makes')));
  const { width, height, aspectRatio, sizeClass, negativePrompt, seed } = base;
  const out: FittedVideo = {
    count: 1,
    tuning: {},
    notes,
    seconds: 0,
    firstFrame: false,
    lastFrame: false,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(sizeClass ? { sizeClass } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(seed !== undefined ? { seed } : {}),
  };

  const wanted = ask.seconds ?? defaults.seconds ?? video.defaultSeconds;
  out.seconds = fitSeconds(video.durations, wanted);
  if (ask.seconds !== undefined && out.seconds !== ask.seconds) notes.push(`This model makes ${describeDurations(video.durations)}, so the clip is ${out.seconds} seconds.`);

  // Resolution: by name where the model has names, else by the short side in pixels on a model with free sizes.
  const names = video.resolutions;
  const asked = ask.resolution ?? (ask.size === undefined ? defaults.resolution : undefined);
  if (names?.length) {
    const found = namedResolution(names, asked);
    out.resolution = found ?? (ask.size ? names[ask.size === 'small' ? 0 : ask.size === 'large' ? names.length - 1 : Math.floor((names.length - 1) / 2)] : undefined) ?? defaultResolution(names);
    if (ask.resolution && !found) notes.push(`This model has ${names.join(', ')}, so the clip is ${out.resolution}.`);
    if (capabilities.sizes.kind === 'aspect') out.sizeClass = out.resolution;
  } else if (ask.resolution && capabilities.sizes.kind === 'free') {
    const side = shortSide(ask.resolution);
    const sizes = capabilities.sizes;
    if (side) {
      const ratio = parseRatio(ask.aspectRatio) ?? 16 / 9;
      const wide = ratio >= 1;
      const fitted = (value: number) => Math.min(sizes.max, Math.max(sizes.min, MULTIPLE_OF(value, sizes.multiple)));
      out.width = fitted(wide ? side * ratio : side);
      out.height = fitted(wide ? side : side / ratio);
    }
  } else if (ask.resolution) notes.push('This model makes one frame size, so the resolution was left out.');

  if (video.fps?.length) {
    const wantedFps = ask.fps ?? defaults.fps ?? video.defaultFps ?? video.fps[0]!;
    out.fps = nearestOf(video.fps, wantedFps);
    if (ask.fps !== undefined && out.fps !== ask.fps) notes.push(`This model makes ${video.fps.join(', ')} frames per second, so it's ${out.fps}.`);
  } else if (ask.fps !== undefined) notes.push("This model's frame rate is fixed, so the one asked for was left out.");
  else if (video.defaultFps) out.fps = video.defaultFps;

  if (video.audio === 'optional') out.audio = ask.audio ?? false;
  else if (ask.audio === true && video.audio === 'none') notes.push('This model makes silent video.');
  else if (ask.audio === false && video.audio === 'always') notes.push("This model's sound can't be turned off.");

  if (ask.firstFrame) {
    if (video.firstFrame) out.firstFrame = true;
    else notes.push("This model can't start from an image, so the first frame was left out.");
  }
  if (ask.lastFrame) {
    if (!video.lastFrame) notes.push("This model can't end on an image, so the last frame was left out.");
    else if (!out.firstFrame) notes.push('A last frame needs a first frame, so it was left out.');
    else out.lastFrame = true;
  }
  return out;
}

export function describeDurations(durations: VideoDurations): string {
  if (durations.kind === 'list') return `${durations.seconds.join(', ')} seconds`;
  return `${durations.min} to ${durations.max} seconds${durations.step ? ` in steps of ${durations.step}` : ''}`;
}
