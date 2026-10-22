import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpHandler, WebStandardStreamableHTTPServerTransport, type JSONRPCMessage, type McpHttpHandler, type Transport as ServerTransport } from '@modelcontextprotocol/server';
import { defaultSettings, defaultUserPrefs, McpServerConfig, type ElicitationAnswer, type ElicitationRequest, type ModelInfo, type PendingInteraction, type RunEvent } from '@atelier/protocol';
import { ChatService, type ChatServiceDeps } from '../agent/chat-service.ts';
import { InteractionBroker } from '../agent/interactions.ts';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { FileRepo } from '../files/file-repo.ts';
import { connectorContext } from '../permissions/engine.ts';
import { ProjectRepo } from '../projects/project-repo.ts';
import type { ProviderAdapter, StreamEvent } from '../providers/types.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { BlobStore } from '../store/blobs.ts';
import { openDatabase, type Db } from '../store/db.ts';
import type { ToolContext, ToolOutput } from '../tools/types.ts';
import { mockServer, PIXEL, type MockState } from './__fixtures__/mock-server.ts';
import { oauthMock, type OAuthMockOptions } from './__fixtures__/oauth-server.ts';
import { importClaudeCode } from './import.ts';
import { McpManager, type McpManagerDeps } from './manager.ts';
import { MAX_OUTPUT_CHARS } from './output.ts';

const STDIO_SERVER = fileURLToPath(new URL('./__fixtures__/stdio-server.ts', import.meta.url));
const TOKEN = 'fake-token-0123456789';
const stdio = { type: 'stdio', command: process.execPath, args: [STDIO_SERVER], env: { MOCK_TOKEN: '${secret:mock-token}' } } as const;

let logs: string[];
let stored: { mime: string; size: number }[];
let managers: McpManager[];
let httpServers: HttpServer[];
let state: MockState;
/** The secret store's rows, by id. */
let vault: Map<string, string>;

beforeEach(() => {
  logs = [];
  stored = [];
  managers = [];
  httpServers = [];
  state = { added: false, log: (line) => logs.push(`server: ${line}`) };
  vault = new Map();
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.close()));
  for (const server of httpServers) {
    server.closeAllConnections();
    server.close();
  }
});

function manager(configs: Record<string, object>, deps: Partial<McpManagerDeps> = {}): McpManager {
  const m = new McpManager({
    servers: () => Object.fromEntries(Object.entries(configs).map(([name, c]) => [name, McpServerConfig.parse(c)])),
    surface: 'desktop',
    secret: async (id) => (id === 'mock-token' ? TOKEN : undefined),
    secrets: {
      get: async (id) => vault.get(id),
      set: async ({ id, value }) => (vault.set(id!, value), id!),
      delete: async (id) => void vault.delete(id),
    },
    env: {},
    blobs: {
      put: async (bytes, mime) => {
        stored.push({ mime, size: bytes.byteLength });
        return { sha256: `blob-${stored.length}`, size: bytes.byteLength, mime };
      },
    },
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
    elicit: async () => ({ action: 'decline' }),
    ...deps,
  });
  managers.push(m);
  return m;
}

const context = (signal = new AbortController().signal, sessionId = 's1', callId = 'c1'): ToolContext => ({ sessionId, messageId: 'm1', callId, signal, emit: () => {} });

async function call(m: McpManager, name: string, input: unknown = {}, ctx = context()): Promise<ToolOutput> {
  const tool = (await m.tools()).find((t) => t.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool.run(input, ctx);
}

const textOf = (output: ToolOutput) => output.content.map((p) => (p.type === 'text' ? p.text : `[${p.mime} ${p.blob}]`)).join('');

async function until(condition: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (await condition()) return;
  throw new Error('condition not reached');
}

const ready = (m: McpManager, name = 'mock') => until(() => m.status().find((s) => s.name === name)?.state === 'ready');

/** A web-standard handler on a real port (`port` to restart on the same one). */
async function serve(handle: (request: Request) => Promise<Response>, port = 0): Promise<{ origin: string; server: HttpServer }> {
  const server = createServer(async (req, res) => {
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)] as [string, string]]));
    const response = await handle(new Request(`http://localhost${req.url}`, { method: req.method!, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: gone.signal }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) if (!res.destroyed) res.write(chunk);
    res.end();
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  httpServers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** The mock over Streamable HTTP, behind a bearer token. */
async function httpMock(port = 0): Promise<{ url: string; server: HttpServer; handler: McpHttpHandler }> {
  const handler = createMcpHandler(() => mockServer(state));
  const { origin, server } = await serve(async (request) => (request.headers.get('authorization') === `Bearer ${TOKEN}` ? handler.fetch(request) : new Response('Unauthorized', { status: 401 })), port);
  return { url: `${origin}/mcp`, server, handler };
}

/** The mock as a 2025 server: `initialize` and sessions. Clearing `sessions` is what a restart does to them. */
async function legacyMock(): Promise<{ url: string; sessions: Map<string, WebStandardStreamableHTTPServerTransport>; probes: () => number }> {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let probes = 0;
  const { origin } = await serve(async (request) => {
    if ((await request.clone().text()).includes('"server/discover"')) probes++;
    const id = request.headers.get('mcp-session-id');
    let transport = id ? sessions.get(id) : undefined;
    if (id && !transport) return new Response('Session not found', { status: 404 });
    if (!transport) {
      const created = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => void sessions.set(sid, created) });
      await mockServer(state).connect(created);
      transport = created;
    }
    return transport.handleRequest(request);
  });
  return { url: `${origin}/mcp`, sessions, probes: () => probes };
}

