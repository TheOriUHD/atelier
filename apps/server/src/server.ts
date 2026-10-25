/**
 * Atelier web server: serves the UI, a WebSocket RPC endpoint backed by the shared core backend, and
 * blob downloads. Until authentication lands (M5) it only binds to loopback addresses.
 */
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { AccountError, AesGcmCipher, createBackend, loadServerKey, type ClientInfo, type LinkSocket } from '@atelier/core';
import { APP, artifactRuntimeCsp, DEVICE_HEADERS, DEVICE_LINK_PATH, DeviceInfo, Password, Username, type RpcMessage, type Transport } from '@atelier/protocol';
import { z } from 'zod';
import { oauthRoutes } from './oauth.ts';
import { clientIp, originRefusal, proxyConfig, publicOrigin } from './proxy.ts';
import { updateFeed } from './updates.ts';

const env = process.env;
const dataDir = resolve(env.ATELIER_DATA_DIR ?? '.atelier-data');
const host = env.ATELIER_HOST ?? '127.0.0.1';
const port = Number(env.ATELIER_PORT ?? 7340);
const uiDir = resolve(env.ATELIER_UI_DIR ?? join(import.meta.dirname, '../../../packages/ui/dist'));

if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  console.warn(`Listening on ${host}. Put Atelier behind HTTPS (a reverse proxy such as Caddy) before exposing it beyond your machine.`);
}

const logger = {
  info: (message: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ level: 'info', message, ...data })),
  warn: (message: string, data?: Record<string, unknown>) => console.warn(JSON.stringify({ level: 'warn', message, ...data })),
  error: (message: string, error?: unknown) =>
    console.error(JSON.stringify({ level: 'error', message, ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }) })),
};

const key = await loadServerKey(join(dataDir, 'secret.key'), env.ATELIER_SECRET_KEY);
// The first account can only be created with this one-time token, printed below, so whoever reaches a
// fresh server first can't make themselves its admin.
const setupToken = env.ATELIER_SETUP_TOKEN || randomBytes(12).toString('base64url');
const backend = await createBackend({
  surface: 'web',
  configDir: dataDir,
  dataDir,
  cipher: new AesGcmCipher(key),
  env,
  logger,
  setupToken,
  // Runner builds to put into codespaces; the server itself never runs folders on its own machine.
  ...(env.ATELIER_RUNNER_DIR ? { runnerDir: resolve(env.ATELIER_RUNNER_DIR) } : {}),
});
if (await backend.accounts.setupRequired()) logger.info('No accounts yet. Create the admin in the browser with this setup token', { setupToken });

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

/**
 * The web app's own pages: scripts and styles from this server only; images only from here (markdown
 * images can't beacon data to other hosts); the artifact runtime is framed from this origin and sets its
 * own stricter policy.
 */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use('*', async (c, next) => {
  await next();
  if (c.res.headers.get('content-type')?.startsWith('text/html') && !c.req.path.startsWith('/artifact-runtime/') && c.req.path !== '/inline-visual.html') {
    c.res.headers.set('Content-Security-Policy', APP_CSP);
  }
});

// Unauthenticated: just enough for the desktop app to recognize an Atelier server on the local network.
app.get('/api/health', (c) => c.json({ ok: true, app: 'atelier', version: APP.version }));

// ------------------------------------------------------------------ sign-in (browsers)
// Browsers sign in over HTTP so the session token lives in an HttpOnly cookie that scripts can't read.
// Desktop apps sign in over RPC and keep their token in the OS keychain.

const COOKIE = APP.cookie;
const proxy = proxyConfig(env.ATELIER_TRUSTED_PROXIES, env.ATELIER_BASE_URL);
const remoteOf = (c: Context) => getConnInfo(c).remote.address ?? '';
const originOf = (c: Context) => publicOrigin(proxy, { url: c.req.url, remote: remoteOf(c), header: (name) => c.req.header(name) });
const clientOf = (c: Context): ClientInfo => ({ clientKind: 'web', ip: clientIp(proxy, remoteOf(c), c.req.header('x-forwarded-for')), userAgent: c.req.header('user-agent') ?? '' });
const tokenOf = (c: Context): string | undefined => getCookie(c, COOKIE) ?? c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
/** Signed in with the browser's cookie or a desktop app's bearer token. */
const authenticated = async (c: Context) => {
  const token = tokenOf(c);
  return !!token && !!(await backend.authenticate(token));
};
const secure = (c: Context) => originOf(c).startsWith('https:');

/** Cross-site form posts can't sign anyone in or out: the Origin must be the one people use for this server. */
const refusalsSaid = new Map<string, number>();
const sameOrigin = (c: Context, what = 'a cross-site request') => {
  const origin = c.req.header('origin');
  if (!origin || origin === originOf(c)) return true;
  const notice = originRefusal(proxy, refusalsSaid, { what, origin, expected: originOf(c), remote: remoteOf(c), now: Date.now() });
  if (notice) logger.warn(notice);
  return false;
};

