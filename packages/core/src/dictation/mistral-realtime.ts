/**
 * Mistral's realtime transcription (docs.mistral.ai, "Realtime transcription", checked live 2026-11-15): a WebSocket at
 * /v1/audio/transcriptions/realtime?model=…, the key as a bearer token on the handshake. The server says
 * `session.created`; the client sets the audio format with `session.update`, streams `input_audio.append` (base64 PCM)
 * and ends with `input_audio.end`; words come back as `transcription.text.delta` (never corrected) and everything as
 * `transcription.done`. Session fields can't change once audio has started.
 */
import { DICTATION_SAMPLE_RATE } from '@atelier/protocol';
import { apiUrl } from '../providers/util.ts';
import type { DictationConnect, DictationEngine, DictationSocket, EngineEvents } from './engine.ts';

export interface MistralRealtimeOptions extends EngineEvents {
  baseUrl: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
  model: string;
  /** null: the service hears the language. */
  language: string | null;
  /** Words to spell as given (Mistral's `context_bias`). */
  hints: readonly string[];
  /** The provider's name, for messages. */
  name: string;
  connect: DictationConnect;
  /** How long to wait for the session to start, and for the last words after the end. */
  timeoutMs?: number;
}

interface MistralEvent {
  type?: string;
  text?: string;
  error?: { message?: unknown; code?: unknown } | string;
  message?: unknown;
}

/** Mistral's `error` event, in a sentence. */
function errorText(event: MistralEvent, name: string): string {
  const nested = typeof event.error === 'object' && event.error ? event.error.message : undefined;
  const raw = typeof event.error === 'string' ? event.error : typeof nested === 'string' ? nested : typeof event.message === 'string' ? event.message : '';
  return raw ? `${name}: ${raw}` : `${name} stopped transcribing.`;
}

export async function openMistralRealtime(options: MistralRealtimeOptions): Promise<DictationEngine> {
  const { name, onText, onError } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const url = `${apiUrl(options.baseUrl, '/v1/audio/transcriptions/realtime').replace(/^http/, 'ws')}?model=${encodeURIComponent(options.model)}`;
  const controller = new AbortController();
  let text = '';
  let over = false;
  let started = false;
  let ready = false;
  const waiting: string[] = [];
  let socket: DictationSocket | null = null;
  /** Set while `finish` waits for the last words. */
  let finishing: { resolve(text: string): void; reject(error: Error): void } | null = null;
  let finished: Promise<string> | null = null;
  let begin: { resolve(): void; reject(error: Error): void } = { resolve() {}, reject() {} };
  const began = new Promise<void>((resolve, reject) => (begin = { resolve, reject }));
  began.catch(() => undefined);

  const end = (result: { text: string } | { error: string }) => {
    if (over) return;
    over = true;
    controller.abort();
    socket?.close();
    if ('error' in result) {
      if (!started) begin.reject(new Error(result.error));
      else if (finishing) finishing.reject(new Error(result.error));
      else onError(result.error);
    } else finishing?.resolve(result.text);
  };

  socket = await options
    .connect(
      url,
      { ...options.headers, ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
      {
        onMessage(data) {
          let event: MistralEvent;
          try {
            event = JSON.parse(data) as MistralEvent;
          } catch {
            return;
          }
          switch (event.type) {
            case 'session.created':
              begin.resolve();
              return;
            case 'session.updated':
              ready = true;
              for (const message of waiting.splice(0)) socket?.send(message);
              return;
            case 'transcription.text.delta':
              if (typeof event.text === 'string' && event.text && !over) {
                // The first word comes without its leading space; the service's own spacing is kept after that.
                text = text ? text + event.text : event.text.trimStart();
                onText(text);
              }
              return;
            case 'transcription.done':
              end({ text: typeof event.text === 'string' ? event.text.trim() : text });
              return;
            case 'error':
              end({ error: errorText(event, name) });
              return;
            default:
          }
        },
        onClose(code, reason) {
          if (over) return;
          // Closed after the end was asked for: what came is the answer.
          if (finishing) end({ text });
          else end({ error: reason ? `${name} closed the connection: ${reason}` : `${name} closed the connection (${code}).` });
        },
      },
      controller.signal,
    )
    .catch((e: unknown) => {
      throw new Error(e instanceof Error ? `${name}: ${e.message}` : `${name} couldn’t be reached.`);
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([began, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${name} didn’t start a transcription session.`)), timeoutMs)))]);
  } catch (e) {
    over = true;
    socket.close();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  started = true;
  socket.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        audio_format: { encoding: 'pcm_s16le', sample_rate: DICTATION_SAMPLE_RATE },
        // Mistral's recommended start: words about half a second after they are said.
        target_streaming_delay_ms: 480,
        ...(options.language ? { language: options.language } : {}),
        ...(options.hints.length ? { context_bias: options.hints } : {}),
      },
    }),
  );

  const send = (message: string) => {
    if (ready) socket!.send(message);
    else waiting.push(message);
  };

  return {
    write(pcm) {
      if (over || finished) return;
      send(JSON.stringify({ type: 'input_audio.append', audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') }));
    },
    finish() {
      finished ??= new Promise<string>((resolve, reject) => {
        if (over) {
          resolve(text);
          return;
        }
        finishing = { resolve, reject };
        send(JSON.stringify({ type: 'input_audio.end' }));
        // The last words take about a second; past the wait, what came already is the answer.
        setTimeout(() => end({ text }), timeoutMs).unref?.();
      });
      return finished;
    },
    abort() {
      over = true;
      controller.abort();
      socket!.close();
      // A stop waiting for the last words gets what came.
      finishing?.resolve(text);
    },
  };
}
