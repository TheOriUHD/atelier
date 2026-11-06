import { describe, expect, it } from 'vitest';
import { audioOf } from '../audio-params.ts';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse } from './__fixtures__/images.ts';
import { audioRequest } from './__fixtures__/audio.ts';
import { audioBody, audioCapabilities, audioKinds, readAudioInputs, soundUrl } from './audio-schema.ts';
import { createFal } from './fal.ts';
import { createReplicate } from './replicate.ts';

/** A speech endpoint's input as fal publishes it: the voice is an enum, the words `text`. */
const TTS_INPUT = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 5000 },
    voice: { type: 'string', enum: ['Rachel', 'Aria', 'Roger'], default: 'Rachel' },
    speed: { type: 'number', minimum: 0.7, maximum: 1.2 },
    language_code: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    output_format: { type: 'string', enum: ['mp3_44100_128', 'pcm_16000'] },
  },
  required: ['text'],
};
/** A music endpoint: a prompt, lyrics and a length in seconds as an integer. */
const MUSIC_INPUT = {
  type: 'object',
  properties: { prompt: { type: 'string' }, lyrics: { type: 'string' }, duration: { type: 'integer', minimum: 10, maximum: 240, default: 60 }, seed: { type: 'integer' }, negative_prompt: { type: 'string' } },
  required: ['prompt'],
};
const entry = (id: string, category: string, input: object) => ({
  endpoint_id: id,
  metadata: { display_name: id.split('/').pop(), category },
  openapi: { paths: { [`/${id}`]: { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } } } } }, components: { schemas: { Input: input } } },
});

describe('sound models read from their schemas', () => {
  it('reads a speech endpoint: its words, its voices and its limits', () => {
    const schema = readAudioInputs(TTS_INPUT, {})!;
    expect(schema).toMatchObject({ text: 'text', voice: 'voice', speed: 'speed', language: 'language_code' });
    const kinds = audioKinds(schema, { category: 'text-to-speech', id: 'fal-ai/elevenlabs/tts/eleven-v4' });
    expect(kinds).toEqual(['speech']);
    expect(audioOf(audioCapabilities(schema, kinds, 'fal-audio'))).toMatchObject({ kinds: ['speech'], voices: [{ id: 'Rachel' }, { id: 'Aria' }, { id: 'Roger' }], defaultVoice: 'Rachel', speed: true, maxChars: 5000 });
    expect(audioBody(schema, audioRequest({ audio: { voice: 'Aria', speed: 1.1, language: 'en' } }))).toEqual({ text: 'Hello there.', voice: 'Aria', speed: 1.1, language_code: 'en', output_format: 'mp3_44100_128' });
  });

  it('reads a music endpoint, whose length is an integer and whose words are lyrics', () => {
    const schema = readAudioInputs(MUSIC_INPUT, {})!;
    const kinds = audioKinds(schema, { category: 'text-to-audio', id: 'fal-ai/ace-step' });
    expect(kinds).toEqual(['music']);
    const caps = audioCapabilities(schema, kinds, 'fal-audio');
    expect(audioOf(caps)).toMatchObject({ durations: { kind: 'range', min: 10, max: 240, step: 1 }, defaultSeconds: 60, lyrics: true, vocals: 'optional' });
    expect(caps).toMatchObject({ seed: true, negativePrompt: true });
    expect(audioBody(schema, audioRequest({ prompt: 'jazz', audio: { kind: 'music', seconds: 30.4, lyrics: 'la' }, seed: 2 }))).toEqual({ prompt: 'jazz', lyrics: 'la', duration: 30, seed: 2 });
  });

  it('takes a length in milliseconds for what it is', () => {
    const schema = readAudioInputs({ properties: { prompt: { type: 'string' }, music_length_ms: { type: 'integer', minimum: 3000, maximum: 600000 } } }, {})!;
    expect(audioOf(audioCapabilities(schema, ['music'], 'x')).durations).toEqual({ kind: 'range', min: 3, max: 600 });
    expect(audioBody(schema, audioRequest({ audio: { kind: 'music', seconds: 12 } }))).toMatchObject({ music_length_ms: 12000 });
  });

  it('finds the sound in the shapes services answer with', () => {
    expect(soundUrl({ audio: { url: 'https://v3.fal.media/a.mp3' } })).toBe('https://v3.fal.media/a.mp3');
    expect(soundUrl({ audio_file: { url: 'https://x/b.wav' } })).toBe('https://x/b.wav');
    expect(soundUrl({ audio_url: 'https://x/c.mp3' })).toBe('https://x/c.mp3');
    expect(soundUrl(['https://replicate.delivery/d.mp3'])).toBe('https://replicate.delivery/d.mp3');
    expect(soundUrl({ text: 'no sound' })).toBeUndefined();
  });
});

