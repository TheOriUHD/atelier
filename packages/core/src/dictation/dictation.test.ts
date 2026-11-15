import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DictationUpdate, ImageProviderConfig, ProviderConfig } from '@atelier/protocol';
import { joinText, type DictationConnect, type SocketHandlers } from './engine.ts';
import { openMistralRealtime } from './mistral-realtime.ts';
import { openPhrases, wavOf } from './phrases.ts';
import { DictationError, DictationService } from './service.ts';
import { dictationChoices, pickDictation } from './sources.ts';
import { TranscribeError, transcribe } from './transcribe.ts';

const text = (id: string, type: ProviderConfig['type'], baseUrl: string, enabled = true): ProviderConfig => ({ id, type, name: id, baseUrl, headers: {}, enabled });
const media = (id: string, preset: string, baseUrl: string, models?: string[]): ImageProviderConfig => ({
  id,
  type: 'openai-speech',
  preset,
  name: id,
  baseUrl,
  headers: {},
  enabled: true,
  ...(models ? { models } : {}),
});

/** `ms` of 16 kHz PCM: a loud 220 Hz tone for speech, zeros for silence. */
function pcm(ms: number, loud: boolean, amplitude = 8000): Uint8Array {
  const n = Math.round((ms * 16_000) / 1000);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, loud ? Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * amplitude) : 0, true);
  return out;
}

/** The loudest sample of a WAV file: tells the test's phrases apart. */
function peak(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44);
  let max = 0;
  for (let i = 0; i + 1 < view.byteLength; i += 2) max = Math.max(max, Math.abs(view.getInt16(i, true)));
  return max;
}

describe('which services dictation can use', () => {
  it('finds them in the providers already set up, live ones first, each service once', () => {
    const all = dictationChoices(
      [text('oai', 'openai', 'https://api.openai.com'), text('mis', 'mistral-vibe', 'https://api.mistral.ai'), text('olla', 'ollama', 'http://127.0.0.1:11434'), text('groq', 'openai-compatible', 'https://api.groq.com/openai/v1')],
      [media('voxtral', 'mistral-speech', 'https://api.mistral.ai'), media('speaches', 'speaches', 'http://box:8000', ['speaches-ai/Kokoro-82M', 'Systran/faster-whisper-small'])],
    );
    expect(all.map((c) => c.source.id)).toEqual([
      'text:mis:voxtral-mini-transcribe-realtime-3',
      'media:speaches:Systran/faster-whisper-small',
      'text:oai:gpt-4o-transcribe',
      'text:oai:gpt-4o-mini-transcribe',
      'text:groq:whisper-large-v3-turbo',
    ]);
    expect(all[0]!.source).toMatchObject({ label: 'Voxtral Realtime', provider: 'mis', live: true });
    expect(all[1]!.source).toMatchObject({ label: 'faster-whisper-small', live: false });
  });

  it('leaves out switched-off providers and local speech servers without a speech-to-text model', () => {
    expect(dictationChoices([text('m', 'mistral', 'https://api.mistral.ai', false)], [media('k', 'kokoro', 'http://x:8880'), media('s', 'speaches', 'http://x:8000', ['kokoro'])])).toEqual([]);
  });

  it('takes the admin’s choice while it exists, else the best', () => {
    const all = dictationChoices([text('oai', 'openai', 'https://api.openai.com')], []);
    expect(pickDictation(all, 'text:oai:gpt-4o-mini-transcribe')?.model).toBe('gpt-4o-mini-transcribe');
    expect(pickDictation(all, 'text:gone:x')?.model).toBe('gpt-4o-transcribe');
    expect(pickDictation([], undefined)).toBeNull();
  });
});

describe('joining what was said', () => {
  it('puts a space between words, but not between two pieces of Chinese or Japanese', () => {
    expect(joinText('Hello', 'world.')).toBe('Hello world.');
    expect(joinText('', ' first')).toBe('first');
    expect(joinText('你好', '世界')).toBe('你好世界');
  });
});

