/**
 * xAI speech: `POST /v1/tts` with the text, a voice and a language, answered with the sound's bytes. It has no model
 * field; the voices come from `GET /v1/tts/voices`, and the text takes xAI's own tags such as `[laugh]`, which is how a
 * direction is given.
 *
 * Read on 2026-11-06: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
 */
import type { AudioVoice } from '@atelier/protocol';
import { probe, requestJson } from '../../providers/http.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { namedVoices, parseVoices, soundFrom, soundModel } from './audio-common.ts';
import { failureOf, listedModel, noImage } from './hosted.ts';

/** The one model id Atelier lists for it: the service has no model choice. */
export const XAI_SPEECH_MODEL = 'grok-tts';
const KNOWN_VOICES = ['eve', 'ara', 'rex', 'sal', 'leo'];
const MAX_CHARS = 60_000;

const headers = (instance: ImageInstance, json = true): Record<string, string> => ({ ...(json ? { 'content-type': 'application/json' } : {}), ...instance.headers, ...(instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {}) });

export function xaiSpeechBody(request: ImageRequest): Record<string, unknown> {
  const audio = request.audio!;
  return {
    text: audio.direction ? `[${audio.direction}] ${request.prompt}` : request.prompt,
    language: audio.language ?? 'auto',
    ...(audio.voice ? { voice_id: audio.voice } : {}),
    output_format: { codec: 'mp3', sample_rate: 44_100 },
    ...(audio.speed !== undefined ? { speed: Math.min(1.5, Math.max(0.7, audio.speed)) } : {}),
  };
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/v1/tts`, { method: 'POST', headers: headers(instance), body: JSON.stringify(xaiSpeechBody(request)), signal: request.signal });
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

export function createXaiSpeech(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  return {
    type: 'xai-speech',
    async listModels(signal) {
      const listed = parseVoices(await requestJson(deps, instance, `${instance.baseUrl}/v1/tts/voices`, { headers: headers(instance, false), ...(signal ? { signal } : {}) }).catch(() => null));
      const voices: AudioVoice[] = listed.length ? listed : namedVoices(KNOWN_VOICES);
      const capabilities = soundModel({ kinds: ['speech'], voices, defaultVoice: voices.find((v) => v.id === 'eve')?.id ?? voices[0]!.id, direction: true, speed: true, maxChars: MAX_CHARS });
      return [listedModel(instance, XAI_SPEECH_MODEL, capabilities, 'catalog', { displayName: 'Grok voice' })];
    },
    health(signal) {
      return probe(deps, instance, `${instance.baseUrl}/v1/tts/voices`, headers(instance, false), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request));
    },
  };
}
