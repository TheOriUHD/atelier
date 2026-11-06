/**
 * Video models described by their own input schemas (OpenAPI/JSON Schema, as fal and Replicate publish them). Every
 * endpoint has its own input: `duration` is a string on one and a number on the next, the first frame is
 * `start_image_url` or `image`, a resolution is `720p` or `720P`. So nothing here is a table of models: the
 * capabilities and the request body are both worked out from the schema, and an unknown field never matters.
 */
import type { ImageCapabilities } from '@atelier/protocol';
import { arr, dataUrl, isRecord, num, rec, str } from '../../providers/util.ts';
import type { ImageRequest } from '../types.ts';
import { hostedVideo, usualSeconds } from './video-common.ts';

export interface Field {
  type?: string | undefined;
  enum?: (string | number)[] | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  maxLength?: number | undefined;
  default?: unknown;
}

export interface VideoInputSchema {
  fields: Record<string, Field>;
  required: string[];
  /** The wire names of the inputs, when the endpoint has them. */
  duration?: string;
  firstFrame?: string;
  lastFrame?: string;
  audio?: string;
}

/** The names services give an input, in the order they are tried. */
export interface InputNames {
  duration: string[];
  firstFrame: string[];
  lastFrame: string[];
  audio: string[];
}

/** Values that mean "you choose", which isn't a size or a length. */
const AUTO = new Set(['auto', 'adaptive']);

/** One property of the schema, with `$ref`s followed and a nullable `anyOf` or a single-entry `allOf` reduced to its real alternative. */
export function field(raw: unknown, schemas: Record<string, unknown>, depth = 0): Field {
  const prop = rec(raw);
  const ref = str(prop.$ref);
  if (ref && depth < 4) return field(schemas[ref.split('/').at(-1)!], schemas, depth + 1);
  const alternatives = arr(prop.anyOf).concat(arr(prop.oneOf), arr(prop.allOf)).map(rec).filter((a) => a.type !== 'null');
  const inner = alternatives.length && depth < 4 ? field(alternatives[0], schemas, depth + 1) : undefined;
  const values = arr(prop.enum).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
  return {
    type: str(prop.type) ?? inner?.type,
    enum: values.length ? values : inner?.enum,
    minimum: num(prop.minimum) ?? inner?.minimum,
    maximum: num(prop.maximum) ?? inner?.maximum,
    maxLength: num(prop.maxLength) ?? inner?.maxLength,
    default: prop.default ?? inner?.default,
  };
}

/** Reads an input schema's `properties` and `required`; null when it has no properties. */
export function readInputs(input: Record<string, unknown>, schemas: Record<string, unknown>, names: InputNames): VideoInputSchema | null {
  if (!isRecord(input.properties)) return null;
  const fields: Record<string, Field> = {};
  for (const [name, prop] of Object.entries(input.properties)) fields[name] = field(prop, schemas);
  const pick = (candidates: string[]) => candidates.find((n) => n in fields);
  const duration = pick(names.duration);
  const firstFrame = pick(names.firstFrame);
  const lastFrame = pick(names.lastFrame);
  const audio = pick(names.audio);
  return { fields, required: arr(input.required).map(String), ...(duration ? { duration } : {}), ...(firstFrame ? { firstFrame } : {}), ...(lastFrame ? { lastFrame } : {}), ...(audio ? { audio } : {}) };
}

/** Whole numbers an enum lists, from numbers or numeric strings (`"5"`). */
const numbersOf = (values: (string | number)[]): number[] => values.map((v) => (typeof v === 'number' ? v : Number(v))).filter((n) => Number.isFinite(n) && n > 0);
const namesOf = (values: (string | number)[] | undefined): string[] => (values ?? []).map(String).filter((v) => !AUTO.has(v.toLowerCase()));