/** The mock as a pre-2025 server: GET /sse opens the stream and names the POST endpoint; the URL refuses POSTs. */
async function sseMock(): Promise<string> {
  let transport: ServerTransport | undefined;
  const encoder = new TextEncoder();
  const { origin } = await serve(async (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/sse') {
      let push: (event: string, data: string) => void = () => {};
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (push = (event, data) => c.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))) });
      transport = { start: async () => {}, send: async (message) => push('message', JSON.stringify(message)), close: async () => {} };
      await mockServer(state).connect(transport);
      push('endpoint', '/messages');
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (request.method === 'POST' && pathname === '/messages') {
      transport?.onmessage?.((await request.json()) as JSONRPCMessage);
      return new Response(null, { status: 202 });
    }
    return new Response('Not found', { status: 404 });
  });
  return `${origin}/sse`;
}

/** Elicitation answered through an interaction broker, as the chat service does. */
function broker() {
  const pending = new Map<string, PendingInteraction>();
  const interactions = new InteractionBroker(async (sessionId, p) => void (p ? pending.set(sessionId, p) : pending.delete(sessionId)));
  const elicit = (sessionId: string, request: ElicitationRequest, signal: AbortSignal) => interactions.ask<ElicitationAnswer>(sessionId, 'elicitation', request, signal, { action: 'cancel' });
  const answer = async (sessionId: string, value: ElicitationAnswer) => {
    await until(() => pending.has(sessionId));
    const question = pending.get(sessionId)!;
    expect(interactions.respond(sessionId, question.id, value)).toBe(true);
    return question.payload as ElicitationRequest;
  };
  return { elicit, answer };
}

