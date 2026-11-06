/**
 * The OpenAI speech wire format, `POST /v1/audio/speech` with `{model, input, voice, response_format}`, answered with the
 * sound's bytes. OpenAI and Azure, Groq, OpenRouter, Together and Mistral (its own field names), and the servers people
 * run themselves that copy it: Kokoro-FastAPI, Speaches, LocalAI, KoboldCpp, Chatterbox, Ollama and vLLM-Omni. Each is a
 * preset (`IMAGE_PROVIDER_PRESETS`); they differ in which fields they take, and Ollama refuses a field it doesn't know,
 * so only fields that are set go out. LocalAI also makes music and sound effects on its `/v1/sound-generation` route.
 *
 * Read on 2026-11-06:
 * - OpenAI: https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create,
 *   https://developers.openai.com/api/docs/deprecations (the tts models retire on 2027-01-06)
 * - Azure: https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview
 * - Groq: https://console.groq.com/docs/text-to-speech; OpenRouter: https://openrouter.ai/docs/guides/overview/multimodal/tts
 * - Together: https://docs.together.ai/reference/audio-speech; Mistral: https://docs.mistral.ai/studio/audio/text-to-speech/generate-speech.md
 * - Kokoro-FastAPI, Speaches, LocalAI, KoboldCpp, Chatterbox-TTS-Server, Ollama, vLLM-Omni: their sources on GitHub
 */
