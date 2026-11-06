/**
 * Sound models described by their own input schemas (OpenAPI/JSON Schema, as fal and Replicate publish them), as
 * `video-schema.ts` does for clips. A speech endpoint calls its words `text` or `prompt` or `input`, its voice `voice` or
 * `voice_id`, often as an enum that is the list of voices; a music endpoint's length is `duration`, `seconds_total` or
 * `music_length_ms`. So the capabilities and the request body are both worked out from the schema.
 */
import type { AudioCapabilities, AudioKind, AudioVoice, ImageCapabilities } from '@atelier/protocol';
import { arr, isRecord, rec, str } from '../../providers/util.ts';
import type { ImageRequest } from '../types.ts';
import { soundModel } from './audio-common.ts';
import { field, type Field } from './video-schema.ts';

export interface AudioInputSchema {
  fields: Record<string, Field>;
  required: string[];
  /** The wire names of the inputs, where the endpoint has them. */
  text?: string;
  prompt?: string;
  voice?: string;
  lyrics?: string;
  duration?: string;
  /** The length is in milliseconds. */
  durationMs?: boolean;
  instrumental?: string;
  speed?: string;
  language?: string;
  direction?: string;
}

const NAMES = {
  text: ['text', 'input', 'input_text', 'gen_text', 'script'],
  prompt: ['prompt', 'caption', 'tags', 'description', 'style_prompt'],
  voice: ['voice', 'voice_id', 'speaker', 'voice_name', 'speaker_id'],
  lyrics: ['lyrics', 'lyrics_prompt'],
  duration: ['duration', 'seconds_total', 'duration_seconds', 'audio_duration', 'total_seconds', 'length', 'music_length_ms', 'duration_ms'],
  instrumental: ['instrumental', 'force_instrumental', 'make_instrumental', 'is_instrumental'],
  speed: ['speed', 'speaking_rate'],
  language: ['language', 'language_code', 'lang', 'language_boost'],
  direction: ['instructions', 'style', 'style_instructions', 'voice_description'],
} as const;

/** Reads an input schema's `properties` and `required`; null when it has no properties. */
export function readAudioInputs(input: Record<string, unknown>, schemas: Record<string, unknown>): AudioInputSchema | null {
  if (!isRecord(input.properties)) return null;
  const fields: Record<string, Field> = {};
  for (const [name, prop] of Object.entries(input.properties)) fields[name] = field(prop, schemas);
  const pick = (candidates: readonly string[]) => candidates.find((n) => n in fields);
  const found: Partial<AudioInputSchema> = {};
  for (const key of Object.keys(NAMES) as (keyof typeof NAMES)[]) {
    const name = pick(NAMES[key]);
    if (name) (found as Record<string, string>)[key] = name;
  }
  // A speech endpoint that calls its words `prompt` has no description besides them.
  if (!found.text && found.prompt && found.voice) {
    found.text = found.prompt;
    delete found.prompt;
  }
  return { fields, required: arr(input.required).map(String), ...found, ...(found.duration && /_ms$/.test(found.duration) ? { durationMs: true } : {}) };
}

/** What an endpoint makes: its category says speech or sound, and the schema and its name tell music from effects. */
export function audioKinds(schema: AudioInputSchema, hint: { category?: string | undefined; id: string }): AudioKind[] {
  if (hint.category === 'text-to-speech') return ['speech'];
  // fal's sound effects take `text` and no voice: what the category says it is wins over how the words are called.
  if (hint.category !== 'text-to-audio' && schema.text && (schema.voice || !schema.prompt)) return ['speech'];
  if (schema.lyrics || /music|song|lyria|ace-?step|cassette|sonauto|diffrhythm|yue|riffusion|mureka|sonilo|musicgen/i.test(hint.id)) return ['music'];
  if (/sfx|sound-?effect|foley|mmaudio|audioldm|sound/i.test(hint.id)) return ['sound'];
  return ['music', 'sound'];
}

const numbers = (values: readonly (string | number)[] | undefined) => (values ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);

