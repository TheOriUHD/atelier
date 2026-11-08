/**
 * A JSON-RPC transport over a WebSocket to an Atelier server's `/api/ws` that connects again on its own: 0, then 250 ms
 * doubling to 10 s between tries. Messages sent while it is down wait for the next socket. The app's own web transport
 * is the same idea; this one takes headers (a bearer token, a user agent), which only a non-browser WebSocket can send.
 */
import type { RpcMessage, Transport } from '@atelier/protocol';

export interface ReconnectingTransport extends Transport {
  /** Fires after the connection is made again (not on the first connect). */
  onReconnect(handler: () => void): () => void;
  /** Fires with true when a socket opens and false when it drops. */
  onStatus(handler: (connected: boolean) => void): () => void;
  /** Ends it: no more tries. */
  close(): void;
}

/** A WebSocket constructor that takes request headers (Node's undici one does; the DOM's typings don't say so). */
export type HeaderWebSocket = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

export interface WsTransportOptions {
  /** The server's address, `https://atelier.example.com`; the socket goes to its `/api/ws`. */
  serverUrl: string;
  /** Headers for each new socket: asked again every time, so a new token is used from the next try. */
  headers(): Record<string, string>;
  WebSocket?: HeaderWebSocket;
  /** Called after each failed try in a row (1, 2, …), and with 0 when a socket opens. */
  onFailures?(failures: number): void;
}

export const retryDelay = (failures: number) => (failures === 0 ? 0 : Math.min(10_000, 250 * 2 ** (failures - 1)));

export function wsTransport(options: WsTransportOptions): ReconnectingTransport {
  const Socket = options.WebSocket ?? (globalThis.WebSocket as unknown as HeaderWebSocket);
  const url = `${options.serverUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/api/ws`;
  const messageHandlers = new Set<(m: RpcMessage) => void>();
  const closeHandlers = new Set<() => void>();
  const reconnectHandlers = new Set<() => void>();
  const statusHandlers = new Set<(c: boolean) => void>();
  const add = <T>(set: Set<T>, h: T) => (set.add(h), () => void set.delete(h));
  const queue: string[] = [];
  let socket: WebSocket | null = null;
  let open = false;
  let connectedOnce = false;
  let failures = 0;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (ended) return;
    const current = (socket = new Socket(url, { headers: options.headers() }));
    current.onopen = () => {
      if (socket !== current) return;
      open = true;
      failures = 0;
      options.onFailures?.(0);
      for (const m of queue.splice(0)) current.send(m);
      statusHandlers.forEach((fn) => fn(true));
      if (connectedOnce) reconnectHandlers.forEach((fn) => fn());
      connectedOnce = true;
    };
    current.onmessage = (e: { data: unknown }) => {
      if (typeof e.data !== 'string') return;
      try {
        const m = JSON.parse(e.data) as RpcMessage;
        messageHandlers.forEach((fn) => fn(m));
      } catch {
        // Not JSON: not ours.
      }
    };
    current.onerror = () => {};
    current.onclose = () => {
      if (socket !== current) return;
      const was = open;
      open = false;
      socket = null;
      if (was) {
        closeHandlers.forEach((fn) => fn());
        statusHandlers.forEach((fn) => fn(false));
      } else options.onFailures?.(++failures);
      if (!ended) timer = setTimeout(connect, retryDelay(was ? 0 : failures));
    };
  };
  connect();

  return {
    send: (m) => {
      const text = JSON.stringify(m);
      if (open && socket) socket.send(text);
      else queue.push(text);
    },
    onMessage: (h) => add(messageHandlers, h),
    onClose: (h) => add(closeHandlers, h),
    onReconnect: (h) => add(reconnectHandlers, h),
    onStatus: (h) => add(statusHandlers, h),
    close: () => {
      ended = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
