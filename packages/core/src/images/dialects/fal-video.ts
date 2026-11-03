/**
 * fal.ai video models, read from their own schemas. Every fal video endpoint has its own input: `duration` is a string
 * on one and a number on the next, the first frame is `start_image_url` or `image_url`, a resolution is `720p` or `720P`.
 * So nothing here is a table of models: fal's models API hands out each endpoint's OpenAPI input schema
 * (`GET https://api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0`, read on 2026-11-03), and the capabilities and
 * the request body are both worked out from it. A model's name or an unknown field never matters.
 */
import { dataUrl, arr, isRecord, num, rec, str } from '../../providers/util.ts';
import type { ImageCapabilities } from '@atelier/protocol';
import type { ImageRequest } from '../types.ts';
import { hostedVideo, usualSeconds } from './video-common.ts';

interface Field {
  type?: string | undefined;
  enum?: (string | number)[] | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  default?: unknown;
}

export interface FalVideoSchema {
  fields: Record<string, Field>;
  required: string[];
  /** The wire names of the inputs, when the endpoint has them. */
  firstFrame?: string;
  lastFrame?: string;
  audio?: string;
}

const FIRST_FRAME = ['start_image_url', 'image_url', 'first_frame_image_url', 'first_frame_url', 'input_image_url'];
const LAST_FRAME = ['end_image_url', 'tail_image_url', 'last_frame_image_url', 'last_frame_url'];
const AUDIO = ['generate_audio', 'audio', 'enable_audio'];
/** Values that mean "you choose", which isn't a size or a length. */
const AUTO = new Set(['auto', 'adaptive']);

/** One property of the schema, with `$ref`s followed and a nullable `anyOf` reduced to its real alternative. */
function field(raw: unknown, schemas: Record<string, unknown>, depth = 0): Field {
  const prop = rec(raw);
  const ref = str(prop.$ref);
  if (ref && depth < 4) return field(schemas[ref.split('/').at(-1)!], schemas, depth + 1);
  const alternatives = arr(prop.anyOf).concat(arr(prop.oneOf)).map(rec).filter((a) => a.type !== 'null');
  const inner = alternatives.length ? field(alternatives[0], schemas, depth + 1) : undefined;
  const values = arr(prop.enum).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
  return {
    type: str(prop.type) ?? inner?.type,
    enum: values.length ? values : inner?.enum,
    minimum: num(prop.minimum) ?? inner?.minimum,
    maximum: num(prop.maximum) ?? inner?.maximum,
    default: prop.default ?? inner?.default,
  };
}

/** The input schema of the endpoint's POST, from a model entry of fal's models API. Null when the entry has none. */
export function falVideoSchema(entry: unknown): FalVideoSchema | null {
  const openapi = rec(rec(entry).openapi);
  const schemas = rec(rec(openapi.components).schemas);
  for (const path of Object.values(rec(openapi.paths))) {
    const json = rec(rec(rec(rec(path).post).requestBody).content)['application/json'];
    const ref = str(rec(rec(json).schema).$ref);
    const input = ref ? rec(schemas[ref.split('/').at(-1)!]) : null;
    if (!input || !isRecord(input.properties)) continue;
    const fields: Record<string, Field> = {};
    for (const [name, prop] of Object.entries(input.properties)) fields[name] = field(prop, schemas);
    const pick = (names: string[]) => names.find((n) => n in fields);
    const firstFrame = pick(FIRST_FRAME);
    const lastFrame = pick(LAST_FRAME);
    const audio = pick(AUDIO);
    return { fields, required: arr(input.required).map(String), ...(firstFrame ? { firstFrame } : {}), ...(lastFrame ? { lastFrame } : {}), ...(audio ? { audio } : {}) };
  }
  return null;
}

/** Whole numbers an enum lists, from numbers or numeric strings (`"5"`). */
const numbersOf = (values: (string | number)[]): number[] => values.map((v) => (typeof v === 'number' ? v : Number(v))).filter((n) => Number.isFinite(n) && n > 0);
const namesOf = (values: (string | number)[] | undefined): string[] => (values ?? []).map(String).filter((v) => !AUTO.has(v.toLowerCase()));