describe('MCP tools', () => {
  it('names tools as Claude Code does and passes schemas, descriptions and read-only hints through', async () => {
    const { url } = await httpMock();
    const m = manager({ mock: { type: 'http', url, headers: { Authorization: 'Bearer ${secret:mock-token}' } } });
    const tools = await m.tools();
    const echo = tools.find((t) => t.name === 'mcp__mock__echo')!;
    expect(echo).toMatchObject({ description: 'Echoes its input.', readOnly: true, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } });
    expect(tools.find((t) => t.name === 'mcp__mock__picture')?.readOnly).toBe(false);
    expect(tools.map((t) => t.name)).toContain('mcp__mock__dotted_name');
    const long = tools.find((t) => t.name.startsWith('mcp__mock__long_'))!;
    expect(long.name).toHaveLength(64);
    expect(long.description).toHaveLength(2049);
    expect(m.status()).toEqual([expect.objectContaining({ name: 'mock', type: 'http', state: 'ready', protocolEra: 'modern' })]);
  });

  it('returns text, images, errors and resources, and cuts long output', async () => {
    const { url } = await httpMock();
    const m = manager({ mock: { type: 'http', url, headers: { Authorization: 'Bearer ${secret:mock-token}' } } });
    expect(await call(m, 'mcp__mock__echo', { text: 'hi' })).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect((await call(m, 'mcp__mock__picture')).content).toEqual([
      { type: 'text', text: 'One pixel:' },
      { type: 'image', mime: 'image/png', blob: 'blob-1' },
    ]);
    expect(stored).toEqual([{ mime: 'image/png', size: Buffer.from(PIXEL, 'base64').byteLength }]);
    expect(await call(m, 'mcp__mock__fail')).toEqual({ content: [{ type: 'text', text: 'it broke' }], isError: true });
    const big = textOf(await call(m, 'mcp__mock__big'));
    expect(big.length).toBeLessThan(MAX_OUTPUT_CHARS + 100);
    expect(big).toContain(`[Output truncated: showing ${MAX_OUTPUT_CHARS} of 150000 characters.]`);
    const resources = textOf(await call(m, 'mcp__mock__resources'));
    expect(resources).toContain('[Resource file:///notes.md]\n# Notes');
    expect(resources).toContain('[Resource data.bin: file:///data.bin (application/octet-stream)]');
  });

  it('hides disabled tools and never starts disabled servers', async () => {
    const { url } = await httpMock();
    const headers = { Authorization: 'Bearer ${secret:mock-token}' };
    const m = manager({ mock: { type: 'http', url, headers, disabledTools: ['big'] }, off: { type: 'http', url, headers, enabled: false } });
    const names = (await m.tools()).map((t) => t.name);
    expect(names).toContain('mcp__mock__echo');
    expect(names).not.toContain('mcp__mock__big');
    expect(names.some((n) => n.startsWith('mcp__off__'))).toBe(false);
    const [mock, off] = m.status();
    expect(mock!.tools.find((t) => t.name === 'big')).toMatchObject({ enabled: false });
    expect(off).toEqual({ name: 'off', type: 'http', state: 'disabled', tools: [] });
  });

  it('follows settings changes: an edited server restarts, a removed one goes away', async () => {
    const { url } = await httpMock();
    const configs: Record<string, object> = { mock: { type: 'http', url, headers: { Authorization: 'Bearer ${secret:mock-token}' } } };
    const m = manager(configs);
    await m.tools();
    configs.mock = { ...configs.mock, disabledTools: ['echo'] };
    m.sync();
    await ready(m);
    expect((await m.tools()).map((t) => t.name)).not.toContain('mcp__mock__echo');
    delete configs.mock;
    m.sync();
    expect(m.status()).toEqual([]);
    expect(await m.tools()).toEqual([]);
  });

  it('times out a call that runs too long and tells the server', async () => {
    const m = manager({ mock: stdio }, { callTimeoutMs: 300 });
    const output = await call(m, 'mcp__mock__slow');
    expect(output).toEqual({ content: [{ type: 'text', text: 'The tool did not finish within 0.3 seconds and was cancelled.' }], isError: true });
    await until(() => logs.includes('mcp mock: slow: cancelled'));
  });

  it('cancels a call when the run stops', async () => {
    const m = manager({ mock: stdio });
    const stop = new AbortController();
    const running = call(m, 'mcp__mock__slow', {}, context(stop.signal));
    await until(() => logs.includes('mcp mock: slow: started'));
    stop.abort();
    expect(await running).toEqual({ content: [{ type: 'text', text: 'The call was cancelled.' }], isError: true });
    await until(() => logs.includes('mcp mock: slow: cancelled'));
  });
});

