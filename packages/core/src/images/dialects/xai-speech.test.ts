import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse } from './__fixtures__/images.ts';
import { audioRequest, soundResponse } from './__fixtures__/audio.ts';
import { createXaiSpeech, XAI_SPEECH_MODEL } from './xai-speech.ts';

const adapter = (fetch: Parameters<typeof deps>[0]) => createXaiSpeech(instance('xai-speech', 'https://api.x.ai'), deps(fetch));

describe('xAI speech', () => {
  it('lists one model with the voices its list gives, Eve first as the service does', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/tts/voices': () => jsonResponse({ voices: [{ voice_id: 'ara', name: 'Ara', language: 'en' }, { voice_id: 'eve', name: 'Eve', language: null }] }) });
    const [model] = await adapter(fetch).listModels();
    expect(model!.modelId).toBe(XAI_SPEECH_MODEL);
    expect(model!.capabilities.audio).toMatchObject({ voices: [{ id: 'ara', name: 'Ara', languages: ['en'] }, { id: 'eve', name: 'Eve' }], defaultVoice: 'eve', maxChars: 60000 });
    // Without a list it still knows the documented voices.
    expect((await adapter(fakeFetch({}).fetch).listModels())[0]!.capabilities.audio!.voices!.map((v) => v.id)).toEqual(['eve', 'ara', 'rex', 'sal', 'leo']);
  });

  it('sends the text with its tags, the language and an MP3 format', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/tts': () => soundResponse() });
    const out = await events(adapter(fetch).generate(audioRequest({ audio: { voice: 'rex', direction: 'laugh', speed: 3 } })));
    expect(calls[0]!.body).toEqual({ text: '[laugh] Hello there.', language: 'auto', voice_id: 'rex', output_format: { codec: 'mp3', sample_rate: 44100 }, speed: 1.5 });
    expect(finishOf(out).reason).toBe('done');
  });
});
