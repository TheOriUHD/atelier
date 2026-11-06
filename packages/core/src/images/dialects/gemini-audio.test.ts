import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY } from './__fixtures__/images.ts';
import { audioRequest, MP3, WAV } from './__fixtures__/audio.ts';
import { createGeminiAudio, geminiSpeechBody, interactionSound, lyriaBody } from './gemini-audio.ts';

const adapter = (fetch: Parameters<typeof deps>[0]) => createGeminiAudio(instance('gemini-audio', 'https://generativelanguage.googleapis.com'), deps(fetch));
const answer = (data: Uint8Array, mime: string) => ({ status: 'completed', steps: [{ type: 'user_input' }, { type: 'model_output', content: [{ type: 'text', text: '[Verse]' }, { type: 'audio', data: Buffer.from(data).toString('base64'), mime_type: mime }] }] });

describe('Gemini audio', () => {
  it('lists the speech models with the 30 voices and two speakers, and Lyria', async () => {
    const models = await adapter(fakeFetch({}).fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'lyria-3.5', 'lyria-3-clip-preview']);
    expect(models[0]!.capabilities.audio).toMatchObject({ kinds: ['speech'], defaultVoice: 'Kore', maxSpeakers: 2, direction: true });
    expect(models[0]!.capabilities.audio!.voices).toHaveLength(30);
    expect(models[0]!.capabilities.audio!.voices).toContainEqual({ id: 'Sulafat', name: 'Sulafat', description: 'warm' });
    expect(models[3]!.capabilities.audio).toMatchObject({ kinds: ['music'], durations: { kind: 'list', seconds: [30] } });
  });

  it('asks for one voice as a list and two speakers as an object, a line each', () => {
    expect(geminiSpeechBody(audioRequest({ model: 'gemini-3.8-flash-tts', audio: { voice: 'Puck', direction: 'cheerful' } }))).toEqual({
      model: 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'Hello there.', annotations: [{ type: 'speech_metadata', style: 'cheerful' }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Puck' }] },
    });
    const two = geminiSpeechBody(audioRequest({ prompt: 'Joe: How is it going?\nJane: Not bad.', audio: { speakers: [{ name: 'Joe', voice: 'Puck' }, { name: 'Jane', voice: 'Kore' }] } }));
    expect(two.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'How is it going?', annotations: [{ type: 'speech_metadata', speaker: 'Joe' }] }, { type: 'text', text: 'Not bad.', annotations: [{ type: 'speech_metadata', speaker: 'Jane' }] }] }]);
    expect(two.generation_config).toEqual({ speech_config: { speakers: [{ speaker: 'Joe', voice: 'Puck' }, { speaker: 'Jane', voice: 'Kore' }] } });
  });

  it("puts Lyria's length, lyrics and instrumental into its prompt", () => {
    expect(lyriaBody(audioRequest({ model: 'lyria-3.5', prompt: 'dreamy indie pop', audio: { kind: 'music', seconds: 120, lyrics: '[Verse]\nla' } }))).toEqual({ model: 'lyria-3.5', input: 'dreamy indie pop\n\nAbout 2 minutes long.\n\nWith these lyrics:\n[Verse]\nla', response_format: { type: 'audio' } });
    expect(lyriaBody(audioRequest({ model: 'lyria-3-clip-preview', prompt: 'guitar', audio: { kind: 'music', seconds: 30, instrumental: true } })).input).toBe('guitar\n\nInstrumental only, no vocals.');
  });

  it('takes the last sound of the model output, and its key in the header', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse(answer(WAV, 'audio/wav')) });
    const out = await events(adapter(fetch).generate(audioRequest({ model: 'gemini-3.8-flash-tts' })));
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY);
    const sound = out.find((e) => e.type === 'audio') as { bytes: Uint8Array; mime?: string };
    expect(new Uint8Array(sound.bytes)).toEqual(WAV);
    expect(sound.mime).toBeUndefined();
    expect(finishOf(out).reason).toBe('done');
    expect(interactionSound(answer(MP3, 'audio/mpeg')).mime).toBe('audio/mpeg');
    // An older model's raw samples are marked for wrapping.
    const raw = await events(adapter(fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse(answer(WAV.subarray(44), 'audio/l16')) }).fetch).generate(audioRequest()));
    expect(raw.find((e) => e.type === 'audio')).toMatchObject({ mime: 'audio/L16;rate=24000' });
  });

  it('calls an answer with no sound a refusal when it was blocked', async () => {
    const { fetch } = fakeFetch({ 'POST /v1beta/interactions': () => jsonResponse({ status: 'blocked', steps: [] }) });
    expect(finishOf(await events(adapter(fetch).generate(audioRequest()))).reason).toBe('refused');
  });
});
