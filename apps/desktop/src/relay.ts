/**
 * Server mode (ARCHITECTURE §21): relays JSON-RPC between renderer MessagePorts and the Atelier server's
 * WebSocket. The port carries structured-cloned messages, the socket JSON text frames.
 *
 * Each renderer port gets its own socket. Until it opens, the relay retries with backoff and holds the
 * renderer's messages. Once an open socket drops, the relay closes the port, and the renderer asks
 * for a new one; requests in flight fail instead of hanging.
 */
import { APP } from '@atelier/protocol';

type Port = Pick<Electron.MessagePortMain, 'on' | 'postMessage' | 'start' | 'close'>;
type OpenSocket = (url: string, headers: Record<string, string>) => WebSocket;

/** How this app introduces itself to a server, with the system it runs on. */
export const DESKTOP_USER_AGENT = `${APP.name} Desktop (${process.platform})`;

/** Node's WebSocket (undici) accepts request headers; the DOM typings don't know that. */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

/** What the relay tells whoever shows its state: a socket opened, or another attempt in a row failed. */
export interface RelayHooks {
  up(): void;
  failed(failures: number): void;
}

/** No wait on a healthy connection; then 250 ms doubling to 10 s while the server stays unreachable. */
export const backoff = (failures: number) => (failures === 0 ? 0 : Math.min(10_000, 250 * 2 ** (failures - 1)));

export function createRelay(serverUrl: string, openSocket: OpenSocket = (url, headers) => new NodeWebSocket(url, { headers }), hooks?: RelayHooks) {
  const socketUrl = `${serverUrl.replace(/^http/, 'ws')}/api/ws`;
  // Shared by all ports, so a server that accepts and then drops connections isn't hammered either.
  let failures = 0;

  return {
    /** Connects one renderer port, signed in with the stored token when there is one. */
    link(port: Port, token?: string): void {
      // The server's device list names a client by its user agent ("Atelier Desktop on macOS").
      const headers: Record<string, string> = { 'User-Agent': DESKTOP_USER_AGENT, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const outbox: string[] = [];
      let socket: WebSocket | null = null;
      let open = false;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const connect = () => {
        const ws = (socket = openSocket(socketUrl, headers));
        ws.onopen = () => {
          open = true;
          failures = 0;
          hooks?.up();
          for (const text of outbox.splice(0)) ws.send(text);
        };
        ws.onmessage = (event: MessageEvent) => {
          if (typeof event.data !== 'string') return;
          let message: unknown;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          port.postMessage(message);
        };
        ws.onclose = () => {
          if (done) return;
          failures++;
          if (open) {
            done = true;
            port.close();
          } else {
            hooks?.failed(failures);
            timer = setTimeout(connect, backoff(failures));
          }
        };
      };

      port.on('message', ({ data }) => {
        const text = JSON.stringify(data);
        if (open) socket!.send(text);
        else outbox.push(text);
      });
      port.on('close', () => {
        done = true;
        clearTimeout(timer);
        socket?.close();
      });
      port.start();
      timer = setTimeout(connect, backoff(failures));
    },
  };
}
