import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse, KEY, stopped } from './__fixtures__/images.ts';
import { audioRequest, MP3, soundResponse, WAV } from './__fixtures__/audio.ts';
import { createOpenAiSpeech, speakerTurns, speechBody } from './openai-speech.ts';

const adapter = (preset: string, baseUrl: string, fetch: Parameters<typeof deps>[0], models: string[] = []) => createOpenAiSpeech(instance('openai-speech', baseUrl, { preset, models }), deps(fetch));
const soundOf = (list: Awaited<ReturnType<typeof events>>) => list.find((e) => e.type === 'audio') as Extract<(typeof list)[number], { type: 'audio' }> | undefined;

describe('OpenAI speech', () => {
  it("lists OpenAI's models with their voices, direction only where the model takes it", async () => {
    const models = await adapter('openai-speech', 'https://api.openai.com', fakeFetch({}).fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1']);
    expect(models[0]!.capabilities.audio).toMatchObject({ kinds: ['speech'], defaultVoice: 'alloy', direction: true, speed: true, maxChars: 4096 });
    expect(models[0]!.capabilities.audio!.voices).toHaveLength(13);
    expect(models[2]!.capabilities.audio!.direction).toBeUndefined();
    expect(models[2]!.capabilities.audio!.voices!.map((v) => v.id)).not.toContain('marin');
  });

  it('sends only the fields that are set, and keeps the bytes it gets', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/audio/speech': () => soundResponse() });
    const out = await events(adapter('openai-speech', 'https://api.openai.com', fetch).generate(audioRequest({ model: 'gpt-4o-mini-tts', audio: { voice: 'coral', direction: 'calm', speed: 1.1 } })));
    expect(calls[0]!.body).toEqual({ model: 'gpt-4o-mini-tts', input: 'Hello there.', voice: 'coral', response_format: 'mp3', speed: 1.1, instructions: 'calm' });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(soundOf(out)?.bytes).toEqual(MP3);
    expect(finishOf(out).reason).toBe('done');
  });

  it("leaves out what a server can't take: Ollama refuses a field it doesn't know", async () => {
    const body = speechBody(instance('openai-speech', 'http://127.0.0.1:11434', { preset: 'ollama-speech' }), audioRequest({ model: 'phonon', audio: { voice: 'alba', direction: 'calm', speed: 1.2, language: 'en' } }));
    expect(body).toEqual({ model: 'phonon', input: 'Hello there.', voice: 'alba', response_format: 'wav' });
    // Kokoro streams unless told not to.
    expect(speechBody(instance('openai-speech', 'http://127.0.0.1:8880', { preset: 'kokoro' }), audioRequest({ model: 'kokoro' }))).toMatchObject({ stream: false, response_format: 'mp3' });
    // Mistral calls the voice `voice_id`.
    expect(speechBody(instance('openai-speech', 'https://api.mistral.ai', { preset: 'mistral-speech' }), audioRequest({ audio: { voice: 'gb_jane_neutral' } }))).toMatchObject({ voice_id: 'gb_jane_neutral' });
  });

  it('reads base64 inside JSON, as Mistral answers', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/audio/speech': () => jsonResponse({ audio_data: Buffer.from(MP3).toString('base64') }) });
    const out = await events(adapter('mistral-speech', 'https://api.mistral.ai', fetch).generate(audioRequest()));
    expect(new Uint8Array(soundOf(out)!.bytes!)).toEqual(MP3);
  });

  it("lists Mistral's voices from the v2 route, a preset by its slug", async () => {
    const { fetch, calls } = fakeFetch({ 'GET /v2/audio/voices': () => jsonResponse({ data: [{ id: 'uuid-1', slug: 'gb_jane_neutral', name: 'Jane', gender: 'female', languages: ['en'] }, { id: 'uuid-2', slug: null, name: 'Mine' }], next_page_token: null }) });
    const models = await adapter('mistral-speech', 'https://api.mistral.ai', fetch).listModels();
    expect(calls[0]!.url).toContain('/v2/audio/voices?page_size=100');
    expect(models[0]!.capabilities.audio!.voices).toEqual([
      { id: 'gb_jane_neutral', name: 'Jane', description: 'female', languages: ['en'] },
      { id: 'uuid-2', name: 'Mine' },
    ]);
  });

  it('asks Azure on the deployment route with its key header, and Groq for WAV', async () => {
    const azure = fakeFetch({ 'POST /openai/deployments/my-tts/audio/speech': () => soundResponse() });
    await events(adapter('azure-speech', 'https://r.openai.azure.com', azure.fetch).generate(audioRequest({ model: 'my-tts' })));
    expect(azure.calls[0]!.url).toContain('api-version=2025-04-01-preview');
    expect(azure.calls[0]!.headers['api-key']).toBe(KEY);
    const groq = await adapter('groq-speech', 'https://api.groq.com/openai', fakeFetch({}).fetch).listModels();
    expect(groq[1]!.capabilities.audio!.voices!.map((v) => v.id)).toEqual(['abdullah', 'fahad', 'sultan', 'lulwa', 'noura', 'aisha']);
    expect(groq[0]!.capabilities.audio).toMatchObject({ maxChars: 200 });
    expect(speechBody(instance('openai-speech', 'https://api.groq.com/openai', { preset: 'groq-speech' }), audioRequest({ audio: { direction: 'cheerful' } }))).toEqual({ model: 'm', input: 'Hello there.', response_format: 'wav' });
  });

  it("lists Kokoro's own model and its voices, in Kokoro's answer shape", async () => {
    const { fetch } = fakeFetch({
      'GET /v1/models': () => jsonResponse({ data: [{ id: 'tts-1' }, { id: 'kokoro' }, { id: 'tts-1-hd' }] }),
      'GET /v1/audio/voices': () => jsonResponse({ voices: [{ id: 'af_heart', name: 'af_heart' }, { id: 'bm_george', name: 'bm_george' }], default_voice: 'af_heart' }),
    });
    const models = await adapter('kokoro', 'http://127.0.0.1:8880', fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['kokoro']);
    expect(models[0]!.capabilities.audio!.voices!.map((v) => v.id)).toEqual(['af_heart', 'bm_george']);
  });

  it("reads LocalAI's voices per model, keeps only its speech models, and offers its music models on the sound route", async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/models': () => jsonResponse({ data: [{ id: 'qwen3-8b' }, { id: 'kokoro' }, { id: 'ace-step-turbo' }] }),
      'GET /v1/audio/voices': () => jsonResponse({ data: [{ model: 'kokoro', voices: ['af_bella', 'am_adam'] }] }),
      'POST /v1/sound-generation': () => soundResponse(),
    });
    const a = adapter('localai-speech', 'http://127.0.0.1:8080', fetch);
    const models = await a.listModels();
    expect(models.map((m) => m.modelId)).toEqual(['kokoro', 'ace-step-turbo']);
    expect(calls.some((c) => c.url.endsWith('/v1/audio/voices?model=kokoro'))).toBe(true);
    expect(models[0]!.capabilities.audio!.voices!.map((v) => v.id)).toEqual(['af_bella', 'am_adam']);
    expect(models[1]!.capabilities.audio).toMatchObject({ kinds: ['music', 'sound'], lyrics: true });
    await events(a.generate(audioRequest({ model: 'ace-step-turbo', prompt: 'lofi', audio: { kind: 'music', seconds: 30, lyrics: 'la', language: 'en' } })));
    expect(calls.at(-1)!.body).toEqual({ model_id: 'ace-step-turbo', text: 'lofi', duration_seconds: 30, lyrics: 'la', vocal_language: 'en' });
  });

  it("lists Ollama's models that say they speak, with their voices", async () => {
    const { fetch } = fakeFetch({
      'GET /api/tags': () => jsonResponse({ models: [{ name: 'qwen3:8b' }, { name: 'phonon:latest' }] }),
      'POST /api/show': (call) => jsonResponse((call.body as { model: string }).model === 'phonon:latest' ? { capabilities: ['speech'], voices: ['alba', 'marius'] } : { capabilities: ['completion'] }),
    });
    const models = await adapter('ollama-speech', 'http://127.0.0.1:11434', fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['phonon:latest']);
    expect(models[0]!.capabilities.audio).toMatchObject({ voices: [{ id: 'alba' }, { id: 'marius' }], maxChars: 4096 });
  });

  it("lists OpenRouter's speech models with their own voices, and asks each for the format it takes", async () => {
    const { fetch, calls } = fakeFetch({
      'GET /api/v1/models': () => jsonResponse({ data: [{ id: 'google/gemini-3.8-flash-lite-tts', name: 'Gemini TTS', supported_voices: ['Kore', 'Puck'] }, { id: 'openai/gpt-4o-mini-tts-2025-12-15', name: 'GPT TTS', supported_voices: ['alloy'] }] }),
      'POST /api/v1/audio/speech': () => new Response(WAV.subarray(44), { headers: { 'content-type': 'audio/pcm;rate=8000;channels=1' } }),
    });
    const a = adapter('openrouter-speech', 'https://openrouter.ai/api', fetch);
    const models = await a.listModels();
    expect(models[0]!.capabilities.audio).toMatchObject({ voices: [{ id: 'Kore' }, { id: 'Puck' }], maxSpeakers: 2 });
    expect(models[1]!.capabilities.audio!.maxSpeakers).toBeUndefined();
    const out = await events(a.generate(audioRequest({ model: 'google/gemini-3.8-flash-lite-tts', prompt: 'Ann: Hi!\nBo: Hello.', audio: { speakers: [{ name: 'Ann', voice: 'Kore' }, { name: 'Bo', voice: 'Puck' }], direction: 'cheerful' } })));
    expect(calls.at(-1)!.body).toEqual({ model: 'google/gemini-3.8-flash-lite-tts', input: [{ text: 'Hi!', voice: 'Kore' }, { text: 'Hello.', voice: 'Puck' }], response_format: 'pcm', instructions: 'cheerful' });
    // Raw samples are marked with their rate, for the service to wrap.
    expect(soundOf(out)?.mime).toBe('audio/L16;rate=8000');
  });

  it('splits a conversation into turns, carrying an unnamed line over to the speaker before', () => {
    expect(speakerTurns('Ann: Hi\nand bye\nBo: Yo', [{ name: 'Ann', voice: 'a' }, { name: 'Bo', voice: 'b' }])).toEqual([{ text: 'Hi and bye', voice: 'a' }, { text: 'Yo', voice: 'b' }]);
  });

  it('turns a refusal into a final one, and ends as aborted when stopped', async () => {
    const { fetch } = fakeFetch({ 'POST /v1/audio/speech': () => jsonResponse({ error: { message: 'This request was flagged by our safety system.' } }, 400) });
    expect(finishOf(await events(adapter('openai-speech', 'https://api.openai.com', fetch).generate(audioRequest()))).reason).toBe('refused');
    expect(finishOf(await events(adapter('openai-speech', 'https://api.openai.com', fakeFetch({}).fetch).generate(audioRequest({ signal: stopped() })))).reason).toBe('aborted');
  });

  it('checks health where each server answers', async () => {
    const ollama = fakeFetch({ 'GET /api/version': () => jsonResponse({ version: '0.40.15' }) });
    expect((await adapter('ollama-speech', 'http://127.0.0.1:11434', ollama.fetch).health()).ok).toBe(true);
    const kobold = fakeFetch({ 'GET /v1/audio/voices': () => jsonResponse({ status: 'ok', voices: ['kobo'] }) });
    expect((await adapter('koboldcpp-speech', 'http://127.0.0.1:5001', kobold.fetch).health()).ok).toBe(true);
  });
});