const signIn = async (c: Context, run: (client: ClientInfo) => Promise<{ token: string; user: unknown }>) => {
  if (!sameOrigin(c)) return c.json({ code: 'bad_origin', message: 'Cross-site request refused.' }, 403);
  try {
    const { token, user } = await run(clientOf(c));
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: secure(c), path: '/', maxAge: 30 * 24 * 3600 });
    return c.json({ user });
  } catch (e) {
    if (e instanceof AccountError) return c.json({ code: e.code, message: e.message }, e.code === 'rate_limited' ? 429 : 400);
    if (e instanceof z.ZodError) return c.json({ code: 'invalid_input', message: e.issues.map((i) => i.message).join('; ') }, 400);
    throw e;
  }
};

const NewAccount = z.object({ username: Username, name: z.string().trim().min(1).max(80), password: Password });

// ------------------------------------------------------------------ passkeys (browsers)
// WebAuthn binds a passkey to the hostname people use, so the relying party is this server's public origin.
const relyingParty = (c: Context) => ({ origin: originOf(c), name: APP.name });
// The browser's credential JSON is checked by the WebAuthn library itself.
const Ceremony = z.object({ flowId: z.string().max(64), response: z.looseObject({ id: z.string().max(1024) }) });

app.post('/api/auth/passkey/options', async (c) => {
  if (!sameOrigin(c)) return c.json({ code: 'bad_origin', message: 'Cross-site request refused.' }, 403);
  return c.json(await backend.passkeys.authenticationOptions(relyingParty(c)));
});
app.post('/api/auth/passkey', (c) =>
  signIn(c, async (client) => {
    const { flowId, response } = Ceremony.parse(await c.req.json());
    return backend.passkeys.signIn(flowId, response as never, relyingParty(c), client);
  }),
);

/** Adding a passkey needs a browser sign-in (the cookie) and this site's origin. */
const signedInUser = async (c: Context) => {
  const token = sameOrigin(c) ? getCookie(c, COOKIE) : undefined;
  return token ? ((await backend.authenticate(token))?.user ?? null) : null;
};
app.post('/api/passkeys/options', async (c) => {
  const user = await signedInUser(c);
  if (!user) return c.json({ code: 'unauthenticated', message: 'Sign in first.' }, 401);
  return c.json(await backend.passkeys.registrationOptions(user, relyingParty(c)));
});
app.post('/api/passkeys', async (c) => {
  const user = await signedInUser(c);
  if (!user) return c.json({ code: 'unauthenticated', message: 'Sign in first.' }, 401);
  try {
    const body = Ceremony.extend({ name: z.string().max(80).default('') }).parse(await c.req.json());
    return c.json(await backend.passkeys.register(user, body.flowId, body.response as never, relyingParty(c), body.name));
  } catch (e) {
    if (e instanceof AccountError) return c.json({ code: e.code, message: e.message }, 400);
    if (e instanceof z.ZodError) return c.json({ code: 'invalid_input', message: e.issues.map((i) => i.message).join('; ') }, 400);
    throw e;
  }
});

