/**
 * One short real sound from each audio service: a sentence of speech, or a few seconds of music or an effect. The cloud
 * ones cost money, so each is skipped unless its key is set in the environment:
 *   ATELIER_LIVE_<SERVICE>_KEY    the service's API key
 *   ATELIER_LIVE_<SERVICE>_MODEL  optional, instead of the model named below
 *   ATELIER_LIVE_<SERVICE>_URL    optional, instead of the preset's address (Azure needs it)
 * A server on someone's own computer needs no key, only its address: ATELIER_LIVE_KOKORO_URL=http://127.0.0.1:8880, and
 * the same for SPEACHES, LOCALAI, KOBOLDCPP, CHATTERBOX, OLLAMA, ACESTEP and FISHSPEECH.
 * Keys are only passed to the adapters; nothing here prints them.
 */
import { describe, expect, it } from 'vitest';
import { imagePreset, type AudioKind } from '@atelier/protocol';
import { audioFacts, checkAudio, isPcm, pcmRate, pcmToWav } from './audio.ts';
import { fitAudio } from './audio-params.ts';
import { downloadAudio } from './download.ts';
import { createImageAdapter } from './index.ts';
import type { ImageAdapterDeps, ImageEvent, ImageRequest } from './types.ts';

interface Service {
  name: string;
  preset: string;
  model?: string;
  kind: AudioKind;
  /** A server on someone's own computer: run when its address is set, with no key. */
  local?: boolean;
}

const SERVICES: Service[] = [
  { name: 'OPENAI_SPEECH', preset: 'openai-speech', model: 'gpt-4o-mini-tts', kind: 'speech' },
  { name: 'AZURE_SPEECH', preset: 'azure-speech', model: 'gpt-4o-mini-tts', kind: 'speech' },
  { name: 'ELEVENLABS', preset: 'elevenlabs', model: 'eleven_flash_v2_5', kind: 'speech' },
  { name: 'ELEVENLABS_MUSIC', preset: 'elevenlabs', model: 'music_v2_5', kind: 'music' },
  { name: 'ELEVENLABS_SFX', preset: 'elevenlabs', model: 'eleven_text_to_sound_v3', kind: 'sound' },
  { name: 'GEMINI_SPEECH', preset: 'gemini-audio', model: 'gemini-3.8-flash-lite-tts', kind: 'speech' },
  { name: 'GEMINI_MUSIC', preset: 'gemini-audio', model: 'lyria-3-clip-preview', kind: 'music' },
  { name: 'XAI_SPEECH', preset: 'xai-speech', kind: 'speech' },
  { name: 'STABILITY_AUDIO', preset: 'stability-audio', model: 'stable-audio-2.5', kind: 'sound' },
  { name: 'MISTRAL_SPEECH', preset: 'mistral-speech', model: 'voxtral-mini-tts-3-0', kind: 'speech' },
  { name: 'GROQ_SPEECH', preset: 'groq-speech', model: 'canopylabs/orpheus-v1-english', kind: 'speech' },
  { name: 'CARTESIA', preset: 'cartesia', model: 'sonic-3.6', kind: 'speech' },
  { name: 'DEEPGRAM', preset: 'deepgram', kind: 'speech' },
  { name: 'FISH_AUDIO', preset: 'fish-audio', model: 's2.1-pro', kind: 'speech' },
  { name: 'MINIMAX_SPEECH', preset: 'minimax-audio', model: 'speech-2.8-turbo', kind: 'speech' },
  { name: 'OPENROUTER_SPEECH', preset: 'openrouter-speech', model: 'openai/gpt-4o-mini-tts-2025-12-15', kind: 'speech' },
  { name: 'TOGETHER_SPEECH', preset: 'together-speech', model: 'hexgrad/Kokoro-82M', kind: 'speech' },
  { name: 'FAL_AUDIO', preset: 'fal-audio', model: 'fal-ai/stable-audio-25/text-to-audio', kind: 'sound' },
  { name: 'REPLICATE_AUDIO', preset: 'replicate-audio', model: 'meta/musicgen', kind: 'music' },
  { name: 'KOKORO', preset: 'kokoro', kind: 'speech', local: true },
  { name: 'SPEACHES', preset: 'speaches', kind: 'speech', local: true },
  { name: 'LOCALAI', preset: 'localai-speech', kind: 'speech', local: true },
  { name: 'KOBOLDCPP', preset: 'koboldcpp-speech', kind: 'speech', local: true },
  { name: 'CHATTERBOX', preset: 'chatterbox', kind: 'speech', local: true },
  { name: 'OLLAMA', preset: 'ollama-speech', kind: 'speech', local: true },
  { name: 'ACESTEP', preset: 'acestep', kind: 'music', local: true },
  { name: 'FISHSPEECH', preset: 'fish-speech', kind: 'speech', local: true },
];

