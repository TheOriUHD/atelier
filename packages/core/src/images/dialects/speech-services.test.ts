import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY } from './__fixtures__/images.ts';
import { audioRequest, MP3, soundResponse } from './__fixtures__/audio.ts';
import { createCartesia, createDeepgram, createFishAudio, createMiniMaxAudio } from './speech-services.ts';

describe('Cartesia', () => {
  it('sends the transcript in a voice with its version header, and lists voices', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /tts/bytes': () => soundResponse(), 'GET /voices': () => jsonResponse({ data: [{ id: 'c1', name: 'Katie', description: 'friendly' }] }) });
    const a = createCartesia(instance('cartesia', 'https://api.cartesia.ai'), deps(fetch));
    const models = await a.listModels();
    expect(models[0]!.capabilities.audio!.voices).toEqual([{ id: 'c1', name: 'Katie', description: 'friendly' }]);
    await events(a.generate(audioRequest({ model: 'sonic-3.6', audio: { voice: 'c1', speed: 1.2 } })));
    expect(calls.at(-1)!.headers['cartesia-version']).toBe('2026-08-14');
    expect(calls.at(-1)!.body).toEqual({ model_id: 'sonic-3.6', transcript: 'Hello there.', voice: { mode: 'id', id: 'c1' }, output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 }, generation_config: { speed: 1.2 } });
  });
});

describe('Deepgram', () => {
  it('lists Aura voices from its models, and speaks in one by naming it the model', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /v1/models': () => jsonResponse({ tts: [{ name: 'thalia', canonical_name: 'aura-2-thalia-en', languages: ['en-US'], metadata: { tags: ['feminine', 'clear'], accent: 'American' } }] }), 'POST /v1/speak': () => soundResponse() });
    const a = createDeepgram(instance('deepgram', 'https://api.deepgram.com'), deps(fetch));
    expect((await a.listModels())[0]!.capabilities.audio!.voices).toEqual([{ id: 'aura-2-thalia-en', name: 'Thalia', description: 'feminine, clear, American', languages: ['en-US'] }]);
    await events(a.generate(audioRequest({ model: 'aura-2', audio: { voice: 'aura-2-thalia-en' } })));
    expect(calls.at(-1)!.url).toBe('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3');
    expect(calls.at(-1)!.headers.authorization).toBe(`Token ${KEY}`);
    expect(calls.at(-1)!.body).toEqual({ text: 'Hello there.' });
  });
});

describe('Fish Audio', () => {
  it('sends the model in a header and a voice as its reference id', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/tts': () => soundResponse(), 'GET /model': () => jsonResponse({ items: [{ _id: 'f1', title: 'Narrator', description: 'deep' }] }) });
    const a = createFishAudio(instance('fish-audio', 'https://api.fish.audio'), deps(fetch));
    expect((await a.listModels())[0]!.capabilities.audio!.voices).toEqual([{ id: 'f1', name: 'Narrator', description: 'deep' }]);
    await events(a.generate(audioRequest({ model: 's2.1-pro', audio: { voice: 'f1', direction: 'whispering' } })));
    expect(calls.at(-1)!.headers.model).toBe('s2.1-pro');
    expect(calls.at(-1)!.body).toEqual({ text: '(whispering) Hello there.', format: 'mp3', reference_id: 'f1' });
  });

  it('speaks to Fish Speech on someone’s computer without a model header', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/tts': () => soundResponse() });
    const a = createFishAudio(instance('fish-audio', 'http://127.0.0.1:8080', { preset: 'fish-speech' }), deps(fetch));
    expect((await a.listModels()).map((m) => m.modelId)).toEqual(['fish-speech']);
    await events(a.generate(audioRequest({ model: 'fish-speech' })));
    expect(calls.at(-1)!.headers.model).toBeUndefined();
  });
});

describe('MiniMax speech', () => {
  it('decodes the hex sound, and reads errors inside a 200', async () => {
    const hex = Buffer.from(MP3).toString('hex');
    const { fetch, calls } = fakeFetch({ 'POST /v1/t2a_v2': () => jsonResponse({ data: { audio: hex, status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }) });
    const out = await events(createMiniMaxAudio(instance('minimax-audio', 'https://api.minimax.io'), deps(fetch)).generate(audioRequest({ model: 'speech-2.8-hd', audio: { voice: 'Wise_Woman', speed: 1.1 } })));
    expect(calls[0]!.body).toMatchObject({ model: 'speech-2.8-hd', text: 'Hello there.', output_format: 'hex', voice_setting: { voice_id: 'Wise_Woman', speed: 1.1 }, audio_setting: { format: 'mp3' } });
    expect(new Uint8Array((out.find((e) => e.type === 'audio') as { bytes: Uint8Array }).bytes)).toEqual(MP3);
    const refused = fakeFetch({ 'POST /v1/t2a_v2': () => jsonResponse({ base_resp: { status_code: 1026, status_msg: 'input sensitive' } }) });
    expect(finishOf(await events(createMiniMaxAudio(instance('minimax-audio', 'https://api.minimax.io'), deps(refused.fetch)).generate(audioRequest()))).reason).toBe('refused');
  });

  it('lists its voices from every kind the account has', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/get_voice': () => jsonResponse({ system_voice: [{ voice_id: 'Wise_Woman', voice_name: 'Wise Woman', description: ['calm'] }], voice_cloning: [{ voice_id: 'mine' }], base_resp: { status_code: 0 } }) });
    const a = createMiniMaxAudio(instance('minimax-audio', 'https://api.minimax.io'), deps(fetch));
    expect((await a.listModels())[0]!.capabilities.audio!.voices!.map((v) => v.id)).toEqual(['mine', 'Wise_Woman']);
    expect((await a.health()).ok).toBe(true);
  });
});
