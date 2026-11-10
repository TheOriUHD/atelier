/**
 * "Share on your network" (Settings › Connection): the desktop app's own backend answers the other devices on the local
 * network the way an Atelier server does, for its one person, who signs in with a password. Browsers get the web app;
 * desktop apps (and anything else that speaks to a server) connect to `/api/ws`.
 *
 * It serves the web app, `/api/health` (how other apps find it), password sign-in and sign-out (an HttpOnly cookie for
 * browsers, the token for apps that sign in over the socket), `/api/ws` and `/api/blobs`. Not passkeys, identity
 * providers, invites, device links or updates: those take a server. Plain HTTP, for the local network.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { APP, APP_CSP, artifactRuntimeCsp, blobResponse, Username, type BlobSource, type RpcMessage, type Transport, type UserSummary } from '@atelier/protocol';
import { AccountError, type Authenticated, type ClientInfo } from '../accounts/account-service.ts';

/** What the listener needs from the backend. */
export interface ShareBackend {
  connect(transport: Transport, options: { token?: string; client: ClientInfo; origin?: string }): () => void;
  /** A sign-in from the network, or null (a token of this computer's own windows doesn't count here). */
  authenticate(token: string): Promise<Authenticated | null>;
  login(input: { username: string; password: string }, client: ClientInfo): Promise<{ token: string; user: UserSummary }>;
  logout(sessionId: string): Promise<void>;
  blobSource(userId: string, sha256: string): Promise<BlobSource | undefined>;
}

export interface ShareOptions {
  port: number;
  /** The web app's build (index.html and its assets); without one only the API answers. */
  uiDir: string | null;
  /** What `/api/health` calls this computer, as other apps list it. */
  name: string;
  logger: { info(message: string, data?: Record<string, unknown>): void; error(message: string, error?: unknown): void };
}

export interface ShareServer {
  port: number;
  close(): Promise<void>;
}

/** Why the network can't reach this computer, in words for the person. */
export class ShareError extends Error {}

class BodyTooLarge extends Error {}

const COOKIE = APP.cookie;
const MAX_BODY = 8 * 1024;
const COOKIE_MAX_AGE = 30 * 24 * 3600;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Whether a `Host` is a name a device on the local network reaches this computer by: an address, a single-label name, or
 * one of the local network's suffixes. Anything else is most likely a web page that pointed its own domain at this
 * computer (DNS rebinding) to talk to it from a browser on the network, and is refused.
 */
export function localHostName(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host: string;
  try {
    host = new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  } catch {
    return false;
  }
  if (isIP(host)) return true;
  if (!host.includes('.')) return true;
  return /\.(local|lan|home|home\.arpa|internal|localhost|ts\.net)$/.test(host);
}

/** Network interfaces that only lead to virtual machines and containers on this computer. */
const VIRTUAL = /^(docker|br-|veth|vmnet|vboxnet|virbr|awdl|llw|bridge|vEthernet)/i;

/** The addresses other devices open, most useful first: the local network's, then others (Tailscale), then the name. */
export function shareAddresses(port: number, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(), host = hostname()): string[] {
  const rank = (ip: string) => (/^(192\.168|10)\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 0 : 1);
  const ips = Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address)
    .filter((ip, i, all) => all.indexOf(ip) === i)
    .sort((a, b) => rank(a) - rank(b));
  const name = host.replace(/\.$/, '');
  const named = name ? [`http://${/\.local$/i.test(name) || process.platform !== 'darwin' ? name : `${name}.local`}:${port}`] : [];
  return [...ips.map((ip) => `http://${ip}:${port}`), ...named];
}

/** This computer's name as other apps list it: "Ada's MacBook Pro" comes out as the host name the network knows. */
export const shareName = (host = hostname()) => host.replace(/\.local\.?$/i, '').slice(0, 80);

const remoteOf = (req: IncomingMessage) => (req.socket.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
const originOf = (req: IncomingMessage) => `http://${req.headers.host ?? ''}`;
/** A browser's request from a page of another site carries that site's Origin: only this one's goes through. */
const sameOrigin = (req: IncomingMessage) => req.headers.origin === undefined || req.headers.origin === originOf(req);

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(value.join('='));
  }
  return undefined;
}
const bearerToken = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

const Login = z.object({ username: Username, password: z.string().min(1).max(256) });

