/**
 * What the sound dialects share (ARCHITECTURE §23): capability shapes, reading a finished sound off an answer whatever
 * shape it comes in (bytes, base64 in JSON, raw samples), and reading a list of voices in the shapes servers use.
 */
import type { AudioCapabilities, AudioVoice, ImageCapabilities } from '@atelier/protocol';
import { arr, isRecord, rec, str } from '../../providers/util.ts';
import { MAX_AUDIO_BYTES } from '../audio.ts';
import { HOSTED_DEFAULTS } from '../catalog.ts';
import type { ImageEvent } from '../types.ts';

/** A sound model: one sound a call, no sizes, the rest from `audio`. */
export function soundModel(audio: AudioCapabilities, extra: Partial<Omit<ImageCapabilities, 'output' | 'audio'>> = {}): ImageCapabilities {
  return { ...HOSTED_DEFAULTS, family: 'hosted', sizes: { kind: 'fixed', list: [{ width: 1, height: 1 }] }, ...extra, output: 'audio', audio };
}

/** Voices by id with nothing more to say about them. */
export const namedVoices = (ids: readonly string[], describe: Record<string, string> = {}): AudioVoice[] =>
  ids.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), ...(describe[id] ? { description: describe[id] } : {}) }));

const tooLarge = () => new Error(`The sound is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`);

/** An answer's body as bytes, refusing one larger than a sound may be before it is all read. */
export async function readBody(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES * 1.4) throw tooLarge();
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_AUDIO_BYTES * 1.4) throw tooLarge();
  return bytes;
}

/** Field names services put base64 sound under, in the order they are tried. */
const BASE64_FIELDS = ['audio_data', 'audio', 'audioContent', 'audio_base64', 'data', 'b64', 'b64_json'];

/** The base64 sound in a JSON answer, wherever the service put it: at the top, or one level down. */
export function base64Sound(body: unknown): string | undefined {
  const top = rec(body);
  for (const key of BASE64_FIELDS) {
    const value = top[key];
    if (typeof value === 'string' && value.length > 16) return value.replace(/^data:[^,]*;base64,/, '');
    if (isRecord(value)) {
      const inner = base64Sound(value);
      if (inner) return inner;
    }
  }
  return undefined;
}

/**
 * The sound in an answer: its bytes when the service sent the file itself, else base64 inside JSON. `pcmRate` is the
 * sample rate of raw samples the service was asked for, so they can be wrapped as WAV.
 */
export async function soundFrom(res: Response, options: { pcmRate?: number } = {}): Promise<Extract<ImageEvent, { type: 'audio' }> | null> {
  const full = res.headers.get('content-type') ?? '';
  const type = full.split(';')[0]?.trim().toLowerCase() ?? '';
  // Raw samples say their rate in their type (`audio/pcm;rate=24000`), when they say it at all.
  const rate = Number(/rate=(\d+)/i.exec(full)?.[1]) || options.pcmRate;
  const bytes = await readBody(res);
  if (type === 'application/json' || type.endsWith('+json') || (bytes[0] === 0x7b && type.startsWith('text/'))) {
    const encoded = base64Sound(JSON.parse(new TextDecoder().decode(bytes)));
    if (!encoded) return null;
    return { type: 'audio', bytes: Buffer.from(encoded, 'base64'), ...(options.pcmRate ? { mime: `audio/L16;rate=${options.pcmRate}` } : {}) };
  }
  if (bytes.byteLength === 0) return null;
  const pcm = type === 'audio/pcm' || type === 'audio/l16' || type === 'audio/raw' || (options.pcmRate !== undefined && !type.startsWith('audio/'));
  return { type: 'audio', bytes, ...(pcm ? { mime: `audio/L16;rate=${rate ?? 24000}` } : {}) };
}

/** One voice from an entry in any of the shapes servers use: a name, or an object with an id and a name. */
function voiceOf(entry: unknown): AudioVoice | null {
  if (typeof entry === 'string') return entry.trim() ? { id: entry, name: entry } : null;
  const v = rec(entry);
  const id = str(v.voice_id) ?? str(v.id) ?? str(v.name) ?? str(v.voice);
  if (!id) return null;
  const labels = isRecord(v.labels) ? Object.values(v.labels).filter((l): l is string => typeof l === 'string' && !!l.trim()) : [];
  const said = str(v.description)?.trim() || labels.join(', ');
  const languages = arr(v.languages ?? v.language_codes).map((l) => (typeof l === 'string' ? l : (str(rec(l).language) ?? str(rec(l).code) ?? ''))).filter(Boolean);
  const language = str(v.language) ?? str(v.lang);
  const all = languages.length ? languages : language ? [language] : [];
  return { id, name: (str(v.name) ?? id).slice(0, 100), ...(said ? { description: said.slice(0, 300) } : {}), ...(all.length ? { languages: all.slice(0, 100) } : {}) };
}

/**
 * The voices in a list answer: `{voices:[…]}` with objects or names (Kokoro-FastAPI, KoboldCpp, Chatterbox, Orpheus),
 * `{data:[{voices:[…]}]}` (LocalAI), `{data:[…]}`, `{items:[…]}`, or a bare array. Duplicates are dropped.
 */
export function parseVoices(body: unknown): AudioVoice[] {
  const top = rec(body);
  const nested = arr(top.data).flatMap((d) => (isRecord(d) && Array.isArray(d.voices) ? d.voices : [d]));
  const list = Array.isArray(body) ? body : Array.isArray(top.voices) ? [...top.voices, ...arr(top.uploaded_voices)] : nested.length ? nested : arr(top.items ?? top.results);
  const seen = new Set<string>();
  const voices: AudioVoice[] = [];
  for (const entry of list) {
    const voice = voiceOf(entry);
    if (!voice || seen.has(voice.id)) continue;
    seen.add(voice.id);
    voices.push(voice);
  }
  return voices.slice(0, 2000);
}