app.post('/api/auth/login', (c) =>
  signIn(c, async (client) => {
    const body = z.object({ username: Username, password: z.string().min(1).max(256) }).parse(await c.req.json());
    return backend.accounts.login(body, client);
  }),
);
app.post('/api/auth/setup', (c) =>
  signIn(c, async (client) => {
    const body = NewAccount.extend({ setupToken: z.string() }).parse(await c.req.json());
    if (body.setupToken !== setupToken) throw new AccountError('invalid_credentials', 'That setup token is wrong. It is printed in the server log.');
    return backend.accounts.setup(body, client);
  }),
);
app.post('/api/auth/invite', (c) =>
  signIn(c, async (client) => {
    const body = NewAccount.extend({ invite: z.string().min(16).max(200) }).parse(await c.req.json());
    return backend.accounts.acceptInvite(body, client);
  }),
);
app.post('/api/auth/logout', async (c) => {
  if (!sameOrigin(c)) return c.json({ code: 'bad_origin', message: 'Cross-site request refused.' }, 403);
  const token = tokenOf(c);
  const auth = token ? await backend.authenticate(token) : null;
  if (auth) await backend.logout(auth.sessionId);
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

oauthRoutes(app, backend, { cookie: COOKIE, originOf });

const INLINE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;
app.get('/api/blobs/:sha', async (c) => {
  if (!(await authenticated(c))) return c.json({ code: 'unauthenticated' }, 401);
  const blob = await backend.readBlob(c.req.param('sha')).catch(() => undefined);
  if (!blob) return c.notFound();
  const inline = INLINE_TYPES.test(blob.mime);
  return c.body(blob.bytes, 200, {
    'Content-Type': inline ? blob.mime : 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

// Desktop apps signed in to this server update from here (electron-updater's generic provider).
app.route('/updates', updateFeed({ repo: env.ATELIER_UPDATES_REPO, token: env.ATELIER_UPDATES_TOKEN, authenticated }));
if (env.ATELIER_UPDATES_REPO && env.ATELIER_UPDATES_TOKEN) logger.info('Serving desktop updates from GitHub releases', { repo: env.ATELIER_UPDATES_REPO });

app.get(
  '/api/ws',
  // Browsers send an Origin on WebSocket upgrades but no CORS applies: refuse other sites outright.
  async (c, next) => (sameOrigin(c, 'a WebSocket') ? next() : c.json({ code: 'bad_origin', message: 'Cross-site WebSocket refused.' }, 403)),
  upgradeWebSocket((c) => {
    const token = tokenOf(c);
    // Browsers bring the session cookie; the desktop app's relay sends its token as a header.
    const client: ClientInfo = { ...clientOf(c), clientKind: getCookie(c, COOKIE) ? 'web' : 'desktop' };
    const origin = originOf(c);
    let disconnect: (() => void) | undefined;
    const handlers = new Set<(m: RpcMessage) => void>();
    const closeHandlers = new Set<() => void>();
    return {
      onOpen(_event, ws) {
        const transport: Transport = {
          send: (m) => ws.send(JSON.stringify(m)),
          onMessage: (h) => (handlers.add(h), () => handlers.delete(h)),
          onClose: (h) => (closeHandlers.add(h), () => closeHandlers.delete(h)),
        };
        disconnect = backend.connect(transport, { ...(token ? { token } : {}), client, origin });
      },
      onMessage(event) {
        if (typeof event.data !== 'string') return;
        let message: RpcMessage;
        try {
          message = JSON.parse(event.data) as RpcMessage;
        } catch {
          return;
        }
        for (const h of handlers) h(message);
      },
      onClose() {
        for (const h of closeHandlers) h();
        disconnect?.();
      },
    };
  }),
);

// A signed-in desktop app lending its runner for folders on that machine (ARCHITECTURE §21). Bearer token
// only: browsers can't set that header, so no web page can open a link with someone's cookie.
const MAX_EARLY_FRAMES = 100;
app.get(
  DEVICE_LINK_PATH,
  upgradeWebSocket((c) => {
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
    const device = DeviceInfo.safeParse({ id: c.req.header(DEVICE_HEADERS.id), name: c.req.header(DEVICE_HEADERS.name), platform: c.req.header(DEVICE_HEADERS.platform) });
    let link: { receive(text: string): void; closed(): void } | null = null;
    const early: string[] = [];
    let closed = false;
    return {
      async onOpen(_event, ws) {
        const socket: LinkSocket = {
          send: (frame) => ws.readyState === 1 && ws.send(JSON.stringify(frame)),
          close: () => ws.close(),
        };
        link = token && device.success ? await backend.linkDevice(socket, token, device.data) : null;
        if (!link) return ws.close(4401, 'Sign in again in the desktop app.');
        if (closed) return link.closed();
        for (const text of early.splice(0)) link.receive(text);
      },
      onMessage(event) {
        if (typeof event.data !== 'string') return;
        if (link) link.receive(event.data);
        else if (early.length < MAX_EARLY_FRAMES) early.push(event.data);
      },
      onClose() {
        closed = true;
        link?.closed();
      },
    };
  }),
);

if (existsSync(uiDir)) {
  const index = await readFile(join(uiDir, 'index.html'), 'utf8');
  const artifactPage = await readFile(join(uiDir, 'artifact-runtime/index.html'), 'utf8');
  // Framed with sandbox="allow-scripts"; the CSP sandbox makes the origin opaque even when opened directly,
  // so its module scripts arrive as CORS requests from "null".
  app.get('/artifact-runtime/*', (c) =>
    c.html(artifactPage, 200, { 'Content-Security-Policy': artifactRuntimeCsp("'self'"), 'X-Content-Type-Options': 'nosniff' }),
  );
  const inlinePage = await readFile(join(uiDir, 'inline-visual.html'), 'utf8');
  app.get('/inline-visual.html', (c) =>
    c.html(inlinePage, 200, { 'Content-Security-Policy': artifactRuntimeCsp("'self'"), 'X-Content-Type-Options': 'nosniff' }),
  );
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Access-Control-Allow-Origin', '*');
  });
  app.use('/assets/*', serveStatic({ root: uiDir }));
  app.use('/*', serveStatic({ root: uiDir }));
  app.get('*', (c) => c.html(index));
} else {
  logger.info('UI build not found; serving the API only', { uiDir });
}

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => logger.info('listening', { url: `http://${host}:${info.port}` }));
injectWebSocket(server);

const shutdown = async () => {
  server.close();
  await backend.dispose();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