describe('MCP connections', () => {
  it('starts stdio servers with resolved secrets but keeps them out of logs, status and output', async () => {
    const m = manager({ mock: stdio });
    expect(textOf(await call(m, 'mcp__mock__whoami'))).toBe('token: ••••');
    expect(logs).toContain('mcp mock: mock server starting with token ••••');
    expect(m.status()[0]).toMatchObject({ state: 'ready', protocolEra: 'modern' });
    expect(JSON.stringify([logs, m.status()])).not.toContain(TOKEN);
    // Settings › Admin › Developer keeps the server's own log, masked the same way.
    const kept = m.logs('mock')!;
    expect(kept.some((l) => l.endsWith('mock server starting with token ••••'))).toBe(true);
    expect(kept.some((l) => /Connected \(modern protocol\), \d+ tools\./.test(l))).toBe(true);
    expect(JSON.stringify(kept)).not.toContain(TOKEN);
    expect(m.logs('other')).toBeNull();
  });

  it('sends resolved headers over HTTP and explains failures without revealing credentials', async () => {
    const { url } = await httpMock();
    const m = manager({
      mock: { type: 'http', url, headers: { Authorization: 'Bearer ${secret:mock-token}' } },
      missing: { type: 'http', url, headers: { Authorization: 'Bearer ${secret:nope}' } },
      wrong: { type: 'http', url, headers: { Authorization: 'Bearer wrong-literal-token' } },
    });
    expect(textOf(await call(m, 'mcp__mock__whoami'))).toBe('token: ••••');
    const [, missing, wrong] = m.status();
    expect(missing).toMatchObject({ state: 'error', error: 'Missing the secret "nope".' });
    expect(wrong).toMatchObject({ state: 'error', error: expect.stringContaining('401') });
    expect(JSON.stringify([logs, m.status()])).not.toMatch(new RegExp(`${TOKEN}|wrong-literal-token`));
  });

  it('speaks the 2025 protocol to older servers, remembers that, and starts a new session when one expires', async () => {
    const legacy = await legacyMock();
    const m = manager({ mock: { type: 'http', url: legacy.url } });
    expect(textOf(await call(m, 'mcp__mock__echo', { text: 'one' }))).toBe('one');
    expect(m.status()[0]).toMatchObject({ state: 'ready', protocolEra: 'legacy' });
    legacy.sessions.clear();
    expect(await call(m, 'mcp__mock__echo', { text: 'lost' })).toMatchObject({ isError: true });
    await ready(m);
    expect(textOf(await call(m, 'mcp__mock__echo', { text: 'two' }))).toBe('two');
    expect(legacy.probes()).toBe(1);
    await call(m, 'mcp__mock__add_tool');
    await until(async () => (await m.tools()).some((t) => t.name === 'mcp__mock__added'));
  }, 15_000);

  it('falls back to legacy HTTP+SSE for servers from before Streamable HTTP', async () => {
    const m = manager({ mock: { type: 'http', url: await sseMock() } });
    expect(textOf(await call(m, 'mcp__mock__echo', { text: 'over sse' }))).toBe('over sse');
    expect(m.status()[0]).toMatchObject({ state: 'ready', protocolEra: 'legacy' });
  });

  it('refuses stdio servers on the web, where the server never starts programs', async () => {
    const m = manager({ mock: stdio }, { surface: 'web' });
    expect(await m.tools()).toEqual([]);
    expect(m.status()[0]).toMatchObject({ state: 'error', error: expect.stringContaining('only the desktop app') });
    expect(await m.test('mock')).toMatchObject({ state: 'error' });
    expect(logs).toEqual([]);
  });

  it('leaves out the servers a session switched off', async () => {
    const m = manager({ mock: stdio });
    expect((await m.tools(['mock'])).map((t) => t.name)).toEqual([]);
    expect((await m.tools()).map((t) => t.name)).toContain('mcp__mock__echo');
  });

  it('switches a tool off without reconnecting the server', async () => {
    const configs: Record<string, object> = { mock: stdio };
    const m = manager(configs);
    await call(m, 'mcp__mock__echo', { text: 'hi' });
    configs.mock = { ...stdio, disabledTools: ['echo'] };
    m.sync();
    expect((await m.tools()).map((t) => t.name)).not.toContain('mcp__mock__echo');
    expect(m.status()[0]!.tools.find((t) => t.name === 'echo')).toMatchObject({ enabled: false });
    expect(logs.filter((l) => l.includes('mock server starting'))).toHaveLength(1);
  });

  it('reconnects after a stdio server exits', async () => {
    const m = manager({ mock: stdio });
    expect((await call(m, 'mcp__mock__crash')).isError).toBe(true);
    await until(() => m.status()[0]!.state === 'error');
    await ready(m);
    expect(textOf(await call(m, 'mcp__mock__echo', { text: 'back' }))).toBe('back');
  }, 15_000);

  it('refreshes the tools when a stdio server announces a change', async () => {
    const m = manager({ mock: stdio });
    const events: string[][] = [];
    m.on('changed', (list) => events.push(list[0]!.tools.map((t) => t.name)));
    await call(m, 'mcp__mock__add_tool');
    await until(async () => (await m.tools()).some((t) => t.name === 'mcp__mock__added'));
    expect(events.at(-1)).toContain('added');
  });

  it('reconnects after an HTTP server restarts and keeps following its tool changes', async () => {
    const first = await httpMock();
    const m = manager({ mock: { type: 'http', url: first.url, headers: { Authorization: 'Bearer ${secret:mock-token}' } } });
    await m.tools();
    const port = (first.server.address() as AddressInfo).port;
    first.server.closeAllConnections();
    first.server.close();
    await until(() => m.status()[0]!.state === 'error');
    const second = await httpMock(port);
    await ready(m);
    state.added = true;
    // Announced again until the reconnected client's subscription is in place (the client debounces by 300 ms).
    const announcing = setInterval(() => second.handler.notify.toolsChanged(), 500);
    await until(async () => (await m.tools()).some((t) => t.name === 'mcp__mock__added')).finally(() => clearInterval(announcing));
  }, 15_000);
});

