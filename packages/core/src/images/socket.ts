/** WebSockets for adapters, as a stream of messages: messages that arrive between reads wait in a queue. */
import type { ImageSocket } from './types.ts';

export function openSocket(url: string, signal: AbortSignal): Promise<ImageSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const queue: (string | Uint8Array)[] = [];
    let closed = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    const onAbort = () => ws.close();
    signal.addEventListener('abort', onAbort, { once: true });
    ws.onmessage = ({ data }) => {
      queue.push(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer));
      notify();
    };
    ws.onclose = () => {
      closed = true;
      signal.removeEventListener('abort', onAbort);
      notify();
    };
    ws.onerror = () => {
      failure = new Error(`The connection to ${new URL(url).host} failed.`);
      if (ws.readyState !== WebSocket.OPEN) reject(failure);
      notify();
    };
    ws.onopen = () =>
      resolve({
        send: (text) => ws.send(text),
        close: () => ws.close(),
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length) {
              yield queue.shift()!;
              continue;
            }
            if (failure) throw failure;
            if (closed) return;
            await new Promise<void>((r) => (wake = r));
          }
        },
      });
    if (signal.aborted) {
      ws.close();
      reject(signal.reason);
    }
  });
}
