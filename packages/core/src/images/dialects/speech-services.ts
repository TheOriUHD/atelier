/**
 * Speech services with a wire format of their own, each a few fields: Cartesia (`/tts/bytes`), Deepgram Aura (`/v1/speak`,
 * the voice is the model), Fish Audio (`/v1/tts`, the model in a header; Fish Speech on someone's own computer answers the
 * same), and MiniMax (`/v1/t2a_v2`, the sound in hex inside JSON, and errors inside a 200).
 *
 * Read on 2026-11-06: https://docs.cartesia.ai/api-reference/tts/bytes, https://docs.cartesia.ai/api-reference/voices/list,
 * https://developers.deepgram.com/reference/text-to-speech/speak-request, https://developers.deepgram.com/docs/tts-models,
 * https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech, https://docs.fish.audio/api-reference/endpoint/model/list-models,
 * https://platform.minimax.io/docs/api-reference/speech-t2a-http, https://platform.minimax.io/docs/api-reference/voice-management-get
 */
import type { AudioVoice, ImageProviderType } from '@atelier/protocol';
import { classifyError, probe, requestJson } from '../../providers/http.ts';
import { arr, isRecord, num, rec, str } from '../../providers/util.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { parseVoices, soundFrom, soundModel } from './audio-common.ts';
import { failure, failureOf, listedModel, noImage, refusal } from './hosted.ts';

const bearer = (instance: ImageInstance, json = true, extra: Record<string, string> = {}): Record<string, string> => ({ ...(json ? { 'content-type': 'application/json' } : {}), ...instance.headers, ...extra, ...(instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {}) });

/** One request, one sound in the answer's body. */
async function* sendForSound(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, url: string, init: { headers: Record<string, string>; body: unknown }): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(url, { method: 'POST', headers: init.headers, body: JSON.stringify(init.body), signal: request.signal });
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

function adapter(type: ImageProviderType, instance: ImageInstance, deps: ImageAdapterDeps, parts: { list(signal?: AbortSignal): Promise<ListedImageModel[]>; healthUrl: string; headers: Record<string, string>; run(request: ImageRequest): AsyncGenerator<ImageEvent> }): ImageAdapter {
  return {
    type,
    listModels: (signal) => parts.list(signal),
    health: (signal) => probe(deps, instance, parts.healthUrl, parts.headers, signal),
    generate: (request) => guardImages(request, instance, () => parts.run(request)),
  };
}

// ------------------------------------------------------------------------------------------- Cartesia

const CARTESIA_VERSION = '2026-08-14';
const CARTESIA_MODELS = [
  { id: 'sonic-3.6', name: 'Sonic 3.6' },
  { id: 'sonic-3.5', name: 'Sonic 3.5' },
  { id: 'sonic-3', name: 'Sonic 3' },
];

export function createCartesia(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const headers = bearer(instance, true, { 'cartesia-version': CARTESIA_VERSION });
  return adapter('cartesia', instance, deps, {
    healthUrl: `${instance.baseUrl}/voices?limit=1`,
    headers,
    async list(signal) {
      const voices = parseVoices(await requestJson(deps, instance, `${instance.baseUrl}/voices?limit=100`, { headers, ...(signal ? { signal } : {}) }).catch(() => null));
      const ids = [...new Set([...CARTESIA_MODELS.map((m) => m.id), ...instance.models])];
      return ids.map((id) =>
        listedModel(instance, id, soundModel({ kinds: ['speech'], ...(voices.length ? { voices, defaultVoice: voices[0]!.id } : {}), speed: true }), instance.models.includes(id) ? 'default' : 'catalog', { displayName: CARTESIA_MODELS.find((m) => m.id === id)?.name ?? id }),
      );
    },
    run(request) {
      const audio = request.audio!;
      return sendForSound(instance, deps, request, `${instance.baseUrl}/tts/bytes`, {
        headers,
        body: {
          model_id: request.model,
          transcript: request.prompt,
          ...(audio.voice ? { voice: { mode: 'id', id: audio.voice } } : {}),
          ...(audio.language ? { language: audio.language } : {}),
          output_format: { container: 'mp3', sample_rate: 44_100, bit_rate: 128_000 },
          ...(audio.speed !== undefined ? { generation_config: { speed: audio.speed } } : {}),
        },
      });
    },
  });
}

// ------------------------------------------------------------------------------------------- Deepgram

/** Aura 2's English voices, for when the model list can't be read; each is a model of its own on the wire. */
const AURA_VOICES = ['thalia', 'andromeda', 'helena', 'apollo', 'arcas', 'aries', 'asteria', 'athena', 'atlas', 'aurora', 'callista', 'cora', 'cordelia', 'delia', 'draco', 'electra', 'harmonia', 'hera', 'hermes', 'hyperion', 'iris', 'janus', 'juno', 'jupiter', 'luna', 'mars', 'minerva', 'neptune', 'odysseus', 'ophelia', 'orion', 'orpheus', 'pandora', 'phoebe', 'pluto', 'saturn', 'selene', 'theia', 'vesta', 'zeus'];
const DEEPGRAM_MODEL = 'aura-2';