describe('fal.ai audio', () => {
  it('lists its speech and sound endpoints and runs one through the queue', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/models': (call) => jsonResponse({ models: new URL(call.url).searchParams.get('category') === 'text-to-speech' ? [entry('fal-ai/elevenlabs/tts/eleven-v4', 'text-to-speech', TTS_INPUT)] : [entry('fal-ai/ace-step', 'text-to-audio', MUSIC_INPUT)] }),
      'POST /fal-ai/elevenlabs/tts/eleven-v4': () => jsonResponse({ request_id: 'r', status_url: 'https://queue.fal.run/fal-ai/elevenlabs/requests/r/status', response_url: 'https://queue.fal.run/fal-ai/elevenlabs/requests/r' }),
      'GET /fal-ai/elevenlabs/requests/r/status': () => jsonResponse({ status: 'COMPLETED' }),
      'GET /fal-ai/elevenlabs/requests/r': () => jsonResponse({ audio: { url: 'https://v3.fal.media/files/a.mp3', content_type: 'audio/mpeg' } }),
    });
    const fal = createFal(instance('fal', 'https://queue.fal.run', { preset: 'fal-audio' }), deps(fetch), { pollMs: 0 });
    const models = await fal.listModels();
    expect(models.map((m) => [m.modelId, m.capabilities.audio?.kinds])).toEqual([
      ['fal-ai/elevenlabs/tts/eleven-v4', ['speech']],
      ['fal-ai/ace-step', ['music']],
    ]);
    const out = await events(fal.generate(audioRequest({ model: 'fal-ai/elevenlabs/tts/eleven-v4', audio: { voice: 'Roger' } })));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ text: 'Hello there.', voice: 'Roger', output_format: 'mp3_44100_128' });
    expect(out).toContainEqual({ type: 'audio', url: 'https://v3.fal.media/files/a.mp3' });
    expect(finishOf(out).reason).toBe('done');
  });
});

describe('Replicate audio', () => {
  it('reads a model’s schema and hands over the sound’s address', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/collections/text-to-speech': () => jsonResponse({ models: [] }),
      'GET /v1/collections/ai-music-generation': () => jsonResponse({ models: [{ owner: 'meta', name: 'musicgen' }] }),
      'GET /v1/models/meta/musicgen': () => jsonResponse({ description: 'Music from text', latest_version: { openapi_schema: { components: { schemas: { Input: { properties: { prompt: { type: 'string' }, duration: { type: 'integer', minimum: 1, maximum: 30, default: 8 } } } } } } } }),
      'POST /v1/predictions': () => jsonResponse({ status: 'succeeded', output: 'https://replicate.delivery/out.mp3', urls: {} }),
    });
    const replicate = createReplicate(instance('replicate', 'https://api.replicate.com', { preset: 'replicate-audio' }), deps(fetch), { pollMs: 0 });
    const [musicgen] = await replicate.listModels();
    expect(musicgen).toMatchObject({ modelId: 'meta/musicgen', description: 'Music from text' });
    expect(audioOf(musicgen!.capabilities)).toMatchObject({ kinds: ['music'], durations: { kind: 'range', min: 1, max: 30 }, defaultSeconds: 8 });
    const out = await events(replicate.generate(audioRequest({ model: 'meta/musicgen', prompt: 'drums', audio: { kind: 'music', seconds: 10 } })));
    expect((calls.at(-1)!.body as { input: unknown }).input).toEqual({ prompt: 'drums', duration: 10 });
    expect(out).toContainEqual({ type: 'audio', url: 'https://replicate.delivery/out.mp3' });
  });
});