describe('a phrase at a time', () => {
  afterEach(() => vi.useRealTimers());

  it('cuts at pauses, sends no silence, shows words while a phrase is said and ends with every phrase in order', async () => {
    const sent: { bytes: number; before: string }[] = [];
    const seen: string[] = [];
    const engine = openPhrases({
      onText: (t) => seen.push(t),
      onError: (m) => {
        throw new Error(m);
      },
      transcribe: async (wav, before) => {
        sent.push({ bytes: wav.byteLength, before });
        // The second phrase is said louder.
        return peak(wav) > 10_000 ? 'How are you?' : 'Hello there.';
      },
    });
    engine.write(pcm(2000, false));
    engine.write(pcm(1500, true));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.at(-1)).toBe('Hello there.');
    engine.write(pcm(900, false));
    engine.write(pcm(1200, true, 12_000));
    engine.write(pcm(900, false));
    const final = await engine.finish();
    expect(final).toBe('Hello there. How are you?');
    // Two seconds of silence before the first word were never sent: at most the 300 ms before it.
    expect(Math.max(...sent.map((s) => s.bytes))).toBeLessThan(44 + 16_000 * 2 * 2.2);
    expect(sent.at(-1)!.before).toBe('Hello there.');
  });

  it('sends nothing for silence or a click', async () => {
    const transcribe = vi.fn(async () => 'Thank you.');
    const engine = openPhrases({ onText: () => {}, onError: () => {}, transcribe });
    engine.write(pcm(3000, false));
    engine.write(pcm(60, true));
    engine.write(pcm(1000, false));
    expect(await engine.finish()).toBe('');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('cuts a phrase without pauses before it gets too long', async () => {
    const lengths: number[] = [];
    const engine = openPhrases({
      onText: () => {},
      onError: () => {},
      maxPhraseMs: 3000,
      transcribe: async (wav) => (lengths.push(wav.byteLength), 'word'),
    });
    engine.write(pcm(7000, true));
    await engine.finish();
    expect(Math.max(...lengths)).toBeLessThanOrEqual(44 + 3000 * 32 + 3200);
  });

  it('says why when the service fails twice for one phrase', async () => {
    const errors: string[] = [];
    const engine = openPhrases({ onText: () => {}, onError: (m) => errors.push(m), transcribe: async () => Promise.reject(new TranscribeError('Groq refused the key (401).', 401)) });
    engine.write(pcm(1000, true));
    await expect(engine.finish()).rejects.toThrow('Groq refused the key (401).');
    expect(errors).toEqual(['Groq refused the key (401).']);
  });

  it('waits out a rate limit before transcribing a phrase for good, and sends no looks meanwhile', async () => {
    let calls = 0;
    const engine = openPhrases({
      onText: () => {},
      onError: (m) => {
        throw new Error(m);
      },
      transcribe: async () => {
        calls++;
        if (calls === 1) throw new TranscribeError('Groq is rate-limiting dictation (429).', 429, 20);
        return 'Made it.';
      },
    });
    // Short enough to have no look: the first call is the final one.
    engine.write(pcm(600, true));
    expect(await engine.finish()).toBe('Made it.');
    expect(calls).toBe(2);
  });

  it('writes a WAV header for 16 kHz mono 16-bit', () => {
    const wav = wavOf(new Uint8Array(320));
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(320);
  });
});

/** A Mistral realtime server: records what the client sends and answers as told. */
function fakeMistral(script: (message: { type: string; [k: string]: unknown }, reply: (event: object) => void) => void, opening: object[] = [{ type: 'session.created', session: {} }]) {
  const sent: { type: string; [k: string]: unknown }[] = [];
  const seen: { url: string; headers: Record<string, string> } = { url: '', headers: {} };
  let handlers: SocketHandlers;
  const connect: DictationConnect = async (url, headers, h) => {
    seen.url = url;
    seen.headers = headers;
    handlers = h;
    queueMicrotask(() => opening.forEach((e) => handlers.onMessage(JSON.stringify(e))));
    return {
      send(data) {
        const message = JSON.parse(data) as { type: string };
        sent.push(message);
        script(message, (event) => queueMicrotask(() => handlers.onMessage(JSON.stringify(event))));
      },
      close() {},
    };
  };
  return { connect, sent, seen, close: (code: number, reason: string) => handlers.onClose(code, reason) };
}

describe('Mistral realtime', () => {
  const base = { baseUrl: 'https://api.mistral.ai', apiKey: 'k', headers: {}, model: 'voxtral-mini-transcribe-realtime-3', language: 'de', hints: ['Atelier'], name: 'Mistral' };

  it('sets the format and language, streams the audio and puts the words together', async () => {
    const server = fakeMistral((m, reply) => {
      if (m.type === 'session.update') reply({ type: 'session.updated', session: {} });
      if (m.type === 'input_audio.append') reply({ type: 'transcription.text.delta', text: server.sent.filter((x) => x.type === 'input_audio.append').length === 1 ? 'Guten' : ' Tag' });
      if (m.type === 'input_audio.end') reply({ type: 'transcription.done', text: 'Guten Tag.' });
    });
    const seen: string[] = [];
    const engine = await openMistralRealtime({ ...base, connect: server.connect, onText: (t) => seen.push(t), onError: () => {} });
    engine.write(new Uint8Array([1, 0, 2, 0]));
    engine.write(new Uint8Array([3, 0]));
    expect(await engine.finish()).toBe('Guten Tag.');
    expect(server.seen.url).toBe('wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-3');
    expect(server.seen.headers.Authorization).toBe('Bearer k');
    expect(server.sent[0]).toEqual({ type: 'session.update', session: { audio_format: { encoding: 'pcm_s16le', sample_rate: 16_000 }, target_streaming_delay_ms: 480, language: 'de', context_bias: ['Atelier'] } });
    expect(server.sent[1]).toEqual({ type: 'input_audio.append', audio: Buffer.from([1, 0, 2, 0]).toString('base64') });
    expect(seen).toEqual(['Guten', 'Guten Tag']);
  });

  it('holds audio until the session is set up', async () => {
    let update: () => void = () => {};
    const server = fakeMistral((m, reply) => {
      if (m.type === 'session.update') update = () => reply({ type: 'session.updated', session: {} });
    });
    const engine = await openMistralRealtime({ ...base, connect: server.connect, onText: () => {}, onError: () => {} });
    engine.write(new Uint8Array([1, 0]));
    expect(server.sent.map((m) => m.type)).toEqual(['session.update']);
    update();
    await new Promise((r) => setTimeout(r, 0));
    expect(server.sent.map((m) => m.type)).toEqual(['session.update', 'input_audio.append']);
    engine.abort();
  });

  it('refuses to start when the service answers with an error first', async () => {
    const server = fakeMistral(() => {}, [{ type: 'error', error: { message: 'Invalid model', code: 1 } }]);
    await expect(openMistralRealtime({ ...base, connect: server.connect, onText: () => {}, onError: () => {}, timeoutMs: 2000 })).rejects.toThrow('Mistral: Invalid model');
  });

  it('gives a stop waiting for the last words what came, when it is cut short', async () => {
    const server = fakeMistral((m, reply) => {
      if (m.type === 'session.update') reply({ type: 'session.updated', session: {} });
      if (m.type === 'input_audio.append') reply({ type: 'transcription.text.delta', text: 'So far' });
    });
    const engine = await openMistralRealtime({ ...base, connect: server.connect, onText: () => {}, onError: () => {} });
    engine.write(new Uint8Array([1, 0]));
    await new Promise((r) => setTimeout(r, 0));
    const stopping = engine.finish();
    engine.abort();
    expect(await stopping).toBe('So far');
  });

  it('says why when the service ends the session while the person speaks', async () => {
    const server = fakeMistral((m, reply) => {
      if (m.type === 'session.update') reply({ type: 'error', error: { message: 'Invalid language alpha2 code' } });
    });
    const errors: string[] = [];
    await openMistralRealtime({ ...base, connect: server.connect, onText: () => {}, onError: (e) => errors.push(e) });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(['Mistral: Invalid language alpha2 code']);
  });
});

describe('one recording to text', () => {
  const wav = wavOf(new Uint8Array(32));
  const ok = (body: unknown, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': type } });

  it('posts OpenAI’s multipart form with the language and what came before', async () => {
    const fetch = vi.fn(async () => ok({ text: ' Hi. ' }));
    const out = await transcribe({ dialect: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k', headers: {}, model: 'whisper-large-v3-turbo', name: 'Groq', wav, language: 'en', before: 'Earlier words.', hints: ['Atelier'], fetch, signal: new AbortController().signal });
    expect(out).toBe('Hi.');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = new TextDecoder().decode(init.body as Uint8Array);
    expect(body).toContain('name="model"\r\n\r\nwhisper-large-v3-turbo');
    expect(body).toContain('name="language"\r\n\r\nen');
    expect(body).toContain('name="prompt"\r\n\r\nAtelier. Earlier words.');
    expect(body).toContain('filename="speech.wav"');
  });

  it('reads ElevenLabs and Deepgram answers', async () => {
    const eleven = vi.fn(async () => ok({ text: 'Hallo', language_code: 'de' }));
    expect(await transcribe({ dialect: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io', apiKey: 'k', headers: {}, model: 'scribe_v2', name: 'ElevenLabs', wav, language: null, before: '', hints: [], fetch: eleven, signal: new AbortController().signal })).toBe('Hallo');
    const [eUrl, eInit] = eleven.mock.calls[0] as unknown as [string, RequestInit];
    expect(eUrl).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((eInit.headers as Record<string, string>)['xi-api-key']).toBe('k');
    const deepgram = vi.fn(async () => ok({ results: { channels: [{ alternatives: [{ transcript: 'Bonjour.' }] }] } }));
    expect(await transcribe({ dialect: 'deepgram', baseUrl: 'https://api.deepgram.com', apiKey: 'k', headers: {}, model: 'nova-3', name: 'Deepgram', wav, language: null, before: '', hints: ['Atelier'], fetch: deepgram, signal: new AbortController().signal })).toBe('Bonjour.');
    const [dUrl, dInit] = deepgram.mock.calls[0] as unknown as [string, RequestInit];
    expect(dUrl).toBe('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&detect_language=true&keyterm=Atelier');
    expect((dInit.headers as Record<string, string>).Authorization).toBe('Token k');
  });

  it('says what went wrong in words', async () => {
    const call = (response: Response) => transcribe({ dialect: 'openai', baseUrl: 'http://box:8000', apiKey: undefined, headers: {}, model: 'm', name: 'Speaches', wav, language: null, before: '', hints: [], fetch: async () => response, signal: new AbortController().signal });
    await expect(call(new Response('', { status: 401 }))).rejects.toThrow('Speaches refused the key (401).');
    await expect(call(new Response(JSON.stringify({ detail: 'Model not installed' }), { status: 400 }))).rejects.toThrow('Speaches couldn’t transcribe (400): Model not installed');
    expect(await call(ok('plain words', 'text/plain'))).toBe('plain words');
  });
});

describe('the dictation service', () => {
  afterEach(() => vi.useRealTimers());

  const make = (over: Partial<{ enabled: boolean; text: ProviderConfig[] }> = {}) => {
    const server = fakeMistral((m, reply) => {
      if (m.type === 'session.update') reply({ type: 'session.updated', session: {} });
      if (m.type === 'input_audio.append') reply({ type: 'transcription.text.delta', text: ` ${Buffer.from(m.audio as string, 'base64')[0]}` });
      if (m.type === 'input_audio.end') reply({ type: 'transcription.done', text: 'done' });
    });
    const service = new DictationService<string>({
      settings: () => ({ enabled: over.enabled ?? true, text: over.text ?? [text('mis', 'mistral', 'https://api.mistral.ai')], media: [] }),
      credentials: async () => ({ apiKey: 'k', headers: {} }),
      fetch: async () => new Response(),
      connect: server.connect,
      limits: { idleMs: 50 },
    });
    return { service, server };
  };

  it('says what it would use, and lists the choices to admins only', () => {
    const { service } = make();
    expect(service.status(false)).toEqual({ enabled: true, source: { id: 'text:mis:voxtral-mini-transcribe-realtime-3', label: 'Voxtral Realtime', provider: 'mis', live: true }, sources: [], chosen: null });
    expect(service.status(true).sources).toHaveLength(1);
  });

  it('refuses when it is off or there is no service', async () => {
    await expect(make({ enabled: false }).service.start('w', 'u', { language: 'auto' }, () => {})).rejects.toThrow(/turned off/);
    await expect(make({ text: [] }).service.start('w', 'u', { language: 'auto' }, () => {})).rejects.toBeInstanceOf(DictationError);
  });

  it('puts audio that overtook other audio back in order, and sends the words to its window', async () => {
    const { service, server } = make();
    const updates: DictationUpdate[] = [];
    const { id } = await service.start('w', 'u', { language: 'auto' }, (u) => updates.push(u));
    await new Promise((r) => setTimeout(r, 0));
    service.audio('w', id, 1, new Uint8Array([2, 0]));
    service.audio('w', id, 0, new Uint8Array([1, 0]));
    service.audio('w', id, 0, new Uint8Array([9, 0]));
    await new Promise((r) => setTimeout(r, 0));
    expect(server.sent.filter((m) => m.type === 'input_audio.append').map((m) => Buffer.from(m.audio as string, 'base64')[0])).toEqual([1, 2]);
    expect(updates.at(-1)).toEqual({ id, text: '1 2' });
    expect(await service.stop('w', id)).toEqual({ text: 'done' });
    expect(() => service.audio('w', id, 2, new Uint8Array(2))).toThrow(/ended/);
  });

  it('ends the one a window had when it starts another, saying why', async () => {
    const { service } = make();
    const first: DictationUpdate[] = [];
    const { id } = await service.start('w', 'u', { language: 'auto' }, (u) => first.push(u));
    await service.start('w', 'u', { language: 'auto' }, () => {});
    expect(first.at(-1)).toEqual({ id, text: '', error: 'Dictation went on in another message box.' });
    expect(() => service.audio('w', id, 0, new Uint8Array(2))).toThrow(/ended/);
  });

  it('belongs to the window that started it', async () => {
    const { service } = make();
    const { id } = await service.start('w', 'u', { language: 'auto' }, () => {});
    expect(() => service.audio('other', id, 0, new Uint8Array(2))).toThrow(DictationError);
    service.dropAll('w');
    expect(() => service.audio('w', id, 0, new Uint8Array(2))).toThrow(/ended/);
  });

  it('ends one whose window stopped sending sound', async () => {
    const { service } = make();
    const updates: DictationUpdate[] = [];
    const { id } = await service.start('w', 'u', { language: 'auto' }, (u) => updates.push(u));
    await new Promise((r) => setTimeout(r, 120));
    expect(updates.at(-1)).toEqual({ id, text: '', error: 'The microphone stopped sending sound.' });
  });
});
