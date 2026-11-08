/**
 * A small real WebSocket server for tests of what the desktop lends: the handshake and framing of RFC 6455 over
 * `node:http`, with what each client sent and which headers it opened with. It accepts no extensions, so nothing is
 * compressed.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsClient {
  url: string;
  headers: IncomingHttpHeaders;
  received: (string | Buffer)[];
  closed: Promise<void>;
  text(message: string): void;
  binary(message: Buffer): void;
  close(): void;
}

export interface WsServer {
  /** `http://127.0.0.1:<port>`, what a person lends. */
  http: string;
  /** `ws://127.0.0.1:<port>`, what a socket opens. */
  ws: string;
  port: number;
  clients: WsClient[];
  /** Answers the next handshakes with this instead of accepting them; an empty string never answers them. */
  refuse(response: string | null): void;
  /** Every request that reached this server, handshake or not. */
  requests: string[];
  stop(): Promise<void>;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  if (length < 65536) {
    const head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(length, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([head, payload]);
}

/** Reads one masked client frame off `buffer`: its opcode, payload and how many bytes it took; null until it is all there. */
function parse(buffer: Buffer): { opcode: number; payload: Buffer; used: number } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  let length = buffer[1]! & 0x7f;
  let at = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    at = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    at = 10;
  }
  if (buffer.length < at + 4 + length) return null;
  const mask = buffer.subarray(at, at + 4);
  const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
  for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
  return { opcode, payload, used: at + 4 + length };
}

export async function wsServer(onClient: (client: WsClient) => void = () => {}): Promise<WsServer> {
  const clients: WsClient[] = [];
  const requests: string[] = [];
  const open = new Set<Socket>();
  let refusal: string | null = null;
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket: Socket) => {
    requests.push(req.url ?? '');
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {});
    if (refusal !== null) return void (refusal && socket.end(refusal));
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    let done!: () => void;
    const client: WsClient = {
      url: req.url ?? '',
      headers: req.headers,
      received: [],
      closed: new Promise((resolve) => (done = resolve)),
      text: (message) => void socket.write(frame(1, Buffer.from(message))),
      binary: (message) => void socket.write(frame(2, message)),
      close: () => void socket.write(frame(8, Buffer.alloc(0))),
    };
    socket.on('close', () => done());
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (let next = parse(buffered); next; next = parse(buffered)) {
        buffered = buffered.subarray(next.used);
        if (next.opcode === 1) client.received.push(next.payload.toString());
        else if (next.opcode === 2) client.received.push(next.payload);
        else if (next.opcode === 8) {
          socket.write(frame(8, Buffer.alloc(0)));
          socket.end();
        }
      }
    });
    clients.push(client);
    onClient(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    port,
    clients,
    requests,
    refuse: (response) => void (refusal = response),
    stop: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