describe('MCP OAuth sign-in', () => {
  /** An admin in a browser, on a web server reached at http://atelier.test. */
  const ADMIN = { userId: 'u1', browser: true, origin: 'http://atelier.test' };
  const saved = () => JSON.parse(vault.get('mcp-oauth:mock') ?? 'null') as { client: { client_id: string }; tokens: { access_token: string; refresh_token: string } } | null;

  async function oauthServer(options: OAuthMockOptions = {}) {
    const mock = oauthMock(state, options);
    const { origin } = await serve((request) => mock.handle(request));
    return { mock, origin, url: `${origin}/mcp` };
  }

  /** What the browser does: opens the authorization page, which approves at once and sends it back. */
  async function authorize(page: string): Promise<URLSearchParams> {
    const response = await fetch(page, { redirect: 'manual' });
    expect(response.status).toBe(302);
    return new URL(response.headers.get('location')!).searchParams;
  }

  async function signedIn(m: McpManager): Promise<void> {
    expect(await m.finishSignIn(await authorize(await m.signIn('mock', ADMIN)), ADMIN.userId)).toBeNull();
    await ready(m);
  }

  it('signs in: discovery, registration, the authorization page, the callback once, tokens kept as a secret', async () => {
    const { mock, origin, url } = await oauthServer();
    const m = manager({ mock: { type: 'http', url, auth: 'oauth' } }, { surface: 'web' });
    expect(await m.tools()).toEqual([]);
    expect(m.status()[0]).toEqual({ name: 'mock', type: 'http', state: 'error', tools: [], signIn: 'needed' });

    const page = new URL(await m.signIn('mock', ADMIN));
    expect(page.origin + page.pathname).toBe(`${origin}/authorize`);
    expect(Object.fromEntries(page.searchParams)).toMatchObject({ response_type: 'code', code_challenge_method: 'S256', resource: url, redirect_uri: 'http://atelier.test/oauth/callback' });
    expect(page.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
    expect(mock.clients.get(page.searchParams.get('client_id')!)).toEqual(['http://atelier.test/oauth/callback']);
    expect(m.status()[0]).toMatchObject({ signIn: 'waiting' });

    // The browser has to carry the same admin's sign-in, and each sign-in finishes once.
    expect(await m.finishSignIn(await authorize(page.href), null)).toMatch(/where you started it/);
    expect(m.status()[0]).toMatchObject({ signIn: 'needed' });
    expect(await m.finishSignIn(await authorize(await m.signIn('mock', ADMIN)), 'u2')).toMatch(/where you started it/);
    const back = await authorize(await m.signIn('mock', ADMIN));
    expect(await m.finishSignIn(back, ADMIN.userId)).toBeNull();
    expect(await m.finishSignIn(back, ADMIN.userId)).toMatch(/expired or was used already/);
    expect(await m.finishSignIn(new URLSearchParams({ code: 'x', state: 'made-up' }), ADMIN.userId)).toMatch(/expired or was used already/);

    await ready(m);
    const { access_token } = saved()!.tokens;
    expect(access_token).toMatch(/^fake-access-/);
    expect(textOf(await call(m, 'mcp__mock__whoami'))).toBe('token: Bearer ••••');
    expect(m.status()[0]).not.toHaveProperty('signIn');
    expect(JSON.stringify([logs, m.status(), m.logs('mock')])).not.toContain(access_token);
  });

  it('refreshes an access token once it expires, and when the server refuses it', async () => {
    const { mock, url } = await oauthServer({ tokenSeconds: 1 });
    const m = manager({ mock: { type: 'http', url, auth: 'oauth' } }, { surface: 'web' });
    await signedIn(m);
    const first = saved()!.tokens;
    await new Promise((r) => setTimeout(r, 1100));
    expect(textOf(await call(m, 'mcp__mock__echo', { text: 'later' }))).toBe('later');
    expect(mock.grants).toEqual(['authorization_code', 'refresh_token']);
    expect(saved()!.tokens.refresh_token).not.toBe(first.refresh_token);

    mock.revokeAccess();
    expect(textOf(await call(m, 'mcp__mock__echo', { text: 'again' }))).toBe('again');
    expect(mock.grants).toEqual(['authorization_code', 'refresh_token', 'refresh_token']);
  });

  it('asks for a new sign-in when the refresh is refused, and signs out', async () => {
    const { mock, url } = await oauthServer();
    const m = manager({ mock: { type: 'http', url, auth: 'oauth' } }, { surface: 'web' });
    await signedIn(m);
    mock.revokeAll();
    expect(await call(m, 'mcp__mock__echo', { text: 'hi' })).toEqual({
      content: [{ type: 'text', text: 'The mock connector is signed out. An admin needs to sign in to it again in Settings › Admin › Connectors.' }],
      isError: true,
    });
    expect(m.status()[0]).toMatchObject({ state: 'error', signIn: 'needed' });
    expect(saved()).toBeNull();

    await signedIn(m);
    await m.signOut('mock');
    expect(m.status()[0]).toMatchObject({ state: 'error', signIn: 'needed' });
    expect(saved()).toBeNull();
  });

  it('on the desktop, the browser comes back to a loopback listener that closes afterwards', async () => {
    const { url } = await oauthServer();
    const m = manager({ mock: { type: 'http', url, auth: 'oauth' } });
    await m.tools();
    const desktop = { userId: 'u1', browser: false };
    const callback = new URL(new URL(await m.signIn('mock', desktop)).searchParams.get('redirect_uri')!);
    expect(callback.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(callback.pathname).toBe('/oauth/callback');
    m.cancelSignIn('mock');
    await expect(fetch(callback)).rejects.toThrow();
    expect(m.status()[0]).toMatchObject({ signIn: 'needed' });

    const page = await m.signIn('mock', desktop);
    const back = (await fetch(page, { redirect: 'manual' })).headers.get('location')!;
    const done = await fetch(back);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('You can close this tab');
    await ready(m);
    await expect(fetch(back)).rejects.toThrow();
  });

  it('registers with a client ID metadata document where the server lets no client register', async () => {
    const { mock, url } = await oauthServer({ cimd: true });
    const m = manager({ mock: { type: 'http', url, auth: 'oauth' } }, { surface: 'web' });
    await m.tools();
    // Without an https address to serve the document from, there is no way to register.
    await expect(m.signIn('mock', ADMIN)).rejects.toThrow(/^Signing in failed: /);
    expect(m.status()[0]).toMatchObject({ error: expect.stringMatching(/^Signing in failed: /), signIn: 'needed' });

    const page = new URL(await m.signIn('mock', { ...ADMIN, origin: 'https://atelier.example' }));
    expect(page.searchParams.get('client_id')).toBe('https://atelier.example/oauth/client-metadata.json');
    expect(mock.clients.size).toBe(0);
    expect(await m.finishSignIn(await authorize(page.href), ADMIN.userId)).toBeNull();
    await ready(m);
  });

  it('refuses an authorization page that isn’t https', async () => {
    const mock = oauthMock(state);
    const m = manager({ mock: { type: 'http', url: 'http://mcp.example/mcp', auth: 'oauth' } }, { surface: 'web', fetch: (url, init) => mock.handle(new Request(url, init)) });
    await expect(m.signIn('mock', ADMIN)).rejects.toThrow('Signing in failed: The sign-in page must use https, but it is http://mcp.example.');
  });
});

describe('MCP elicitation', () => {
  it.each(['modern', 'legacy'])('asks the person behind each call, with calls from several sessions at once (Streamable HTTP, %s)', async (era) => {
    const url = era === 'modern' ? (await httpMock()).url : (await legacyMock()).url;
    const { elicit, answer } = broker();
    const m = manager({ mock: { type: 'http', url, headers: { Authorization: 'Bearer ${secret:mock-token}' } } }, { elicit });
    const ada = call(m, 'mcp__mock__ask', {}, context(undefined, 'ada', 'call-ada'));
    const bob = call(m, 'mcp__mock__ask', {}, context(undefined, 'bob', 'call-bob'));
    expect(await answer('bob', { action: 'decline' })).toMatchObject({ callId: 'call-bob' });
    expect(await answer('ada', { action: 'accept', content: { name: 'Ada' } })).toEqual({
      callId: 'call-ada',
      server: 'mock',
      message: 'What is your name?',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    });
    expect(textOf(await ada)).toBe('Hello Ada');
    expect(textOf(await bob)).toBe('No name (decline)');
  });

  it('ties a stdio server’s request to its running call, and shows URL requests without opening them', async () => {
    const { elicit, answer } = broker();
    const m = manager({ mock: stdio }, { elicit });
    const asked = call(m, 'mcp__mock__ask');
    expect(await answer('s1', { action: 'accept', content: { name: 'Grace' } })).toMatchObject({ callId: 'c1', server: 'mock' });
    expect(textOf(await asked)).toBe('Hello Grace');
    const signIn = call(m, 'mcp__mock__sign_in');
    expect(await answer('s1', { action: 'accept' })).toEqual({ callId: 'c1', server: 'mock', message: 'Sign in to Mock', url: 'https://mock.example/login' });
    expect(textOf(await signIn)).toBe('Sign-in accept');
  });

  it('declines when it cannot tell whose call a request belongs to', async () => {
    let asked = 0;
    const m = manager({ mock: stdio }, { elicit: async () => (asked++, { action: 'accept', content: { name: 'X' } }) });
    const stop = new AbortController();
    const slow = call(m, 'mcp__mock__slow', {}, context(stop.signal, 's2', 'c2'));
    await until(() => logs.includes('mcp mock: slow: started'));
    expect(textOf(await call(m, 'mcp__mock__ask'))).toBe('No name (decline)');
    expect(asked).toBe(0);
    stop.abort();
    await slow;
  });
});

describe('MCP tools in a run', () => {
  let dir: string;
  let db: Db;
  let repo: SessionRepo;
  let events: RunEvent[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atelier-mcp-'));
    db = openDatabase(':memory:');
    repo = new SessionRepo(db);
    events = [];
  });
  afterEach(async () => {
    db.$client.close();
    await rm(dir, { recursive: true, force: true });
  });

  const info: ModelInfo = {
    ref: 'fake/m',
    providerId: 'fake',
    modelId: 'm',
    displayName: 'Fake',
    contextLength: 100_000,
    maxOutput: 4000,
    capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: false },
    tier: 'full',
    source: 'default',
    hidden: false,
    favorite: false,
    order: 0,
  };

  /** Calls one tool, then repeats its result. */
  const caller = (name: string, input: Record<string, unknown> = {}): ProviderAdapter => ({
    type: 'openai-compatible',
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
    async *stream(req): AsyncIterable<StreamEvent> {
      const last = req.messages.at(-1);
      if (req.system.some((b) => b.text.includes('short title'))) yield { type: 'text', delta: 'Title' };
      else if (last?.role === 'tool') yield { type: 'text', delta: last.parts.map((p) => (p.type === 'tool_result' ? p.content.map((c) => (c.type === 'text' ? c.text : '')).join('') : '')).join('') };
      else {
        yield { type: 'tool_call_start', id: 'call1', name };
        yield { type: 'tool_call_end', id: 'call1', input };
        yield { type: 'finish', reason: 'tool_use' };
        return;
      }
      yield { type: 'finish', reason: 'end' };
    },
  });

  /** A chat service whose sessions get the mock connector's tools over Streamable HTTP. */
  async function service(adapter: ProviderAdapter, deps: Partial<ChatServiceDeps> = {}): Promise<ChatService> {
    const { url } = await httpMock();
    const blobs = new BlobStore(db, join(dir, 'blobs'));
    const m = manager({ mock: { type: 'http', url, headers: { Authorization: 'Bearer ${secret:mock-token}' } } }, { elicit: (sessionId, request, signal) => chat.elicit(sessionId, request, signal) });
    const chat: ChatService = new ChatService({
      repo,
      artifacts: new ArtifactRepo(db),
      files: new FileRepo(db, blobs),
      projects: new ProjectRepo(db),
      blobs,
      settings: () => defaultSettings(),
      models: { resolve: async () => ({ adapter, info }), firstAvailable: async () => 'fake/m' },
      promptOverrides: () => ({}),
      sessionEvent: (_s, _seq, event) => events.push(event),
      sessionChanged: () => {},
      recordUsage: () => {},
      person: async () => ({ prefs: defaultUserPrefs(), name: 'Tester', safeguards: 'inherit' as const }),
      mcpTools: () => m.tools(),
      fetch: async () => new Response('', { status: 503 }),
      resolveRefs: async (v) => v,
      now: () => new Date('2026-10-13T12:00:00Z'),
      timeZone: 'UTC',
      ...deps,
    });
    return chat;
  }

  const pendingOf = async (chat: ChatService, sessionId: string, kind: PendingInteraction['kind']) => {
    await until(async () => (await chat.snapshot(sessionId)).pending?.kind === kind);
    return (await chat.snapshot(sessionId)).pending!;
  };
  const reply = async (chat: ChatService, sessionId: string) => (await chat.snapshot(sessionId)).messages.at(-1)?.parts;

  it('puts the server’s question to the person and takes only an elicitation answer', async () => {
    const chat = await service(caller('mcp__mock__ask'));
    const session = await repo.create({ mode: 'chat', userId: null });
    await chat.send(session.id, [{ type: 'text', text: 'greet me' }]);
    const pending = await pendingOf(chat, session.id, 'elicitation');
    expect(pending.payload).toMatchObject({ callId: 'call1', server: 'mock', message: 'What is your name?' });
    expect(chat.respond(session.id, pending.id, { behavior: 'allow' })).toBe(false);
    expect(chat.respond(session.id, pending.id, { action: 'accept', content: { name: 'Ada' } })).toBe(true);
    await chat.settle(session.id);
    expect(await reply(chat, session.id)).toEqual([{ type: 'text', text: 'Hello Ada' }]);
  });

  it('asks before a connector tool runs in a chat, read-only hint or not, unless a rule allows it', async () => {
    const gate = (allow: string[]) => async () => connectorContext({ allow, ask: [], deny: [] }, '/home/me');
    const chat = await service(caller('mcp__mock__echo', { text: 'hi' }), { permissionContext: gate([]) });
    const session = await repo.create({ mode: 'chat', userId: null });
    await chat.send(session.id, [{ type: 'text', text: 'echo' }]);
    const pending = await pendingOf(chat, session.id, 'permission');
    expect(pending.payload).toMatchObject({ toolName: 'mcp__mock__echo', suggestedRule: 'mcp__mock__echo' });
    chat.respond(session.id, pending.id, { behavior: 'allow' });
    await chat.settle(session.id);
    expect(await reply(chat, session.id)).toEqual([{ type: 'text', text: 'hi' }]);

    const allowed = await service(caller('mcp__mock__echo', { text: 'again' }), { permissionContext: gate(['mcp__mock']) });
    const other = await repo.create({ mode: 'chat', userId: null });
    await allowed.send(other.id, [{ type: 'text', text: 'echo' }]);
    await allowed.settle(other.id);
    expect(events.filter((e) => e.type === 'pending' && e.pending)).toHaveLength(1);
    expect(await reply(allowed, other.id)).toEqual([{ type: 'text', text: 'again' }]);
  });

  it('asks a sub-agent’s questions in its parent session', async () => {
    const chat = await service(caller('mcp__mock__ask'));
    const parent = await repo.create({ mode: 'code', userId: null });
    const child = await repo.create({ mode: 'code', userId: null, parentSessionId: parent.id });
    const answer = chat.elicit(child.id, { server: 'mock', message: 'Sign in', url: 'https://mock.example/login' }, new AbortController().signal);
    const pending = await pendingOf(chat, parent.id, 'elicitation');
    expect(pending.payload).toMatchObject({ url: 'https://mock.example/login' });
    expect(chat.respond(parent.id, pending.id, { action: 'decline' })).toBe(true);
    expect(await answer).toEqual({ action: 'decline' });
  });
});