export function falVideoCapabilities(schema: FalVideoSchema): ImageCapabilities {
  const duration = schema.fields.duration;
  let durations: { kind: 'list'; seconds: number[] } | { kind: 'range'; min: number; max: number; step?: number };
  if (duration?.enum && numbersOf(duration.enum).length) durations = { kind: 'list', seconds: numbersOf(duration.enum).sort((a, b) => a - b) };
  else if (duration?.minimum !== undefined && duration.maximum !== undefined) durations = { kind: 'range', min: duration.minimum, max: duration.maximum, ...(duration.type === 'integer' ? { step: 1 } : {}) };
  else durations = { kind: 'list', seconds: [numbersOf([duration?.default as number ?? 5])[0] ?? 5] };
  const seconds = durations.kind === 'list' ? durations.seconds : [Math.max(durations.min, Math.min(durations.max, 5))];
  const fps = numbersOf(schema.fields.fps?.enum ?? []);
  const sound = schema.audio;
  return hostedVideo({
    family: 'fal-video',
    ratios: namesOf(schema.fields.aspect_ratio?.enum),
    resolutions: namesOf(schema.fields.resolution?.enum),
    durations,
    defaultSeconds: usualSeconds(seconds),
    firstFrame: !!schema.firstFrame,
    lastFrame: !!schema.lastFrame,
    firstFrameRequired: !!schema.firstFrame && schema.required.includes(schema.firstFrame),
    audio: sound ? 'optional' : 'none',
    seed: 'seed' in schema.fields,
    negativePrompt: 'negative_prompt' in schema.fields,
    ...(fps.length ? { fps, defaultFps: numbersOf([schema.fields.fps?.default as number])[0] ?? fps[0]! } : {}),
  });
}

/** The value of `want` as the enum spells it (`720P`), or `want` when the field lists nothing. */
function spelled(f: Field | undefined, want: string): string {
  return f?.enum?.map(String).find((v) => v.toLowerCase() === want.toLowerCase()) ?? want;
}

/** The request body for this endpoint: only fields its schema has, in the types it has them. */
export function falVideoBody(schema: FalVideoSchema, request: ImageRequest): Record<string, unknown> {
  const video = request.video!;
  const { fields } = schema;
  const body: Record<string, unknown> = { prompt: request.prompt };
  const duration = fields.duration;
  if (duration) {
    // A string on the endpoints whose list of lengths is strings.
    const asString = duration.type === 'string' || duration.enum?.some((v) => typeof v === 'string' && !AUTO.has(v));
    body.duration = asString ? String(video.seconds) : video.seconds;
  }
  if (video.resolution && fields.resolution) body.resolution = spelled(fields.resolution, video.resolution);
  if (request.aspectRatio && fields.aspect_ratio) body.aspect_ratio = spelled(fields.aspect_ratio, request.aspectRatio);
  if (video.fps !== undefined && fields.fps) body.fps = video.fps;
  if (schema.audio && video.audio !== undefined) body[schema.audio] = video.audio;
  if (request.seed !== undefined && fields.seed) body.seed = request.seed;
  if (request.negativePrompt && fields.negative_prompt) body.negative_prompt = request.negativePrompt;
  if (video.firstFrame && schema.firstFrame) body[schema.firstFrame] = dataUrl(video.firstFrame.mime, video.firstFrame.bytes);
  if (video.lastFrame && schema.lastFrame) body[schema.lastFrame] = dataUrl(video.lastFrame.mime, video.lastFrame.bytes);
  // A required input that has a default must still be sent (MiniMax's `prompt_expansion_mode`); the service says nothing helpful when it is missing.
  for (const name of schema.required) if (!(name in body) && fields[name]?.default !== undefined) body[name] = fields[name]!.default;
  return body;
}
