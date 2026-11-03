/** What the video dialects share: capability shapes, a usual length, resolution order, and reading a finished clip off a service that wants the key. */
import type { ImageCapabilities, ImageSizes, VideoCapabilities } from '@atelier/protocol';
import { HOSTED_DEFAULTS } from '../catalog.ts';
import { MAX_VIDEO_BYTES } from '../video.ts';
import { shortSide } from '../video-params.ts';

/** The length used when nobody names one: 5 seconds if the model makes it, else the nearest above, else its longest. */
export function usualSeconds(seconds: readonly number[]): number {
  const sorted = [...seconds].sort((a, b) => a - b);
  return sorted.find((s) => s >= 5) ?? sorted.at(-1)!;
}

/** Resolution names from small to large (`480p`, `720p`, `1080p`, `2K`, `4K`), whatever order a service lists them in. */
export function sortResolutions(names: readonly string[]): string[] {
  return [...names].sort((a, b) => (shortSide(a) ?? 0) - (shortSide(b) ?? 0));
}

/** A hosted video model: shapes by ratio and resolution name, one clip at a time. */
export function hostedVideo(options: {
  family: string;
  ratios: readonly string[];
  resolutions?: readonly string[] | undefined;
  durations: VideoCapabilities['durations'];
  defaultSeconds: number;
  firstFrame: boolean;
  lastFrame?: boolean;
  firstFrameRequired?: boolean;
  audio: VideoCapabilities['audio'];
  seed?: boolean;
  negativePrompt?: boolean;
  fps?: readonly number[];
  defaultFps?: number;
}): ImageCapabilities {
  const resolutions = options.resolutions?.length ? sortResolutions(options.resolutions) : undefined;
  const sizes: ImageSizes = { kind: 'aspect', ratios: options.ratios.length ? [...options.ratios] : ['16:9'], classes: resolutions ?? [] };
  return {
    ...HOSTED_DEFAULTS,
    family: options.family,
    output: 'video',
    sizes,
    seed: options.seed ?? false,
    negativePrompt: options.negativePrompt ?? false,
    video: {
      durations: options.durations,
      defaultSeconds: options.defaultSeconds,
      ...(resolutions ? { resolutions } : {}),
      ...(options.fps?.length ? { fps: [...options.fps] } : {}),
      ...(options.defaultFps ? { defaultFps: options.defaultFps } : {}),
      firstFrame: options.firstFrame,
      lastFrame: options.firstFrame && (options.lastFrame ?? false),
      ...(options.firstFrameRequired ? { firstFrameRequired: true } : {}),
      audio: options.audio,
    },
  };
}

/**
 * A finished clip's bytes from a service that needs the key to hand it over. Only called with an address on the
 * service's own host (`assertOwnHost`), because the key goes along. Refuses what is larger than a clip may be.
 */
export async function readClip(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) throw new Error(`The video is larger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_VIDEO_BYTES) throw new Error(`The video is larger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
  return bytes;
}