describe('Claude Code import', () => {
  it('converts user, project and .mcp.json servers and flags literal credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-home-'));
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: { '/work': { mcpServers: { project: { command: 'x' } } } },
        mcpServers: {
          notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: 'ntn_1234567890abcdef', DEBUG: 'true' } },
          'linear.app': { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer lin_api_abcdefghijkl' } },
          github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_PAT}' } },
          zapier: { type: 'sse', url: 'https://mcp.zapier.com/sse?api_key=0123456789abcdef' },
          ide: { type: 'ws-ide', url: 'ws://127.0.0.1:1234' },
        },
      }),
    );
    try {
      const repo = join(home, 'repo');
      await mkdir(repo);
      await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { project: { type: 'http', url: 'https://mcp.example.com/mcp' } } }));
      expect(await importClaudeCode(home, [repo, join(home, 'empty')])).toEqual([
        { name: 'notion', config: expect.objectContaining({ type: 'stdio', command: 'npx', env: { NOTION_TOKEN: 'ntn_1234567890abcdef', DEBUG: 'true' } }), secrets: [['env', 'NOTION_TOKEN']], source: '~/.claude.json' },
        { name: 'linear-app', config: expect.objectContaining({ type: 'http', url: 'https://mcp.linear.app/mcp' }), secrets: [['headers', 'Authorization']], source: '~/.claude.json' },
        { name: 'github', config: expect.objectContaining({ headers: { Authorization: 'Bearer ${GITHUB_PAT}' } }), secrets: [], source: '~/.claude.json' },
        { name: 'zapier', config: expect.objectContaining({ type: 'sse' }), secrets: [['url']], source: '~/.claude.json' },
        { name: 'project', config: expect.objectContaining({ type: 'stdio', command: 'x' }), secrets: [], source: '~/.claude.json (/work)' },
        { name: 'project-2', config: expect.objectContaining({ type: 'http', url: 'https://mcp.example.com/mcp' }), secrets: [], source: join(repo, '.mcp.json') },
      ]);
      expect(await importClaudeCode(join(home, 'nowhere'))).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