export function videoCapabilities(schema: VideoInputSchema, family: string): ImageCapabilities {
  const duration = schema.duration ? schema.fields[schema.duration] : undefined;
  let durations: { kind: 'list'; seconds: number[] } | { kind: 'range'; min: number; max: number; step?: number };
  if (duration?.enum && numbersOf(duration.enum).length) durations = { kind: 'list', seconds: numbersOf(duration.enum).sort((a, b) => a - b) };
  else if (duration?.minimum !== undefined && duration.maximum !== undefined) durations = { kind: 'range', min: duration.minimum, max: duration.maximum, ...(duration.type === 'integer' ? { step: 1 } : {}) };
  else durations = { kind: 'list', seconds: [numbersOf([duration?.default as number ?? 5])[0] ?? 5] };
  const seconds = durations.kind === 'list' ? durations.seconds : [Math.max(durations.min, Math.min(durations.max, 5))];
  const fps = numbersOf(schema.fields.fps?.enum ?? []);
  return hostedVideo({
    family,
    ratios: namesOf(schema.fields.aspect_ratio?.enum),
    resolutions: namesOf(schema.fields.resolution?.enum),
    durations,
    defaultSeconds: usualSeconds(seconds),
    firstFrame: !!schema.firstFrame,
    lastFrame: !!schema.lastFrame,
    firstFrameRequired: !!schema.firstFrame && schema.required.includes(schema.firstFrame),
    audio: schema.audio ? 'optional' : 'none',
    seed: 'seed' in schema.fields,
    negativePrompt: 'negative_prompt' in schema.fields,
    ...(fps.length ? { fps, defaultFps: numbersOf([schema.fields.fps?.default as number])[0] ?? fps[0]! } : {}),
  });
}

/** The value of `want` as the enum spells it (`720P`), or `want` when the field lists nothing. */
function spelled(f: Field | undefined, want: string): string {
  return f?.enum?.map(String).find((v) => v.toLowerCase() === want.toLowerCase()) ?? want;
}

/**
 * The request body for this endpoint: only fields its schema has, in the types it has them. `frame` turns a first or
 * last frame into the value the service takes (a data URL by default).
 */
export function videoBody(schema: VideoInputSchema, request: ImageRequest, frame: (image: NonNullable<NonNullable<ImageRequest['video']>['firstFrame']>) => unknown = (image) => dataUrl(image.mime, image.bytes)): Record<string, unknown> {
  const video = request.video!;
  const { fields } = schema;
  const body: Record<string, unknown> = { prompt: request.prompt };
  const duration = schema.duration ? fields[schema.duration] : undefined;
  if (schema.duration) {
    // A string on the endpoints whose lengths are strings.
    const asString = duration?.type === 'string' || duration?.enum?.some((v) => typeof v === 'string' && !AUTO.has(v));
    body[schema.duration] = asString ? String(video.seconds) : video.seconds;
  }
  if (video.resolution && fields.resolution) body.resolution = spelled(fields.resolution, video.resolution);
  if (request.aspectRatio && fields.aspect_ratio) body.aspect_ratio = spelled(fields.aspect_ratio, request.aspectRatio);
  if (video.fps !== undefined && fields.fps) body.fps = video.fps;
  if (schema.audio && video.audio !== undefined) body[schema.audio] = video.audio;
  if (request.seed !== undefined && fields.seed) body.seed = request.seed;
  if (request.negativePrompt && fields.negative_prompt) body.negative_prompt = request.negativePrompt;
  if (video.firstFrame && schema.firstFrame) body[schema.firstFrame] = frame(video.firstFrame);
  if (video.lastFrame && schema.lastFrame) body[schema.lastFrame] = frame(video.lastFrame);
  // A required input that has a default must still be sent (MiniMax's `prompt_expansion_mode`); the service says nothing helpful when it is missing.
  for (const name of schema.required) if (!(name in body) && fields[name]?.default !== undefined) body[name] = fields[name]!.default;
  return body;
}
