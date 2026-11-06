import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY } from './__fixtures__/images.ts';
import { audioRequest, MP3, soundResponse } from './__fixtures__/audio.ts';
import { createElevenLabs } from './elevenlabs.ts';

const BASE = 'https://api.elevenlabs.io';
const adapter = (fetch: Parameters<typeof deps>[0]) => createElevenLabs(instance('elevenlabs', BASE), deps(fetch));
const MODELS = [
  { model_id: 'eleven_v4', name: 'Eleven v4', can_do_text_to_speech: true, maximum_text_length_per_request: 10000, languages: [{ language_id: 'en', name: 'English' }] },
  { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true },
  { model_id: 'eleven_multilingual_sts_v2', name: 'STS', can_do_text_to_speech: false },
];

describe('ElevenLabs', () => {
  it('lists its speech models with the account’s voices, every page of them, and its music and effect models', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/models': () => jsonResponse(MODELS),
      'GET /v2/voices': (call) =>
        jsonResponse(new URL(call.url).searchParams.get('next_page_token') ? { voices: [{ voice_id: 'v2', name: 'Mine', category: 'cloned' }], has_more: false } : { voices: [{ voice_id: 'v1', name: 'Rachel', labels: { accent: 'American', gender: 'female' } }], has_more: true, next_page_token: 'p2' }),
    });
    const models = await adapter(fetch).listModels();
    expect(calls[0]!.headers['xi-api-key']).toBe(KEY);
    expect(models.map((m) => m.modelId)).toEqual(['eleven_v4', 'eleven_flash_v2_5', 'music_v2_5', 'music_v2', 'eleven_text_to_sound_v3']);
    expect(models[0]!.capabilities.audio).toMatchObject({ kinds: ['speech'], voices: [{ id: 'v1', name: 'Rachel', description: 'American, female' }, { id: 'v2', name: 'Mine' }], direction: true, maxChars: 10000, languages: ['en'] });
    expect(models[1]!.capabilities.audio).toMatchObject({ maxChars: 40000 });
    expect(models[1]!.capabilities.audio!.direction).toBeUndefined();
    expect(models[2]!.capabilities.audio).toMatchObject({ kinds: ['music'], durations: { kind: 'range', min: 3, max: 600 } });
    expect(models[4]!.capabilities.audio).toMatchObject({ kinds: ['sound'], durations: { kind: 'range', min: 0.5, max: 30 } });
  });

  it('reads text in the chosen voice, with a direction as an audio tag on models that read them', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/text-to-speech/v1': () => soundResponse() });
    const caps = (await adapter(fakeFetch({ 'GET /v1/models': () => jsonResponse(MODELS), 'GET /v2/voices': () => jsonResponse({ voices: [] }) }).fetch).listModels())[0]!.capabilities;
    const out = await events(adapter(fetch).generate({ ...audioRequest({ model: 'eleven_v4', audio: { voice: 'v1', direction: 'whispers', speed: 2, language: 'en' }, seed: 4 }), capabilities: caps }));
    expect(calls[0]!.url).toBe(`${BASE}/v1/text-to-speech/v1?output_format=mp3_44100_128`);
    expect(calls[0]!.body).toEqual({ text: '[whispers] Hello there.', model_id: 'eleven_v4', language_code: 'en', voice_settings: { speed: 1.2 }, seed: 4 });
    expect(out.find((e) => e.type === 'audio')).toMatchObject({ bytes: MP3 });
    expect(finishOf(out).reason).toBe('done');
  });

  it('makes music and sound effects on their own routes', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/music': () => soundResponse(), 'POST /v1/sound-generation': () => soundResponse() });
    await events(adapter(fetch).generate(audioRequest({ model: 'music_v2_5', prompt: 'lofi beat', audio: { kind: 'music', seconds: 12.5, instrumental: true } })));
    expect(calls[0]!.body).toEqual({ prompt: 'lofi beat', model_id: 'music_v2_5', music_length_ms: 12500, force_instrumental: true });
    await events(adapter(fetch).generate(audioRequest({ model: 'eleven_text_to_sound_v3', prompt: 'door creak', audio: { kind: 'sound', seconds: 3 } })));
    expect(calls[1]!.body).toEqual({ text: 'door creak', model_id: 'eleven_text_to_sound_v3', duration_seconds: 3 });
  });

  it('says so when there is no voice to speak in', async () => {
    const out = await events(adapter(fakeFetch({}).fetch).generate(audioRequest()));
    expect(finishOf(out)).toMatchObject({ reason: 'error', error: { message: expect.stringContaining('no voice was chosen') } });
  });
});
