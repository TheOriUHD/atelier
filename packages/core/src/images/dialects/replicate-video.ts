/**
 * Replicate video models, read from their own schemas: `GET /v1/models/{owner}/{name}` answers with the latest version's
 * `openapi_schema`, whose `Input` lists every field (read on 2026-11-03: https://replicate.com/docs/reference/http,
 * https://api.replicate.com/openapi.json). `video-schema.ts` turns it into capabilities and a request body.
 *
 * A picture goes in as a data URL, which Replicate documents up to 256 KB (another page says 1 MB), so the frame is
 * reduced to fit rather than trusting the larger figure or the Files API, whose docs page doesn't describe it.
 */
import type { ImageCapabilities } from '@atelier/protocol';
import { fitImage } from '../../providers/images.ts';
import { dataUrl, rec, str } from '../../providers/util.ts';
import type { ImageInput, ImageRequest } from '../types.ts';
import { readInputs, videoBody, videoCapabilities, type InputNames, type VideoInputSchema } from './video-schema.ts';

export type ReplicateVideoSchema = VideoInputSchema;

const NAMES: InputNames = {
  duration: ['duration', 'seconds'],
  firstFrame: ['image', 'start_image', 'first_frame_image', 'first_frame', 'input_image', 'input_reference'],
  lastFrame: ['last_frame', 'last_frame_image', 'end_image', 'tail_image'],
  audio: ['generate_audio'],
};

/** A data URL's limit in Replicate's docs, less what base64 adds. */
const FRAME_BYTES = 180_000;
const FRAME_SIDE = 2048;

/** The input schema out of a model answer. Null when the model has no readable one. */
export function replicateVideoSchema(model: unknown): ReplicateVideoSchema | null {
  const schemas = rec(rec(rec(rec(model).latest_version).openapi_schema).components).schemas;
  const all = rec(schemas);
  return readInputs(rec(all.Input), all, NAMES);
}

export const replicateVideoCapabilities = (schema: ReplicateVideoSchema): ImageCapabilities => videoCapabilities(schema, 'replicate-video');

/** A first or last frame as a data URL that fits Replicate’s limit; throws what the person should read when it can't. */
export function replicateFrame(image: ImageInput): string {
  const fitted = fitImage(image.bytes, image.mime, FRAME_SIDE, FRAME_BYTES);
  if (!fitted.ok) throw new Error(`The picture ${fitted.reason}, and Replicate takes only small ones inline.`);
  return dataUrl(fitted.image.mime, fitted.image.bytes);
}

export const replicateVideoInput = (schema: ReplicateVideoSchema, request: ImageRequest): Record<string, unknown> => videoBody(schema, request, replicateFrame);

export const modelDescription = (model: unknown): string | undefined => str(rec(model).description)?.slice(0, 200);
