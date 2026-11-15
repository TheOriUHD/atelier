/** What a speech-to-text service looks like to a dictation (ARCHITECTURE §27), whichever way it hears. */

export interface DictationEngine {
  /** 16 kHz mono s16le PCM, in order. */
  write(pcm: Uint8Array): void;
  /** No more audio: resolves with everything said, once the service has heard the rest. */
  finish(): Promise<string>;
  /** Stops at once and keeps nothing. */
  abort(): void;
}

export interface EngineEvents {
  /** Everything heard so far; its end may still change. */
  onText(text: string): void;
  /** The service failed, and the dictation is over: said as the person reads it. */
  onError(message: string): void;
}

/** A WebSocket as an engine uses it: text frames only. */
export interface DictationSocket {
  send(text: string): void;
  close(): void;
}

export interface SocketHandlers {
  onMessage(text: string): void;
  /** Closed by either side; `reason` is the server's, when it gave one. */
  onClose(code: number, reason: string): void;
}

/** Opens a WebSocket with these headers (an API key), resolving once it is open. */
export type DictationConnect = (url: string, headers: Record<string, string>, handlers: SocketHandlers, signal: AbortSignal) => Promise<DictationSocket>;

/** Node's own WebSocket, which takes headers on the handshake (undici's `WebSocketInit`). */
export const connectWebSocket: DictationConnect = (url, headers, handlers, signal) =>
  new Promise((resolve, reject) => {
    // The init object is undici's, beyond the browser's (url, protocols): Node sends its headers with the handshake.
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    let open = false;
    const onAbort = () => ws.close();
    signal.addEventListener('abort', onAbort, { once: true });
    // A handshake that never completes (a proxy that holds it) mustn't keep the window starting.
    const timer = setTimeout(() => {
      if (open) return;
      ws.close();
      reject(new Error(`${new URL(url).host} didn’t answer.`));
    }, 10_000);
    ws.onopen = () => {
      open = true;
      clearTimeout(timer);
      resolve({ send: (text) => ws.send(text), close: () => ws.close() });
    };
    ws.onmessage = ({ data }) => {
      if (typeof data === 'string') handlers.onMessage(data);
    };
    ws.onerror = () => {
      if (!open) reject(new Error(`The connection to ${new URL(url).host} was refused.`));
    };
    ws.onclose = ({ code, reason }) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (!open) reject(new Error(`The connection to ${new URL(url).host} was refused.`));
      else handlers.onClose(code, reason);
    };
  });

/** Spaces between two pieces of text, except between two pieces of a language written without them. */
export function joinText(a: string, b: string): string {
  const left = a.trimEnd();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\u3000-\u303f\uff00-\uffef]/u;
  return unspaced.test(left.at(-1)!) && unspaced.test(right[0]!) ? left + right : `${left} ${right}`;
}
