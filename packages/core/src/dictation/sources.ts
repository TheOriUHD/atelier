/**
 * Which speech-to-text services the providers set up on this backend offer (ARCHITECTURE §27). There is nothing to add
 * for dictation: a Mistral or OpenAI key (as a text or a media provider), Groq, ElevenLabs, Deepgram, Together, or a
 * local Whisper server with a speech-to-text model typed in already does it.
 */
import type { DictationSource, ImageProviderConfig, ProviderConfig } from '@atelier/protocol';

/** How the backend talks to the service. */
export type DictationDialect =
  /** Mistral's WebSocket: words stream back while the person speaks. */
  | 'mistral-realtime'
  /** OpenAI's `/v1/audio/transcriptions` (and every server that copies it): a phrase at a time. */
  | 'openai'
  /** ElevenLabs' `/v1/speech-to-text`. */
  | 'elevenlabs'
  /** Deepgram's `/v1/listen`. */
  | 'deepgram';

export interface DictationChoice {
  source: DictationSource;
  dialect: DictationDialect;
  /** The provider's address as set up (paths are added with `apiUrl`). */
  baseUrl: string;
  model: string;
  /** Whose key and headers it uses. */
  provider: { kind: 'text' | 'media'; id: string };
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** Model ids a local server lists that turn speech into text. */
const SPEECH_TO_TEXT = /whisper|transcri|parakeet|canary|voxtral|moonshine|sensevoice|stt|asr/i;

interface Offer {
  dialect: DictationDialect;
  models: readonly { id: string; label: string }[];
}

const MISTRAL: Offer = { dialect: 'mistral-realtime', models: [{ id: 'voxtral-mini-transcribe-realtime-3', label: 'Voxtral Realtime' }] };
const OPENAI: Offer = {
  dialect: 'openai',
  models: [
    { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
    { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' },
  ],
};
const GROQ: Offer = { dialect: 'openai', models: [{ id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' }] };
const TOGETHER: Offer = { dialect: 'openai', models: [{ id: 'openai/whisper-large-v3', label: 'Whisper Large v3' }] };
const ELEVENLABS: Offer = { dialect: 'elevenlabs', models: [{ id: 'scribe_v2', label: 'Scribe v2' }] };
const DEEPGRAM: Offer = { dialect: 'deepgram', models: [{ id: 'nova-3', label: 'Nova-3' }] };

/** What a hosted service offers, by its address. */
function hosted(baseUrl: string): Offer | null {
  const host = hostOf(baseUrl);
  if (host === 'api.mistral.ai') return MISTRAL;
  if (host === 'api.openai.com') return OPENAI;
  if (host === 'api.groq.com') return GROQ;
  if (host === 'api.together.xyz' || host === 'api.together.ai') return TOGETHER;
  if (host === 'api.elevenlabs.io') return ELEVENLABS;
  if (host === 'api.deepgram.com') return DEEPGRAM;
  return null;
}

/** Local speech servers in OpenAI's format, by the media preset they were added as. */
const LOCAL_PRESETS = new Set(['speaches', 'localai-speech', 'localai', 'koboldcpp-speech', 'vllm-omni', 'openai-compatible-speech', 'openai-compatible']);
/** Servers that answer without a model named, or with their usual one. */
const LOCAL_DEFAULT: Record<string, string> = { 'koboldcpp-speech': 'whisper', 'localai-speech': 'whisper-1' };

const humanName = (model: string): string => model.split('/').at(-1)!;

function choices(kind: 'text' | 'media', provider: { id: string; name: string; baseUrl: string }, offer: Offer): DictationChoice[] {
  return offer.models.map((m) => ({
    source: { id: `${kind}:${provider.id}:${m.id}`, label: m.label, provider: provider.name, live: offer.dialect === 'mistral-realtime' },
    dialect: offer.dialect,
    baseUrl: provider.baseUrl,
    model: m.id,
    provider: { kind, id: provider.id },
  }));
}

/**
 * Every service, best first: live words (Mistral) before a phrase at a time, then a local server someone set up for it,
 * then the hosted ones. The same service reached through two providers (a Mistral text provider and Mistral Voxtral
 * under Media) is listed once, through the first.
 */
export function dictationChoices(text: readonly ProviderConfig[], media: readonly ImageProviderConfig[]): DictationChoice[] {
  const live: DictationChoice[] = [];
  const local: DictationChoice[] = [];
  const cloud: DictationChoice[] = [];
  const add = (list: DictationChoice[], found: DictationChoice[]) => list.push(...found);
  for (const p of text) {
    if (p.enabled === false) continue;
    // Text providers that aren't an API with a key of its own (a ChatGPT or Copilot sign-in) have no transcription.
    if (!['openai', 'openai-compatible', 'mistral', 'mistral-vibe'].includes(p.type)) continue;
    const offer = hosted(p.baseUrl);
    if (offer) add(offer.dialect === 'mistral-realtime' ? live : cloud, choices('text', p, offer));
  }
  for (const p of media) {
    if (p.enabled === false) continue;
    const offer = hosted(p.baseUrl);
    if (offer) {
      add(offer.dialect === 'mistral-realtime' ? live : cloud, choices('media', p, offer));
      continue;
    }
    if (p.type !== 'openai-speech' && p.type !== 'openai-images') continue;
    if (!p.preset || !LOCAL_PRESETS.has(p.preset)) continue;
    const typed = (p.models ?? []).filter((m) => SPEECH_TO_TEXT.test(m));
    const models = typed.length ? typed : LOCAL_DEFAULT[p.preset] ? [LOCAL_DEFAULT[p.preset]!] : [];
    add(local, choices('media', p, { dialect: 'openai', models: models.map((id) => ({ id, label: humanName(id) })) }));
  }
  const seen = new Set<string>();
  return [...live, ...local, ...cloud].filter((c) => {
    // Two providers on one hosted service are the same choice; two local servers on one host are not (other ports).
    const unique = hosted(c.baseUrl) ? `${c.dialect}|${hostOf(c.baseUrl)}|${c.model}` : `${c.dialect}|${c.baseUrl}|${c.model}`;
    if (seen.has(unique)) return false;
    seen.add(unique);
    return true;
  });
}

/** The admin's choice when it is still there, else the best one; null when there is none. */
export function pickDictation(all: readonly DictationChoice[], chosen: string | undefined): DictationChoice | null {
  return (chosen ? all.find((c) => c.source.id === chosen) : undefined) ?? all[0] ?? null;
}