/** Deepgram's TTS models as voices: `aura-2-thalia-en` is Thalia, speaking English. */
function auraVoices(body: unknown): AudioVoice[] {
  const listed = arr(rec(body).tts)
    .filter(isRecord)
    .flatMap((m): AudioVoice[] => {
      const id = str(m.canonical_name);
      if (!id || !id.startsWith('aura-2')) return [];
      const meta = rec(m.metadata);
      const traits = [...arr(meta.tags).map(String), str(meta.accent)].filter(Boolean).slice(0, 4).join(', ');
      const name = str(m.name) ?? id;
      return [{ id, name: name.charAt(0).toUpperCase() + name.slice(1), ...(traits ? { description: traits } : {}), ...(arr(m.languages).length ? { languages: arr(m.languages).map(String) } : {}) }];
    });
  return listed.length ? listed : AURA_VOICES.map((v) => ({ id: `aura-2-${v}-en`, name: v.charAt(0).toUpperCase() + v.slice(1), languages: ['en'] }));
}

export function createDeepgram(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const headers = { 'content-type': 'application/json', ...instance.headers, ...(instance.apiKey ? { authorization: `Token ${instance.apiKey}` } : {}) };
  return adapter('deepgram', instance, deps, {
    healthUrl: `${instance.baseUrl}/v1/projects`,
    headers,
    async list(signal) {
      const voices = auraVoices(await requestJson(deps, instance, `${instance.baseUrl}/v1/models`, { headers, ...(signal ? { signal } : {}) }).catch(() => null));
      return [listedModel(instance, DEEPGRAM_MODEL, soundModel({ kinds: ['speech'], voices, defaultVoice: voices.find((v) => v.id === 'aura-2-thalia-en')?.id ?? voices[0]!.id, maxChars: 2000 }), 'catalog', { displayName: 'Aura 2' })];
    },
    run(request) {
      const voice = request.audio?.voice ?? 'aura-2-thalia-en';
      return sendForSound(instance, deps, request, `${instance.baseUrl}/v1/speak?model=${encodeURIComponent(voice)}&encoding=mp3`, { headers, body: { text: request.prompt } });
    },
  });
}

// ----------------------------------------------------------------------------------------- Fish Audio

const FISH_MODELS = [
  { id: 's2.1-pro', name: 'Fish Audio S2.1 Pro' },
  { id: 's2-pro', name: 'Fish Audio S2 Pro' },
  { id: 'drama-3', name: 'Fish Audio Drama 3' },
];

/** Fish Audio's own voices: `{items: [{_id, title, description, languages}]}`. */
const fishVoices = (body: unknown): AudioVoice[] =>
  arr(rec(body).items)
    .filter(isRecord)
    .flatMap((v): AudioVoice[] => {
      const id = str(v._id) ?? str(v.id);
      if (!id) return [];
      const name = (str(v.title) ?? id).slice(0, 100);
      const said = str(v.description)?.slice(0, 300);
      return [{ id, name, ...(said ? { description: said } : {}), ...(arr(v.languages).length ? { languages: arr(v.languages).map(String) } : {}) }];
    });

export function createFishAudio(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const local = instance.preset === 'fish-speech';
  const headers = bearer(instance);
  return adapter('fish-audio', instance, deps, {
    healthUrl: local ? `${instance.baseUrl}/v1/health` : `${instance.baseUrl}/model?self=true&page_size=1`,
    headers,
    async list(signal) {
      // The cloud lists the account's voices; Fish Speech on someone's computer takes the ids of references it was given.
      const voices = local ? [] : fishVoices(await requestJson(deps, instance, `${instance.baseUrl}/model?self=true&page_size=100`, { headers, ...(signal ? { signal } : {}) }).catch(() => null));
      const models = local ? [{ id: 'fish-speech', name: 'Fish Speech' }] : FISH_MODELS;
      const ids = [...new Set([...models.map((m) => m.id), ...instance.models])];
      return ids.map((id) => listedModel(instance, id, soundModel({ kinds: ['speech'], ...(voices.length ? { voices, defaultVoice: voices[0]!.id } : {}), direction: true, speed: true }, { seed: local }), instance.models.includes(id) ? 'default' : 'catalog', { displayName: models.find((m) => m.id === id)?.name ?? id }));
    },
    run(request) {
      const audio = request.audio!;
      return sendForSound(instance, deps, request, `${instance.baseUrl}/v1/tts`, {
        headers: local ? headers : { ...headers, model: request.model },
        body: {
          // Fish reads directions written in brackets before the words.
          text: audio.direction ? `(${audio.direction}) ${request.prompt}` : request.prompt,
          format: 'mp3',
          ...(audio.voice ? { reference_id: audio.voice } : {}),
          ...(audio.speed !== undefined ? { prosody: { speed: audio.speed } } : {}),
          ...(local && request.seed !== undefined ? { seed: request.seed } : {}),
        },
      });
    },
  });
}

