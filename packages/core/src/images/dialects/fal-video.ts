/**
 * fal.ai video models, read from their own schemas. fal's models API hands out each endpoint's OpenAPI input schema
 * (`GET https://api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0`, read on 2026-11-03); `video-schema.ts` turns it
 * into capabilities and a request body.
 */
import type { ImageCapabilities } from '@atelier/protocol';
import { rec, str } from '../../providers/util.ts';
import type { ImageRequest } from '../types.ts';
import { readInputs, videoBody, videoCapabilities, type InputNames, type VideoInputSchema } from './video-schema.ts';

export type FalVideoSchema = VideoInputSchema;

const NAMES: InputNames = {
  duration: ['duration'],
  firstFrame: ['start_image_url', 'image_url', 'first_frame_image_url', 'first_frame_url', 'input_image_url'],
  lastFrame: ['end_image_url', 'tail_image_url', 'last_frame_image_url', 'last_frame_url'],
  audio: ['generate_audio', 'audio', 'enable_audio'],
};

/** The input schema of the endpoint's POST, from a model entry of fal's models API. Null when the entry has none. */
export function falVideoSchema(entry: unknown): FalVideoSchema | null {
  const openapi = rec(rec(entry).openapi);
  const schemas = rec(rec(openapi.components).schemas);
  for (const path of Object.values(rec(openapi.paths))) {
    const json = rec(rec(rec(rec(path).post).requestBody).content)['application/json'];
    const ref = str(rec(rec(json).schema).$ref);
    const schema = ref ? readInputs(rec(schemas[ref.split('/').at(-1)!]), schemas, NAMES) : null;
    if (schema) return schema;
  }
  return null;
}

export const falVideoCapabilities = (schema: FalVideoSchema): ImageCapabilities => videoCapabilities(schema, 'fal-video');
export const falVideoBody = (schema: FalVideoSchema, request: ImageRequest): Record<string, unknown> => videoBody(schema, request);