import type { AudioCapabilities, AudioVoice } from '@atelier/protocol';
import { probe, requestJson } from '../../providers/http.ts';
import { arr, isRecord, rec, str } from '../../providers/util.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { namedVoices, parseVoices, soundFrom, soundModel } from './audio-common.ts';
import { failureOf, listedModel, noImage } from './hosted.ts';

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
/** tts-1 and tts-1-hd don't have the newer four. */
const TTS1_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const AZURE_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const GROQ_VOICES: Record<string, string[]> = { 'canopylabs/orpheus-v1-english': ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'], 'canopylabs/orpheus-arabic-saudi': ['abdullah', 'fahad', 'sultan', 'lulwa', 'noura', 'aisha'] };
const GROQ_GENDER: Record<string, string> = { autumn: 'female', diana: 'female', hannah: 'female', austin: 'male', daniel: 'male', troy: 'male', abdullah: 'male', fahad: 'male', sultan: 'male', lulwa: 'female', noura: 'female', aisha: 'female' };

/** A speech model in this format, from what the service and the model can do. */
function speech(options: { voices?: AudioVoice[] | undefined; defaultVoice?: string | undefined; direction?: boolean; speed?: boolean; maxChars?: number; languages?: string[] }): ReturnType<typeof soundModel> {
  const audio: AudioCapabilities = {
    kinds: ['speech'],
    ...(options.voices?.length ? { voices: options.voices } : {}),
    ...(options.defaultVoice ? { defaultVoice: options.defaultVoice } : {}),
    ...(options.direction ? { direction: true } : {}),
    ...(options.speed ? { speed: true } : {}),
    ...(options.maxChars ? { maxChars: options.maxChars } : {}),
    ...(options.languages?.length ? { languages: options.languages } : {}),
  };
  return soundModel(audio);
}

/** How each service of this format differs. */
interface Service {
  /** Where the model list comes from: a table, `/v1/models` (filtered to speech), OpenRouter's list, Ollama's, or only what was typed in. */
  models: 'table' | 'v1' | 'openrouter' | 'ollama' | 'typed';
  /** Where voices come from: a table per model, the server's voice list, or nowhere (any name goes). */
  voices: 'table' | 'list' | 'none';
  /** The file asked for. Some servers only make WAV; asking for it there is the one choice they all honour. */
  format: 'mp3' | 'wav';
  direction: boolean;
  speed: boolean;
  /** Mistral calls it `voice_id`. */
  voiceField?: string;
  /** Fields that change how a server answers, such as Kokoro's streaming, which is on unless turned off. */
  extra?: Record<string, unknown>;
  /** Sends the language, for servers that need telling. */
  language?: boolean;
  maxChars?: number;
}

const SERVICES: Record<string, Service> = {
  'openai-speech': { models: 'table', voices: 'table', format: 'mp3', direction: true, speed: true, maxChars: 4096 },
  'azure-speech': { models: 'typed', voices: 'table', format: 'mp3', direction: true, speed: true, maxChars: 4096 },
  'groq-speech': { models: 'table', voices: 'table', format: 'wav', direction: false, speed: false, maxChars: 200 },
  'openrouter-speech': { models: 'openrouter', voices: 'none', format: 'mp3', direction: true, speed: true },
  'together-speech': { models: 'table', voices: 'list', format: 'mp3', direction: false, speed: false },
  'mistral-speech': { models: 'table', voices: 'list', format: 'mp3', direction: false, speed: false, voiceField: 'voice_id' },
  kokoro: { models: 'v1', voices: 'list', format: 'mp3', direction: false, speed: true, extra: { stream: false } },
  speaches: { models: 'v1', voices: 'list', format: 'mp3', direction: false, speed: true },
  'localai-speech': { models: 'v1', voices: 'list', format: 'mp3', direction: true, speed: true, language: true },
  'koboldcpp-speech': { models: 'typed', voices: 'list', format: 'mp3', direction: true, speed: false, language: true },
  chatterbox: { models: 'typed', voices: 'list', format: 'mp3', direction: false, speed: true, language: true },
  'ollama-speech': { models: 'ollama', voices: 'list', format: 'wav', direction: false, speed: false, maxChars: 4096 },
  'vllm-omni': { models: 'v1', voices: 'list', format: 'mp3', direction: true, speed: true, language: true },
  'openai-compatible-speech': { models: 'v1', voices: 'list', format: 'mp3', direction: false, speed: true },
};

const serviceOf = (instance: ImageInstance): Service => SERVICES[instance.preset ?? ''] ?? SERVICES['openai-compatible-speech']!;

/** The hosted services' own models, newest first. */
const TABLES: Record<string, readonly { id: string; name: string; voices?: string[]; direction?: boolean; maxChars?: number }[]> = {
  'openai-speech': [
    { id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS', voices: OPENAI_VOICES, direction: true },
    { id: 'tts-1-hd', name: 'TTS-1 HD', voices: TTS1_VOICES, direction: false },
    { id: 'tts-1', name: 'TTS-1', voices: TTS1_VOICES, direction: false },
  ],
  'groq-speech': [
    { id: 'canopylabs/orpheus-v1-english', name: 'Orpheus English', voices: GROQ_VOICES['canopylabs/orpheus-v1-english']! },
    { id: 'canopylabs/orpheus-arabic-saudi', name: 'Orpheus Arabic (Saudi)', voices: GROQ_VOICES['canopylabs/orpheus-arabic-saudi']! },
  ],
  'together-speech': [
    { id: 'cartesia/sonic', name: 'Cartesia Sonic' },
    { id: 'hexgrad/Kokoro-82M', name: 'Kokoro' },
    { id: 'canopylabs/orpheus-3b-0.1-ft', name: 'Orpheus' },
  ],
  'mistral-speech': [
    { id: 'voxtral-mini-tts-3-0', name: 'Voxtral Mini TTS 3' },
    { id: 'voxtral-mini-tts-2603', name: 'Voxtral Mini TTS' },
  ],
};

/** On a server that lists every model it has, what a speech model looks like. */
const LOOKS_LIKE_SPEECH = /tts|kokoro|piper|speech|voice|bark|coqui|xtts|chatterbox|orpheus|outetts|parler|dia\b|vibevoice|kitten|zonos|higgs|fish|cosyvoice|voxcpm|sesame|csm|f5/i;
/** And what music and sound-effect models look like, on LocalAI's sound route. */
const LOOKS_LIKE_MUSIC = /ace-?step|musicgen|stable-?audio|audioldm|yue|riffusion|diffrhythm/i;

function headers(instance: ImageInstance, json = true): Record<string, string> {
  const auth: Record<string, string> = !instance.apiKey ? {} : instance.preset === 'azure-speech' ? { 'api-key': instance.apiKey } : { authorization: `Bearer ${instance.apiKey}` };
  return { ...(json ? { 'content-type': 'application/json' } : {}), ...instance.headers, ...auth };
}

/** The API version Azure's speech route is documented against. */
const AZURE_API_VERSION = '2025-04-01-preview';

function speechUrl(instance: ImageInstance, model: string): string {
  if (instance.preset === 'azure-speech') return `${instance.baseUrl}/openai/deployments/${encodeURIComponent(model)}/audio/speech?api-version=${AZURE_API_VERSION}`;
  return `${instance.baseUrl}/v1/audio/speech`;
}

/** OpenRouter takes one format per model: Google's and HeyGen's speak raw samples only, MiniMax's MP3 only, the rest either. */
const openRouterFormat = (model: string) => (/^(?:google|heygen)\//i.test(model) ? 'pcm' : 'mp3');

/** A conversation as OpenRouter's turns: each `Name: line` with that speaker's voice. Lines without a name go to the speaker before. */
export function speakerTurns(text: string, speakers: readonly { name: string; voice: string }[]): { text: string; voice: string }[] {
  const voices = new Map(speakers.map((s) => [s.name.toLowerCase(), s.voice]));
  const turns: { text: string; voice: string }[] = [];
  for (const line of text.split(/\n+/)) {
    const said = /^\s*([^:]{1,40}):\s*(.*)$/.exec(line);
    const voice = said ? voices.get(said[1]!.trim().toLowerCase()) : undefined;
    if (voice && said![2]!.trim()) turns.push({ text: said![2]!.trim(), voice });
    else if (line.trim() && turns.length) turns.at(-1)!.text += ` ${line.trim()}`;
    else if (line.trim()) turns.push({ text: line.trim(), voice: speakers[0]!.voice });
  }
  return turns;
}

/** What a request says, in this format, with only the fields that are set and that this service takes. */
export function speechBody(instance: ImageInstance, request: ImageRequest): Record<string, unknown> {
  const service = serviceOf(instance);
  const audio = request.audio!;
  const openRouter = instance.preset === 'openrouter-speech';
  const turns = openRouter && audio.speakers?.length ? speakerTurns(request.prompt, audio.speakers) : undefined;
  return {
    model: request.model,
    input: turns ?? request.prompt,
    ...(audio.voice && !turns ? { [service.voiceField ?? 'voice']: audio.voice } : {}),
    response_format: openRouter ? openRouterFormat(request.model) : service.format,
    ...(audio.speed !== undefined && service.speed ? { speed: audio.speed } : {}),
    ...(audio.direction && service.direction ? { instructions: audio.direction } : {}),
    ...(audio.language && service.language ? { language: audio.language } : {}),
    ...(request.seed !== undefined && request.capabilities.seed ? { seed: request.seed } : {}),
    ...service.extra,
  };
}

/** LocalAI's ElevenLabs-style route for music and sound effects. */
function soundGenerationBody(request: ImageRequest): Record<string, unknown> {
  const audio = request.audio!;
  return {
    model_id: request.model,
    text: request.prompt,
    ...(audio.seconds !== undefined ? { duration_seconds: audio.seconds } : {}),
    ...(audio.lyrics ? { lyrics: audio.lyrics } : {}),
    ...(audio.instrumental ? { instrumental: true } : {}),
    ...(audio.language ? { vocal_language: audio.language } : {}),
  };
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const music = request.audio?.kind !== 'speech';
  const res = music
    ? await deps.fetch(`${instance.baseUrl}/v1/sound-generation`, { method: 'POST', headers: headers(instance), body: JSON.stringify(soundGenerationBody(request)), signal: request.signal })
    : await deps.fetch(speechUrl(instance, request.model), { method: 'POST', headers: headers(instance), body: JSON.stringify(speechBody(instance, request)), signal: request.signal });
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

/** `{data:[{id}]}` or a bare list: the ids a server reports. */
const reportedIds = (body: unknown): { id: string; name?: string }[] =>
  (Array.isArray(body) ? body : arr(rec(body).data)).filter(isRecord).flatMap((m) => {
    const id = str(m.id) ?? str(m.name);
    const name = str(m.name) && str(m.name) !== id ? str(m.name) : undefined;
    return id ? [{ id, ...(name ? { name } : {}) }] : [];
  });

export function createOpenAiSpeech(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const service = serviceOf(instance);
  const get = (path: string, signal?: AbortSignal) => requestJson(deps, instance, `${instance.baseUrl}${path}`, { headers: headers(instance, false), ...(signal ? { signal } : {}) });

  /** The server's voices, for every model or for one; none when it has no list. */
  const voicesOf = async (model: string | undefined, signal?: AbortSignal): Promise<AudioVoice[]> => {
    if (service.voices !== 'list') return [];
    if (instance.preset === 'mistral-speech') return mistralVoices(signal);
    if (instance.preset === 'together-speech') {
      // `{data: [{model, voices}]}` for every model; the one asked about, when it is there.
      const body = await get('/v1/voices', signal).catch(() => null);
      const entry = arr(rec(body).data).find((d) => isRecord(d) && d.model === model);
      return parseVoices(entry ?? body);
    }
    const query = model && (instance.preset === 'speaches' || instance.preset === 'localai-speech') ? `?model=${encodeURIComponent(model)}` : '';
    return parseVoices(await get(`/v1/audio/voices${query}`, signal).catch(() => null));
  };

  /** Mistral's voices, page by page: `{data: [{id, slug, name, languages, gender, description}], next_page_token}`. */
  const mistralVoices = async (signal?: AbortSignal): Promise<AudioVoice[]> => {
    const all: AudioVoice[] = [];
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body = rec(await get(`/v2/audio/voices?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ''}`, signal).catch(() => null));
      for (const v of arr(body.data).filter(isRecord)) {
        // A preset is called by its slug (`gb_jane_neutral`), a voice of the account's own by its id.
        const id = str(v.slug) ?? str(v.id);
        if (!id) continue;
        const traits = [str(v.gender), str(v.age), ...arr(v.tags).map(String)].filter(Boolean).join(', ');
        const said = str(v.description) ?? traits;
        all.push({ id, name: (str(v.name) ?? id).slice(0, 100), ...(said ? { description: said.slice(0, 300) } : {}), ...(arr(v.languages).length ? { languages: arr(v.languages).map(String) } : {}) });
      }
      token = str(body.next_page_token);
      if (!token) break;
    }
    return all;
  };

  const fromTable = (id: string, voices: AudioVoice[] | undefined, source: ListedImageModel['source'], name?: string) => {
    const row = TABLES[instance.preset ?? '']?.find((m) => m.id === id);
    const tableVoices = row?.voices ? namedVoices(row.voices, instance.preset === 'groq-speech' ? GROQ_GENDER : {}) : undefined;
    const azureVoices = instance.preset === 'azure-speech' ? namedVoices(AZURE_VOICES) : undefined;
    const list = voices?.length ? voices : (tableVoices ?? azureVoices);
    const direction = service.direction && (row?.direction ?? (instance.preset === 'azure-speech' ? /mini-tts/i.test(id) : true));
    const capabilities = speech({ voices: list, defaultVoice: list?.[0]?.id, direction, speed: service.speed, maxChars: row?.maxChars ?? service.maxChars });
    return listedModel(instance, id, capabilities, source, { displayName: name ?? row?.name ?? id });
  };

  /** Ollama: the models that say they speak, each with its voices. */
  const ollamaModels = async (signal?: AbortSignal): Promise<ListedImageModel[]> => {
    const tags = arr(rec(await get('/api/tags', signal)).models).filter(isRecord);
    const found: ListedImageModel[] = [];
    for (const tag of tags.slice(0, 40)) {
      const name = str(tag.name) ?? str(tag.model);
      if (!name) continue;
      const shown = rec(await requestJson(deps, instance, `${instance.baseUrl}/api/show`, { method: 'POST', headers: headers(instance), body: { model: name }, ...(signal ? { signal } : {}) }).catch(() => null));
      if (!arr(shown.capabilities).includes('speech')) continue;
      const voices = parseVoices({ voices: arr(shown.voices) });
      found.push(listedModel(instance, name, speech({ voices, defaultVoice: voices[0]?.id, maxChars: 4096 }), 'detected', { displayName: name }));
    }
    return found;
  };

  return {
    type: 'openai-speech',
    async listModels(signal) {
      const typed = instance.models.map((id) => fromTable(id, undefined, 'default'));
      if (service.models === 'typed') {
        const voices = await voicesOf(undefined, signal);
        const ids = instance.models.length ? instance.models : [instance.preset === 'koboldcpp-speech' ? 'koboldcpp' : instance.preset === 'chatterbox' ? 'chatterbox' : 'tts'];
        return ids.map((id) => fromTable(id, voices, 'default'));
      }
      if (service.models === 'table') {
        const rows = TABLES[instance.preset ?? ''] ?? [];
        const voices = service.voices === 'list' ? await voicesOf(undefined, signal) : undefined;
        return [...rows.map((row) => fromTable(row.id, voices, 'catalog')), ...typed.filter((m) => !rows.some((r) => r.id === m.modelId))];
      }
      if (service.models === 'ollama') return [...(await ollamaModels(signal)), ...typed];
      if (service.models === 'openrouter') {
        const body = await get('/v1/models?output_modalities=speech', signal);
        // Each model lists its own voices; Google's and Fish's take two speakers as turns.
        const listed = arr(rec(body).data)
          .filter(isRecord)
          .flatMap((m) => {
            const id = str(m.id);
            if (!id) return [];
            const voices = parseVoices(arr(m.supported_voices));
            const capabilities = speech({ voices, defaultVoice: voices[0]?.id, direction: true, speed: true });
            const two = /^(?:google|fish-audio)\//i.test(id) && !/fish-audio\/s1\b/i.test(id);
            const description = str(m.description)?.slice(0, 200);
            return [listedModel(instance, id, two ? { ...capabilities, audio: { ...capabilities.audio!, maxSpeakers: 2 } } : capabilities, 'detected', { displayName: str(m.name) ?? id, ...(description ? { description } : {}) })];
          });
        return [...listed, ...typed.filter((m) => !listed.some((l) => l.modelId === m.modelId))];
      }
      // `/v1/models`: a speech server lists its speech models; LocalAI and others list everything, so names decide.
      const path = instance.preset === 'speaches' ? '/v1/models?task=text-to-speech' : '/v1/models';
      const reported = reportedIds(await get(path, signal).catch(() => null));
      const everything = instance.preset === 'localai-speech' || instance.preset === 'vllm-omni' || instance.preset === 'openai-compatible-speech';
      const speaking = reported.filter((m) => !everything || LOOKS_LIKE_SPEECH.test(m.id));
      // Kokoro-FastAPI also answers to OpenAI's model names; its own is the one to list.
      const own = instance.preset === 'kokoro' && speaking.some((m) => m.id === 'kokoro') ? speaking.filter((m) => m.id === 'kokoro') : speaking;
      const listed: ListedImageModel[] = [];
      const shared = instance.preset === 'kokoro' || instance.preset === 'openai-compatible-speech' ? await voicesOf(undefined, signal) : undefined;
      for (const m of own.slice(0, 30)) listed.push(fromTable(m.id, shared ?? (await voicesOf(m.id, signal)), 'detected', m.name));
      if (instance.preset === 'localai-speech') {
        for (const m of reported.filter((r) => LOOKS_LIKE_MUSIC.test(r.id))) {
          const capabilities = soundModel({ kinds: /audioldm/i.test(m.id) ? ['sound'] : ['music', 'sound'], durations: { kind: 'range', min: 1, max: 600, step: 1 }, defaultSeconds: 30, lyrics: /ace-?step|yue/i.test(m.id), vocals: /ace-?step|yue/i.test(m.id) ? 'optional' : 'none' });
          listed.push(listedModel(instance, m.id, capabilities, 'detected', { displayName: m.name ?? m.id }));
        }
      }
      return [...listed, ...typed.filter((m) => !listed.some((l) => l.modelId === m.modelId))];
    },
    health(signal) {
      if (instance.preset === 'azure-speech') return Promise.resolve({ ok: true, latencyMs: null, warnings: [] });
      if (instance.preset === 'ollama-speech') return probe(deps, instance, `${instance.baseUrl}/api/version`, headers(instance, false), signal);
      // KoboldCpp and Chatterbox have no model list worth asking; their voice list answers as quickly.
      const path = instance.preset === 'koboldcpp-speech' || instance.preset === 'chatterbox' ? '/v1/audio/voices' : '/v1/models';
      return probe(deps, instance, `${instance.baseUrl}${path}`, headers(instance, false), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request));
    },
  };
}