// -------------------------------------------------------------------------------------------- MiniMax

const MINIMAX_MODELS = [
  { id: 'speech-2.8-hd', name: 'MiniMax Speech 2.8 HD' },
  { id: 'speech-2.8-turbo', name: 'MiniMax Speech 2.8 Turbo' },
  { id: 'speech-2.6-hd', name: 'MiniMax Speech 2.6 HD' },
];
/** MiniMax's code for text its filter turned down. */
const MINIMAX_SENSITIVE = 1026;

/** `{system_voice:[…], voice_cloning:[…], voice_generation:[…]}`, each `{voice_id, voice_name, description}`. */
function minimaxVoices(body: unknown): AudioVoice[] {
  const top = rec(body);
  return [...arr(top.voice_cloning), ...arr(top.voice_generation), ...arr(top.system_voice)].filter(isRecord).flatMap((v): AudioVoice[] => {
    const id = str(v.voice_id);
    if (!id) return [];
    const said = arr(v.description).map(String).join(' ').trim() || str(v.description);
    return [{ id, name: (str(v.voice_name) ?? id).slice(0, 100), ...(said ? { description: said.slice(0, 300) } : {}) }];
  });
}

export async function* minimaxSpeech(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const audio = request.audio!;
  const res = await deps.fetch(`${instance.baseUrl}/v1/t2a_v2`, {
    method: 'POST',
    headers: bearer(instance),
    body: JSON.stringify({
      model: request.model,
      text: request.prompt,
      stream: false,
      output_format: 'hex',
      voice_setting: { voice_id: audio.voice ?? 'English_expressive_narrator', ...(audio.speed !== undefined ? { speed: audio.speed } : {}) },
      audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: 'mp3', channel: 1 },
      ...(audio.language ? { language_boost: audio.language } : {}),
    }),
    signal: request.signal,
  });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const body = rec(await res.json());
  const status = rec(body.base_resp);
  const code = num(status.status_code) ?? 0;
  if (code !== 0) {
    const message = str(status.status_msg) ?? `error ${code}`;
    yield code === MINIMAX_SENSITIVE ? refusal(instance, message) : failure(classifyError(instance, null, String(code), message));
    return;
  }
  const hex = str(rec(body.data).audio);
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) {
    yield noImage(instance, 'its answer had no sound');
    return;
  }
  yield { type: 'audio', bytes: Buffer.from(hex, 'hex') };
  yield { type: 'finish', reason: 'done' };
}

export function createMiniMaxAudio(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const headers = bearer(instance);
  const base = adapter('minimax-audio', instance, deps, {
    healthUrl: `${instance.baseUrl}/v1/models`,
    headers,
    async list(signal) {
      const voices = minimaxVoices(await requestJson(deps, instance, `${instance.baseUrl}/v1/get_voice`, { method: 'POST', headers, body: { voice_type: 'all' }, ...(signal ? { signal } : {}) }).catch(() => null));
      const ids = [...new Set([...MINIMAX_MODELS.map((m) => m.id), ...instance.models])];
      return ids.map((id) => listedModel(instance, id, soundModel({ kinds: ['speech'], ...(voices.length ? { voices, defaultVoice: voices[0]!.id } : {}), speed: true, maxChars: 10_000 }), instance.models.includes(id) ? 'default' : 'catalog', { displayName: MINIMAX_MODELS.find((m) => m.id === id)?.name ?? id }));
    },
    run: (request) => minimaxSpeech(instance, deps, request),
  });
  return {
    ...base,
    // MiniMax has no list to read with a GET; asking for its voices proves the key as well.
    async health(signal) {
      const started = performance.now();
      try {
        const body = rec(await requestJson(deps, instance, `${instance.baseUrl}/v1/get_voice`, { method: 'POST', headers, body: { voice_type: 'system' }, ...(signal ? { signal } : {}) }));
        const code = num(rec(body.base_resp).status_code) ?? 0;
        const latencyMs = Math.round(performance.now() - started);
        return code === 0 ? { ok: true, latencyMs, warnings: [] } : { ok: false, latencyMs, warnings: [], error: str(rec(body.base_resp).status_msg) ?? `MiniMax answered with error ${code}.` };
      } catch (e) {
        if (signal?.aborted) throw e;
        return { ok: false, latencyMs: null, warnings: [], error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