const env = (name: string) => process.env[name] || undefined;
const deps: ImageAdapterDeps = { fetch: (url, init) => fetch(url, init), socket: () => Promise.reject(new Error('Not used by sound services.')) };
const TEXT: Record<AudioKind, string> = { speech: 'Hello! This is a short test of how this voice sounds.', music: 'A calm, warm piano melody', sound: 'A single soft knock on a wooden door' };

describe.each(SERVICES)('$name', (service) => {
  const key = env(`ATELIER_LIVE_${service.name}_KEY`);
  const url = env(`ATELIER_LIVE_${service.name}_URL`);
  it.skipIf(service.local ? !url : !key)(`makes a short ${service.kind === 'speech' ? 'sentence' : service.kind}`, { timeout: 300_000 }, async () => {
    const preset = imagePreset(service.preset)!;
    const wanted = env(`ATELIER_LIVE_${service.name}_MODEL`) ?? service.model;
    const instance = { id: 'live', type: preset.type, preset: preset.id, name: preset.label, baseUrl: url ?? preset.baseUrl, ...(key ? { apiKey: key } : {}), headers: {}, models: wanted ? [wanted] : [], workflows: [] };
    const adapter = createImageAdapter(instance, deps);
    expect((await adapter.health(AbortSignal.timeout(30_000))).ok).toBe(true);
    const models = (await adapter.listModels(AbortSignal.timeout(60_000))).filter((m) => m.capabilities.audio?.kinds.includes(service.kind));
    const model = wanted ? models.find((m) => m.modelId === wanted) : models[0];
    expect(model, `${wanted ?? 'a sound model'} wasn't listed`).toBeDefined();
    const fit = fitAudio(model!.capabilities, { kind: service.kind, text: TEXT[service.kind], seconds: service.kind === 'speech' ? undefined : 5 });
    const request: ImageRequest = {
      model: model!.modelId,
      prompt: TEXT[service.kind],
      count: 1,
      quality: 'draft',
      references: [],
      tuning: {},
      loras: [],
      capabilities: model!.capabilities,
      signal: AbortSignal.timeout(280_000),
      audio: { kind: service.kind, ...(fit.voice ? { voice: fit.voice } : {}), ...(fit.seconds !== undefined ? { seconds: fit.seconds } : {}), ...(service.kind === 'music' ? { instrumental: true } : {}) },
    };
    const events: ImageEvent[] = [];
    for await (const event of adapter.generate(request)) events.push(event);
    const finish = events.at(-1);
    expect(finish, JSON.stringify(finish)).toMatchObject({ type: 'finish', reason: 'done' });
    const sound = events.find((e) => e.type === 'audio');
    expect(sound).toBeDefined();
    const raw = sound?.bytes ?? (await downloadAudio({ fetch: (u, init) => fetch(u, init) }, sound!.url!, request.signal)).bytes;
    const bytes = isPcm(sound?.mime) ? pcmToWav(raw, pcmRate(sound!.mime!)) : raw;
    expect(checkAudio(bytes)).toMatch(/^audio\//);
    expect(audioFacts(bytes).seconds ?? 1).toBeGreaterThan(0.3);
  });
});