export async function startShareServer(backend: ShareBackend, options: ShareOptions): Promise<ShareServer> {
  const { uiDir, logger, name } = options;
  const root = uiDir ? resolve(uiDir) : null;
  const pages = root
    ? await Promise.all([readFile(join(root, 'index.html'), 'utf8'), readFile(join(root, 'artifact-runtime/index.html'), 'utf8'), readFile(join(root, 'inline-visual.html'), 'utf8')]).catch(
        () => null,
      )
    : null;
  if (root && !pages) logger.info('The web app build is missing; sharing the API only', { uiDir: root });

  const client = (req: IncomingMessage, kind: ClientInfo['clientKind']): ClientInfo => ({ clientKind: kind, ip: remoteOf(req), userAgent: req.headers['user-agent'] ?? '', network: true });

  const html = (res: ServerResponse, page: string, csp: string) =>
    send(res, 200, page, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'Cache-Control': 'no-cache' });

  async function serveFile(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (!root || !pages) return send(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    // Framed with sandbox="allow-scripts"; its own policy makes the origin opaque, so its module scripts load as CORS requests from "null".
    if (pathname.startsWith('/artifact-runtime/')) return html(res, pages[1], artifactRuntimeCsp("'self'"));
    if (pathname === '/inline-visual.html') return html(res, pages[2], artifactRuntimeCsp("'self'"));
    let wanted: string;
    try {
      wanted = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    const file = resolve(root, `.${wanted}`);
    const inside = file.startsWith(root + sep);
    const info = inside && !wanted.includes('\0') ? await stat(file).catch(() => null) : null;
    if (!info?.isFile()) return html(res, pages[0], APP_CSP);
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    if (type.startsWith('text/html')) return html(res, await readFile(file, 'utf8'), APP_CSP);
    const headers: Record<string, string> = { 'Content-Type': type, 'Content-Length': String(info.size), 'X-Content-Type-Options': 'nosniff' };
    if (pathname.startsWith('/assets/')) Object.assign(headers, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  /** A sign-in from the network: a browser's cookie or an app's bearer token. */
  const signedIn = async (req: IncomingMessage) => {
    const token = cookieToken(req) ?? bearerToken(req);
    return token ? backend.authenticate(token) : null;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!localHostName(req.headers.host)) {
      return send(res, 421, 'Open Atelier on this computer by its address on your network, such as http://192.168.1.20:7340.');
    }
    const { pathname } = new URL(req.url ?? '/', 'http://share');
    if (pathname === '/api/health') return json(res, 200, { ok: true, app: 'atelier', version: APP.version, name });
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { code: 'bad_origin', message: 'Cross-site request refused.' });
      try {
        const input = Login.parse(await body(req));
        const { token, user } = await backend.login(input, client(req, 'web'));
        return json(res, 200, { user }, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}` });
      } catch (e) {
        if (e instanceof BodyTooLarge) return json(res, 413, { code: 'too_large', message: 'That request is too large.' });
        if (e instanceof AccountError) return json(res, e.code === 'rate_limited' ? 429 : 400, { code: e.code, message: e.message });
        if (e instanceof z.ZodError) return json(res, 400, { code: 'invalid_input', message: 'Enter your username and password.' });
        throw e;
      }
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { code: 'bad_origin', message: 'Cross-site request refused.' });
      const auth = await signedIn(req);
      if (auth) await backend.logout(auth.sessionId);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    }
    const blob = /^\/api\/blobs\/([0-9a-f]{64})$/.exec(pathname);
    if (blob && (req.method === 'GET' || req.method === 'HEAD')) {
      const auth = await signedIn(req);
      if (!auth) return json(res, 401, { code: 'unauthenticated' });
      const source = await backend.blobSource(auth.user.id, blob[1]!);
      if (!source) return send(res, 404, 'Not found');
      const answer = await blobResponse(source, req.headers.range, { 'Cache-Control': 'private, max-age=31536000, immutable' });
      res.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
      if (!answer.body || req.method === 'HEAD') return void res.end();
      Readable.fromWeb(answer.body as WebReadableStream).on('error', () => res.destroy()).pipe(res);
      return;
    }
    if (pathname.startsWith('/api/')) {
      return json(res, 404, { code: 'not_found', message: 'An Atelier server has this; a computer shared on the network has sign-in with a password, sessions and files.' });
    }
    return serveFile(req, res, pathname);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      logger.error('A request to the shared computer failed', e);
      if (!res.headersSent) send(res, 500, 'Something went wrong.');
      else res.destroy();
    });
  });
  // The web app sends uploads over the socket, as to a server.
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://share');
    if (pathname !== '/api/ws' || !localHostName(req.headers.host) || !sameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => attach(ws, req));
  });

  function attach(ws: WebSocket, req: IncomingMessage): void {
    const cookie = cookieToken(req);
    const token = cookie ?? bearerToken(req);
    const handlers = new Set<(m: RpcMessage) => void>();
    const closers = new Set<() => void>();
    const transport: Transport = {
      send: (m) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
      },
      onMessage: (h) => (handlers.add(h), () => handlers.delete(h)),
      onClose: (h) => (closers.add(h), () => closers.delete(h)),
    };
    // Browsers bring the cookie; an app that signs in over the socket keeps its token and sends it as a header.
    const disconnect = backend.connect(transport, { ...(token ? { token } : {}), client: client(req, cookie ? 'web' : 'desktop'), origin: originOf(req) });
    ws.on('message', (data, binary) => {
      if (binary) return;
      let message: RpcMessage;
      try {
        message = JSON.parse(String(data)) as RpcMessage;
      } catch {
        return;
      }
      for (const h of handlers) h(message);
    });
    ws.on('close', () => {
      for (const h of closers) h();
      disconnect();
    });
    ws.on('error', () => ws.terminate());
  }

  const listen = (host: string) =>
    new Promise<void>((done, fail) => {
      const failed = (e: Error) => fail(e);
      server.once('error', failed);
      server.listen({ port: options.port, host, ipv6Only: false }, () => {
        server.off('error', failed);
        done();
      });
    });
  try {
    // Both IPv6 and IPv4 where the system has IPv6; IPv4 alone where it doesn't.
    await listen('::').catch((e: NodeJS.ErrnoException) => (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL' ? listen('0.0.0.0') : Promise.reject(e)));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ShareError(
      code === 'EADDRINUSE'
        ? `Port ${options.port} is in use by another program on this computer. Choose another port.`
        : code === 'EACCES'
          ? `Atelier may not use port ${options.port}. Choose another port.`
          : `Atelier couldn’t open port ${options.port}: ${(e as Error).message}`,
    );
  }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  logger.info('Shared on the network', { port });

  return {
    port,
    close: () =>
      new Promise<void>((done) => {
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
