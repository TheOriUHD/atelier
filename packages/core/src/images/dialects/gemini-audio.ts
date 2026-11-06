/**
 * Google Gemini's sound models through the Interactions API (`POST /v1beta/interactions`): speech with one of 30 voices,
 * or a conversation between two, and Lyria music. A finished interaction lists its steps; the sound is the last `audio`
 * content of a `model_output` step, as base64 (a whole WAV for speech, an MP3 for music). Lyria takes everything in its
 * prompt: lyrics under `[Verse]` and `[Chorus]` tags, "instrumental only", the length in words.
 *
 * Read on 2026-11-06: https://aistudio.google.com/docs/speech-generation, https://aistudio.google.com/docs/music-generation.md,
 * https://aistudio.google.com/api-reference/interactions-api/create-interaction.md, https://aistudio.google.com/docs/models/lyria-3.5.md
 */
import type { AudioVoice } from '@atelier/protocol';
import { probe } from '../../providers/http.ts';
import { arr, isRecord, rec, str } from '../../providers/util.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { soundModel } from './audio-common.ts';
import { failureOf, listedModel, noImage, refusal } from './hosted.ts';

/** The prebuilt voices, with Google's one word for each. */
const VOICES: Record<string, string> = {
  Zephyr: 'bright',
  Puck: 'upbeat',
  Charon: 'informative',
  Kore: 'firm',
  Fenrir: 'excitable',
  Leda: 'youthful',
  Orus: 'firm',
  Aoede: 'breezy',
  Callirrhoe: 'easy-going',
  Autonoe: 'bright',
  Enceladus: 'breathy',
  Iapetus: 'clear',
  Umbriel: 'easy-going',
  Algieba: 'smooth',
  Despina: 'smooth',
  Erinome: 'clear',
  Algenib: 'gravelly',
  Rasalgethi: 'informative',
  Laomedeia: 'upbeat',
  Achernar: 'soft',
  Alnilam: 'firm',
  Schedar: 'even',
  Gacrux: 'mature',
  Pulcherrima: 'forward',
  Achird: 'friendly',
  Zubenelgenubi: 'casual',
  Vindemiatrix: 'gentle',
  Sadachbia: 'lively',
  Sadaltager: 'knowledgeable',
  Sulafat: 'warm',
};
const VOICE_LIST: AudioVoice[] = Object.entries(VOICES).map(([id, said]) => ({ id, name: id, description: said }));

const SPEECH_MODELS = [
  { id: 'gemini-3.8-flash-tts', name: 'Gemini 3.8 Flash TTS' },
  { id: 'gemini-3.8-flash-lite-tts', name: 'Gemini 3.8 Flash-Lite TTS' },
];
const MUSIC_MODELS = [
  { id: 'lyria-3.5', name: 'Lyria 3.5', seconds: { kind: 'range' as const, min: 30, max: 240, step: 30 }, usual: 120 },
  { id: 'lyria-3-clip-preview', name: 'Lyria 3 Clip', seconds: { kind: 'list' as const, seconds: [30] }, usual: 30 },
];
/** About 8,000 tokens of text a call, at four characters a token and some room to spare. */
const MAX_CHARS = 30_000;

const headers = (instance: ImageInstance, json = true): Record<string, string> => ({ ...(json ? { 'content-type': 'application/json' } : {}), ...instance.headers, ...(instance.apiKey ? { 'x-goog-api-key': instance.apiKey } : {}) });

/** One text item per line of a conversation, each marked with its speaker; plain text when there is one voice. */
function speechInput(request: ImageRequest): unknown[] {
  const audio = request.audio!;
  const style = audio.direction ? { style: audio.direction } : {};
  if (!audio.speakers?.length) return [{ type: 'user_input', content: [{ type: 'text', text: request.prompt, ...(audio.direction ? { annotations: [{ type: 'speech_metadata', ...style }] } : {}) }] }];
  const names = new Map(audio.speakers.map((s) => [s.name.toLowerCase(), s.name]));
  const content: Record<string, unknown>[] = [];
  for (const line of request.prompt.split(/\n+/)) {
    const said = /^\s*([^:]{1,40}):\s*(.*)$/.exec(line);
    const speaker = said ? names.get(said[1]!.trim().toLowerCase()) : undefined;
    if (speaker && said![2]!.trim()) content.push({ type: 'text', text: said![2]!.trim(), annotations: [{ type: 'speech_metadata', speaker, ...style }] });
    else if (line.trim() && content.length) content.at(-1)!.text = `${String(content.at(-1)!.text)} ${line.trim()}`;
    else if (line.trim()) content.push({ type: 'text', text: line.trim(), annotations: [{ type: 'speech_metadata', speaker: audio.speakers[0]!.name, ...style }] });
  }
  return [{ type: 'user_input', content }];
}

