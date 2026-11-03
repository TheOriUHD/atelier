/**
 * SwarmUI video, from its source (read on 2026-11-03 at github.com/mcmonkeyprojects/SwarmUI: src/Text2Image/T2IParamTypes.cs,
 * T2IModelClass.cs, src/WebAPI/T2IAPI.cs and docs/Video Model Support.md). A parameter's id is its display name in
 * lowercase letters only, so "Text2Video Frames" is `textvideoframes`. Two flows:
 *
 * - text to video: `model` is a model of a text-to-video class, and `textvideoframes` says how long;
 * - image to video: `videomodel` is a model of an image-to-video class, the picture is `initimage` with creativity 0
 *   (which skips the image model), `videoframes` says how long, and `videoendimage` is the last frame for models that
 *   take one (Wan FLF2V, LTX-V).
 *
 * Whether the server runs these end to end is not verified here: no Swarm with a video model was available.
 */
import type { ImageCapabilities } from '@atelier/protocol';
import { dataUrl, num, rec, str } from '../../providers/util.ts';
import type { ImageRequest } from '../types.ts';
import { hostedVideo } from './video-common.ts';

/** What Swarm's `ListT2IParams` says about a model class, and the compat class it belongs to. */
export interface SwarmClasses {
  /** class id → its compat class id */
  compat: Map<string, string>;
  /** compat class id → what the class makes */
  flags: Map<string, { text: boolean; image: boolean }>;
}

export function readClasses(params: unknown): SwarmClasses {
  const compat = new Map<string, string>();
  const flags = new Map<string, { text: boolean; image: boolean }>();
  for (const [id, entry] of Object.entries(rec(rec(params).model_classes))) {
    const parent = str(rec(entry).compat_class);
    if (parent) compat.set(id, parent);
  }
  for (const [id, entry] of Object.entries(rec(rec(params).model_compat_classes))) {
    const c = rec(entry);
    flags.set(id, { text: c.is_text2video === true, image: c.is_image2video === true });
  }
  return { compat, flags };
}

/** Frames per second Swarm's docs name for these models (Wan, Hunyuan and LTX-V all default to 24). */
const FPS = 24;

export interface SwarmVideoKind {
  /** Makes video from words alone. */
  text: boolean;
  /** Makes video from a picture. */
  image: boolean;
  /** Takes a last frame: Wan's first-last-frame model and LTX-V. */
  lastFrame: boolean;
}

/** What a model file makes, by its architecture; null for a picture model. */
export function videoKind(architecture: string | undefined, classes: SwarmClasses): SwarmVideoKind | null {
  if (!architecture) return null;
  const flags = classes.flags.get(classes.compat.get(architecture) ?? '');
  if (!flags || (!flags.text && !flags.image)) return null;
  return { text: flags.text, image: flags.image, lastFrame: /flf2v|ltx/i.test(architecture) };
}

export function swarmVideoCapabilities(kind: SwarmVideoKind, standard: { width: number; height: number }): ImageCapabilities {
  const caps = hostedVideo({
    family: 'swarm-video',
    ratios: [],
    durations: { kind: 'range', min: 1, max: 10, step: 1 },
    defaultSeconds: 3,
    firstFrame: kind.image,
    lastFrame: kind.lastFrame,
    firstFrameRequired: kind.image && !kind.text,
    audio: 'none',
    seed: true,
    negativePrompt: true,
    defaultFps: FPS,
  });
  const side = standard.width > 0 && standard.height > 0 ? Math.round(Math.sqrt(standard.width * standard.height)) : 640;
  return { ...caps, sizes: { kind: 'free', min: 256, max: 1920, multiple: 16, base: side }, previews: true };
}

/** Frames for a length: Swarm rounds a count the model can't make, so this only has to be close. */
const framesFor = (seconds: number, fps: number) => Math.max(1, Math.round(seconds * fps));

export function swarmVideoPayload(request: ImageRequest, sessionId: string): Record<string, unknown> {
  const video = request.video!;
  const fps = video.fps ?? FPS;
  const frames = framesFor(video.seconds, fps);
  const image = !!video.firstFrame;
  return {
    session_id: sessionId,
    images: 1,
    prompt: request.prompt,
    negativeprompt: request.negativePrompt ?? '',
    ...(request.width && request.height ? { width: request.width, height: request.height } : {}),
    seed: request.seed ?? -1,
    donotsave: true,
    videofps: fps,
    videoformat: 'h264-mp4',
    ...(image
      ? {
          videomodel: request.model,
          videoframes: frames,
          initimage: dataUrl(video.firstFrame!.mime, video.firstFrame!.bytes),
          initimagecreativity: 0,
          ...(video.lastFrame ? { videoendimage: dataUrl(video.lastFrame.mime, video.lastFrame.bytes) } : {}),
        }
      : { model: request.model, textvideoframes: frames }),
  };
}

export const standardSize = (file: Record<string, unknown>) => ({ width: num(file.standard_width) ?? 0, height: num(file.standard_height) ?? 0 });
