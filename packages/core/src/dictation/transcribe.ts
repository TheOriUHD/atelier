/**
 * One recording to text, in each service's own format: OpenAI's /v1/audio/transcriptions (which Groq, Together,
 * Speaches, LocalAI, vLLM and KoboldCpp copy), ElevenLabs' /v1/speech-to-text and Deepgram's /v1/listen.
 */
import type { ProviderFetch } from '../providers/types.ts';
import { apiUrl } from '../providers/util.ts';
import { multipart } from '../images/multipart.ts';
import type { DictationDialect } from './sources.ts';

export interface TranscribeRequest {
  dialect: Exclude<DictationDialect, 'mistral-realtime'>;
  baseUrl: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
  model: string;
  /** The provider's name, for messages. */
  name: string;
  /** A WAV file. */
  wav: Uint8Array;
  /** null: the service hears the language. */
  language: string | null;
  /** What was said before, and words to spell as given: OpenAI's `prompt`. */
  before: string;
  hints: readonly string[];
  fetch: ProviderFetch;
  signal: AbortSignal;
}

/** A failed request: said as the person reads it, with the status, and how long a 429 asked to wait. */
export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

async function refusal(response: Response, name: string): Promise<Error> {
  if (response.status === 401 || response.status === 403) return new TranscribeError(`${name} refused the key (${response.status}).`, response.status);
  if (response.status === 404) return new TranscribeError(`${name} has no speech-to-text here (404). Choose another service in Settings › General › Dictation.`, 404);
  if (response.status === 429) {
    const after = Number(response.headers.get('retry-after'));
    return new TranscribeError(`${name} is rate-limiting dictation (429). Try again in a moment.`, 429, Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 10_000) : undefined);
  }
  const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim();
  let detail = body;
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown };
    const message = typeof json.error === 'string' ? json.error : typeof json.error?.message === 'string' ? json.error.message : typeof json.message === 'string' ? json.message : typeof json.detail === 'string' ? json.detail : null;
    if (message) detail = message;
  } catch {
    // not JSON: the text as it came
  }
  return new TranscribeError(`${name} couldn’t transcribe (${response.status})${detail ? `: ${detail.slice(0, 200)}` : '.'}`, response.status);
}

/** The prompt OpenAI's models take: the spelling of names, then the end of what was said. */
function promptOf(before: string, hints: readonly string[]): string {
  const names = hints.length ? `${hints.join(', ')}. ` : '';
  return `${names}${before}`.slice(-800);
}

export async function transcribe(request: TranscribeRequest): Promise<string> {
  const { name, fetch, signal } = request;
  const key = request.apiKey;
  let response: Response;
  if (request.dialect === 'openai') {
    const prompt = promptOf(request.before, request.hints);
    const body = multipart([
      { name: 'model', value: request.model },
      { name: 'file', filename: 'speech.wav', mime: 'audio/wav', bytes: request.wav },
      { name: 'response_format', value: 'json' },
      ...(request.language ? [{ name: 'language', value: request.language }] : []),
      ...(prompt ? [{ name: 'prompt', value: prompt }] : []),
    ]);
    response = await fetch(apiUrl(request.baseUrl, '/v1/audio/transcriptions'), {
      method: 'POST',
      headers: { ...request.headers, ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': body.contentType },
      body: body.body,
      signal,
    });
  } else if (request.dialect === 'elevenlabs') {
    const body = multipart([
      { name: 'model_id', value: request.model },
      { name: 'file', filename: 'speech.wav', mime: 'audio/wav', bytes: request.wav },
      // "(laughter)" and the like don't belong in a message.
      { name: 'tag_audio_events', value: 'false' },
      ...(request.language ? [{ name: 'language_code', value: request.language }] : []),
    ]);
    response = await fetch(apiUrl(request.baseUrl, '/v1/speech-to-text'), {
      method: 'POST',
      headers: { ...request.headers, ...(key ? { 'xi-api-key': key } : {}), 'Content-Type': body.contentType },
      body: body.body,
      signal,
    });
  } else {
    const query = new URLSearchParams({ model: request.model, smart_format: 'true', punctuate: 'true', ...(request.language ? { language: request.language } : { detect_language: 'true' }) });
    for (const hint of request.hints.slice(0, 20)) query.append('keyterm', hint);
    response = await fetch(`${apiUrl(request.baseUrl, '/v1/listen')}?${query}`, {
      method: 'POST',
      headers: { ...request.headers, ...(key ? { Authorization: `Token ${key}` } : {}), 'Content-Type': 'audio/wav' },
      body: request.wav as Uint8Array<ArrayBuffer>,
      signal,
    });
  }
  if (!response.ok) throw await refusal(response, name);
  const type = response.headers.get('content-type') ?? '';
  // A server that ignores response_format may answer in plain text.
  if (!type.includes('json')) return (await response.text()).trim();
  const json = (await response.json()) as { text?: unknown; results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] } };
  const text = request.dialect === 'deepgram' ? json.results?.channels?.[0]?.alternatives?.[0]?.transcript : json.text;
  if (typeof text !== 'string') throw new Error(`${name} answered without a transcript.`);
  return text.trim();
}
