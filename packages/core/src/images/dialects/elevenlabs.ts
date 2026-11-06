/**
 * ElevenLabs: speech (`POST /v1/text-to-speech/{voice}`), music (`POST /v1/music`) and sound effects
 * (`POST /v1/sound-generation`), each answered with the sound's bytes. Speech models come from `GET /v1/models`, voices
 * from `GET /v2/voices` (the account's own and cloned voices among them), and the music and effect models are the
 * service's few. The format is a query parameter; MP3 at 44.1 kHz works on every plan.
 *
 * Read on 2026-11-06: https://elevenlabs.io/docs/api-reference/text-to-speech/convert,
 * https://elevenlabs.io/docs/api-reference/voices/search, https://elevenlabs.io/docs/overview/models,
 * https://elevenlabs.io/docs/api-reference/music/compose, https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert,
 * https://elevenlabs.io/pricing/api
 */
import type { AudioVoice } from '@atelier/protocol';
import { probe, requestJson } from '../../providers/http.ts';
import { arr, isRecord, num, rec, str } from '../../providers/util.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { parseVoices, soundFrom, soundModel } from './audio-common.ts';
import { failureOf, listedModel, noImage } from './hosted.ts';

const FORMAT = 'mp3_44100_128';
/** Voices read per page, and pages at most: a workspace with thousands of voices still lists in a few requests. */
const PAGE = 100;
const MAX_PAGES = 10;

/** The music and sound-effect models, which `/v1/models` doesn't list. */
const MUSIC_MODELS = [
  { id: 'music_v2_5', name: 'Eleven Music v2.5' },
  { id: 'music_v2', name: 'Eleven Music v2' },
];
const SOUND_MODELS = [{ id: 'eleven_text_to_sound_v3', name: 'Eleven Sound Effects v3' }];
/** What a speech model can take at once, where `/v1/models` doesn't say. */
const MAX_CHARS: readonly (readonly [RegExp, number])[] = [
  [/flash/, 40_000],
  [/v3/, 5_000],
  [/v4|multilingual/, 10_000],
];

const headers = (instance: ImageInstance, json = true): Record<string, string> => ({ ...(json ? { 'content-type': 'application/json' } : {}), ...instance.headers, ...(instance.apiKey ? { 'xi-api-key': instance.apiKey } : {}) });

/** The account's voices, every page of them. */
async function voices(instance: ImageInstance, deps: ImageAdapterDeps, signal?: AbortSignal): Promise<AudioVoice[]> {
  const all: AudioVoice[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${instance.baseUrl}/v2/voices?page_size=${PAGE}${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`;
    const body = rec(await requestJson(deps, instance, url, { headers: headers(instance, false), ...(signal ? { signal } : {}) }));
    all.push(...parseVoices({ voices: arr(body.voices) }));
    token = body.has_more === true ? str(body.next_page_token) : undefined;
    if (!token) break;
  }
  return all;
}

function speechModels(instance: ImageInstance, listed: unknown, voiceList: AudioVoice[]): ListedImageModel[] {
  return arr(listed)
    .filter(isRecord)
    .filter((m) => m.can_do_text_to_speech !== false && !/sts|speech_to_speech|scribe/i.test(str(m.model_id) ?? ''))
    .flatMap((m) => {
      const id = str(m.model_id);
      if (!id) return [];
      const languages = arr(m.languages).map((l) => str(rec(l).language_id) ?? '').filter(Boolean);
      const maxChars = num(m.maximum_text_length_per_request) ?? MAX_CHARS.find(([match]) => match.test(id))?.[1];
      const capabilities = soundModel(
        {
          kinds: ['speech'],
          ...(voiceList.length ? { voices: voiceList, defaultVoice: voiceList[0]!.id } : {}),
          // v3 and later follow audio tags such as [whispers] in the text, which is how they take a direction.
          ...(/v3|v4/.test(id) ? { direction: true } : {}),
          speed: true,
          ...(maxChars ? { maxChars } : {}),
          ...(languages.length ? { languages } : {}),
        },
        { seed: true },
      );
      return [listedModel(instance, id, capabilities, 'detected', { displayName: str(m.name) ?? id, ...(str(m.description) ? { description: str(m.description)!.slice(0, 200) } : {}) })];
    });
}

const music = (instance: ImageInstance, id: string, name: string) => listedModel(instance, id, soundModel({ kinds: ['music'], durations: { kind: 'range', min: 3, max: 600, step: 1 }, defaultSeconds: 30, lyrics: false, vocals: 'optional' }), 'catalog', { displayName: name });
const effects = (instance: ImageInstance, id: string, name: string) => listedModel(instance, id, soundModel({ kinds: ['sound'], durations: { kind: 'range', min: 0.5, max: 30 }, defaultSeconds: 5 }), 'catalog', { displayName: name });

/** A speech request: the words, with the direction as an audio tag in front where the model reads those. */
function speechBody(request: ImageRequest): Record<string, unknown> {
  const audio = request.audio!;
  const text = audio.direction && request.capabilities.audio?.direction ? `[${audio.direction}] ${request.prompt}` : request.prompt;
  return {
    text,
    model_id: request.model,
    ...(audio.language ? { language_code: audio.language } : {}),
    ...(audio.speed !== undefined ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, audio.speed)) } } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
}

/** Lyrics go in the prompt: the plain prompt is how a song with given words is asked for without a composition plan. */
function musicBody(request: ImageRequest): Record<string, unknown> {
  const audio = request.audio!;
  const prompt = audio.lyrics ? `${request.prompt}\n\nLyrics:\n${audio.lyrics}` : request.prompt;
  return {
    prompt,
    model_id: request.model,
    ...(audio.seconds !== undefined ? { music_length_ms: Math.round(audio.seconds * 1000) } : {}),
    ...(audio.instrumental ? { force_instrumental: true } : {}),
  };
}

const effectBody = (request: ImageRequest): Record<string, unknown> => ({
  text: request.prompt,
  model_id: request.model,
  ...(request.audio?.seconds !== undefined ? { duration_seconds: request.audio.seconds } : {}),
});

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const kind = request.audio?.kind ?? 'speech';
  const [path, body] =
    kind === 'speech'
      ? [`/v1/text-to-speech/${encodeURIComponent(request.audio?.voice ?? '')}`, speechBody(request)]
      : kind === 'music'
        ? ['/v1/music', musicBody(request)]
        : ['/v1/sound-generation', effectBody(request)];
  if (kind === 'speech' && !request.audio?.voice) {
    yield noImage(instance, 'no voice was chosen, and this account has none');
    return;
  }
  const res = await deps.fetch(`${instance.baseUrl}${path}?output_format=${FORMAT}`, { method: 'POST', headers: headers(instance), body: JSON.stringify(body), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const sound = await soundFrom(res);
  if (!sound) {
    yield noImage(instance, 'its answer had no sound');
    return;
  }
  yield sound;
  yield { type: 'finish', reason: 'done' };
}

export function createElevenLabs(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  return {
    type: 'elevenlabs',
    async listModels(signal) {
      const [listed, voiceList] = await Promise.all([requestJson(deps, instance, `${instance.baseUrl}/v1/models`, { headers: headers(instance, false), ...(signal ? { signal } : {}) }), voices(instance, deps, signal).catch(() => [])]);
      return [...speechModels(instance, listed, voiceList), ...MUSIC_MODELS.map((m) => music(instance, m.id, m.name)), ...SOUND_MODELS.map((m) => effects(instance, m.id, m.name))];
    },
    health(signal) {
      return probe(deps, instance, `${instance.baseUrl}/v1/models`, headers(instance, false), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request));
    },
  };
}