export function geminiSpeechBody(request: ImageRequest): Record<string, unknown> {
  const audio = request.audio!;
  // One voice is a list of one; two speakers are an object naming each.
  const speech = audio.speakers?.length ? { speakers: audio.speakers.map((s) => ({ speaker: s.name, voice: s.voice })) } : [{ voice: audio.voice ?? 'Kore' }];
  return { model: request.model, input: speechInput(request), response_format: { type: 'audio' }, generation_config: { speech_config: speech } };
}

/** Lyria reads its settings from the prompt, in words. */
export function lyriaBody(request: ImageRequest): Record<string, unknown> {
  const audio = request.audio!;
  const parts = [request.prompt];
  if (audio.seconds !== undefined && request.model !== 'lyria-3-clip-preview') parts.push(audio.seconds >= 60 ? `About ${Math.round(audio.seconds / 60 * 2) / 2} minutes long.` : `About ${Math.round(audio.seconds)} seconds long.`);
  if (audio.instrumental) parts.push('Instrumental only, no vocals.');
  else if (audio.lyrics) parts.push(`With these lyrics:\n${audio.lyrics}`);
  return { model: request.model, input: parts.join('\n\n'), response_format: { type: 'audio' } };
}

/** The last sound of the interaction's output, and whether it was blocked. */
export function interactionSound(body: unknown): { data?: string; mime?: string; blocked?: string } {
  const top = rec(body);
  let found: { data?: string; mime?: string } = {};
  for (const step of arr(top.steps).filter(isRecord)) {
    if (step.type !== 'model_output') continue;
    for (const content of arr(step.content).filter(isRecord)) {
      if (content.type === 'audio' && str(content.data)) found = { data: str(content.data)!, ...(str(content.mime_type) ? { mime: str(content.mime_type)! } : {}) };
    }
  }
  const status = str(top.status);
  const blocked = status && /block|safety|refus/i.test(status) ? status : str(rec(top.error).message) && /safety|block|policy/i.test(str(rec(top.error).message)!) ? str(rec(top.error).message) : undefined;
  return { ...found, ...(blocked ? { blocked } : {}) };
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const music = request.audio?.kind !== 'speech';
  const res = await deps.fetch(`${instance.baseUrl}/v1beta/interactions`, { method: 'POST', headers: headers(instance), body: JSON.stringify(music ? lyriaBody(request) : geminiSpeechBody(request)), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const { data, mime, blocked } = interactionSound(await res.json());
  if (!data) {
    yield blocked ? refusal(instance, blocked) : noImage(instance, 'its answer had no sound');
    return;
  }
  // A unary answer is a whole WAV now; an older model sent raw samples, which say so in their type.
  yield { type: 'audio', bytes: Buffer.from(data, 'base64'), ...(mime && /l16|pcm/i.test(mime) ? { mime: `audio/L16;rate=24000` } : {}) };
  yield { type: 'finish', reason: 'done' };
}

export function createGeminiAudio(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  return {
    type: 'gemini-audio',
    listModels() {
      const speech = [...SPEECH_MODELS, ...instance.models.filter((id) => /tts/i.test(id) && !SPEECH_MODELS.some((m) => m.id === id)).map((id) => ({ id, name: id }))];
      const music = [...MUSIC_MODELS, ...instance.models.filter((id) => /lyria/i.test(id) && !MUSIC_MODELS.some((m) => m.id === id)).map((id) => ({ id, name: id, seconds: { kind: 'range' as const, min: 30, max: 240, step: 30 }, usual: 120 }))];
      return Promise.resolve([
        ...speech.map((m) => listedModel(instance, m.id, soundModel({ kinds: ['speech'], voices: VOICE_LIST, defaultVoice: 'Kore', direction: true, maxSpeakers: 2, maxChars: MAX_CHARS }), 'catalog', { displayName: m.name })),
        ...music.map((m) => listedModel(instance, m.id, soundModel({ kinds: ['music'], durations: m.seconds, defaultSeconds: m.usual, lyrics: true, vocals: 'optional' }), 'catalog', { displayName: m.name })),
      ]);
    },
    health(signal) {
      return probe(deps, instance, `${instance.baseUrl}/v1beta/models?pageSize=1`, headers(instance, false), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request));
    },
  };
}