export function audioCapabilities(schema: AudioInputSchema, kinds: AudioKind[], family: string): ImageCapabilities {
  const { fields } = schema;
  const voice = schema.voice ? fields[schema.voice] : undefined;
  const voices: AudioVoice[] = (voice?.enum ?? []).map(String).filter(Boolean).map((id) => ({ id, name: id }));
  const duration = schema.duration ? fields[schema.duration] : undefined;
  const scale = schema.durationMs ? 1000 : 1;
  let durations: AudioCapabilities['durations'];
  const listed = numbers(duration?.enum).map((n) => n / scale);
  if (listed.length) durations = { kind: 'list', seconds: [...listed].sort((a, b) => a - b) };
  else if (duration?.minimum !== undefined && duration.maximum !== undefined) durations = { kind: 'range', min: Math.max(0.5, duration.minimum / scale), max: duration.maximum / scale, ...(duration.type === 'integer' && !schema.durationMs ? { step: 1 } : {}) };
  else if (duration) durations = { kind: 'range', min: 1, max: 600 };
  const defaultSeconds = typeof duration?.default === 'number' ? duration.default / scale : typeof duration?.default === 'string' && Number(duration.default) > 0 ? Number(duration.default) / scale : durations ? Math.min(30, durations.kind === 'list' ? durations.seconds.at(-1)! : durations.max) : undefined;
  const text = schema.text ? fields[schema.text] : undefined;
  const audio: AudioCapabilities = {
    kinds,
    ...(voices.length ? { voices, defaultVoice: typeof voice?.default === 'string' && voices.some((v) => v.id === voice.default) ? voice.default : voices[0]!.id } : typeof voice?.default === 'string' ? { defaultVoice: voice.default } : {}),
    ...(schema.direction ? { direction: true } : {}),
    ...(schema.speed ? { speed: true } : {}),
    ...(text?.maxLength ? { maxChars: text.maxLength } : {}),
    ...(durations ? { durations } : {}),
    ...(defaultSeconds !== undefined && kinds.some((k) => k !== 'speech') ? { defaultSeconds } : {}),
    ...(kinds.includes('music') ? { lyrics: !!schema.lyrics, vocals: schema.instrumental || schema.lyrics ? 'optional' : 'none' } : {}),
  };
  return soundModel(audio, { family, seed: 'seed' in fields, negativePrompt: 'negative_prompt' in fields });
}

/** The value as the schema types it: a string field gets a string, an integer field a whole number. */
function typed(f: Field | undefined, value: number): number | string {
  if (f?.type === 'string' || f?.enum?.some((v) => typeof v === 'string')) return String(value);
  return f?.type === 'integer' ? Math.round(value) : value;
}

/** The request body for this endpoint: only fields its schema has, in the types it has them. */
export function audioBody(schema: AudioInputSchema, request: ImageRequest): Record<string, unknown> {
  const audio = request.audio!;
  const { fields } = schema;
  const body: Record<string, unknown> = {};
  const words = schema.text ?? schema.prompt ?? 'prompt';
  if (audio.kind === 'speech' || !schema.prompt) body[words] = request.prompt;
  else body[schema.prompt] = request.prompt;
  if (audio.voice && schema.voice) body[schema.voice] = audio.voice;
  if (audio.direction && schema.direction) body[schema.direction] = audio.direction;
  if (audio.speed !== undefined && schema.speed) body[schema.speed] = audio.speed;
  if (audio.language && schema.language) body[schema.language] = audio.language;
  if (audio.seconds !== undefined && schema.duration) body[schema.duration] = typed(fields[schema.duration], schema.durationMs ? audio.seconds * 1000 : audio.seconds);
  if (audio.lyrics && schema.lyrics) body[schema.lyrics] = audio.lyrics;
  if (audio.instrumental && schema.instrumental) body[schema.instrumental] = true;
  if (request.seed !== undefined && fields.seed) body.seed = request.seed;
  if (request.negativePrompt && fields.negative_prompt) body.negative_prompt = request.negativePrompt;
  // MP3 where the endpoint lets one choose; its own default otherwise.
  const format = fields.output_format ?? fields.response_format ?? fields.format;
  const formatName = fields.output_format ? 'output_format' : fields.response_format ? 'response_format' : fields.format ? 'format' : undefined;
  const mp3 = format?.enum?.map(String).find((v) => /^mp3/i.test(v));
  if (formatName && mp3) body[formatName] = mp3;
  for (const name of schema.required) if (!(name in body) && fields[name]?.default !== undefined) body[name] = fields[name]!.default;
  return body;
}

/** The sound's address in an answer: `audio.url`, `audio_file.url`, `audio_url`, or a bare URL or list of them (Replicate's `output`). */
export function soundUrl(answer: unknown): string | undefined {
  if (typeof answer === 'string') return /^(?:https?:|data:)/.test(answer) ? answer : undefined;
  if (Array.isArray(answer)) return answer.map(soundUrl).find(Boolean);
  const top = rec(answer);
  for (const key of ['audio', 'audio_file', 'audio_url', 'output', 'file', 'url']) {
    const value = top[key];
    const found = typeof value === 'string' ? soundUrl(value) : isRecord(value) ? str(value.url) : Array.isArray(value) ? soundUrl(value) : undefined;
    if (found) return found;
  }
  return undefined;
}
