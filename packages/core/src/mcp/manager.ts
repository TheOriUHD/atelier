/**
 * MCP connectors (ARCHITECTURE §9-B): one client per configured server, shared by every session. A server
 * connects on first use or when its status is asked for, reconnects with backoff after a drop, follows the
 * server's `list_changed`, and restarts when its settings change. Each enabled tool of a ready server becomes an
 * `mcp__<server>__<tool>` tool. OAuth servers connect with the sign-in an admin made (`oauth.ts`); without one
 * they wait for it instead of retrying.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type ConnectOptions,
  type ElicitRequest,
  type ElicitResult,
  type FetchLike,
  type PriorDiscovery,
  type Tool as ServerTool,
  type Transport,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { APP, mcpToolName, type ElicitationAnswer, type ElicitationRequest, type McpServerConfig, type McpServerStatus } from '@atelier/protocol';
import type { JsonSchema } from '../providers/types.ts';
import type { BlobStore } from '../store/blobs.ts';
import { textOutput, type Tool, type ToolContext, type ToolOutput } from '../tools/types.ts';
import { escapeTags } from '../prompts/escape.ts';
import { interpolate } from '../util/interpolate.ts';
import { CLIENT_METADATA_PATH, loadCredentials, loopbackCallback, OAUTH_CALLBACK_PATH, oauthSecretId, PendingSignIn, saveCredentials, StoredSignIn, type OAuthSecrets } from './oauth.ts';
import { toOutput } from './output.ts';

export interface McpManagerDeps {
  /** The configured servers (system settings). */
  servers(): Record<string, McpServerConfig>;
  /** Only the desktop's backend starts stdio servers: a web server never spawns programs. */
  surface: 'desktop' | 'web';
  secret(id: string): Promise<string | undefined>;
  /** Where OAuth servers' sign-ins are kept. */
  secrets: OAuthSecrets;
  env: Record<string, string | undefined>;
  blobs: Pick<BlobStore, 'put'>;
  logger: { info(message: string): void; error(message: string): void };
  /** Asks the person behind a session and waits for the answer; the signal withdraws the question. */
  elicit(sessionId: string, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationAnswer>;
  fetch?: FetchLike;
  /** How long a call may run, not counting the time the person takes to answer the server. */
  callTimeoutMs?: number;

  // A person's own connectors (personal.ts) are reached another way, with their own secrets.
  /**
   * How a server is reached instead of as configured here: a transport to its program somewhere else, or the `fetch`
   * its HTTP requests go through. Throws when it can't be reached now; `log` takes what the program writes to stderr.
   */
  reach?(server: { name: string; config: McpServerConfig }, resolved: Resolved, log: (line: string) => void): Promise<{ transport: Transport } | { fetch: FetchLike }>;
  /** Whether a server can start at all; by default stdio ones only where the backend is the desktop's. */
  startable?(config: McpServerConfig): boolean;
  /** The secret an OAuth server's sign-in is kept as (`mcp-oauth:<name>` by default). */
  signInSecret?(name: string): string;
  /** A stdio server's `${ENV}` references are left as written, for the computer its program runs on to fill in. */
  deferEnv?: boolean;
}

/** A tool call in flight, so that a server's question during it reaches the right person. */
interface Call {
  sessionId: string;
  callId: string;
  signal: AbortSignal;
  /** Pauses the call's timeout while the person answers, and restarts it after. */
  hold(): void;
  release(): void;
}

interface Server {
  name: string;
  config: McpServerConfig;
  key: string;
  /** `idle` until first asked for; shown as connecting, since asking starts it. */
  state: 'idle' | McpServerStatus['state'];
  error?: string;
  client: Client | null;
  tools: ServerTool[];
  era?: 'modern' | 'legacy';
  /** Set once the server turned out to be legacy, so reconnects skip the modern probe. */
  prior?: PriorDiscovery;
  /** An `http` server that only speaks the legacy HTTP+SSE transport. */
  sse: boolean;
  connecting: Promise<void> | null;
  retry?: NodeJS.Timeout;
  failures: number;
  /** Resolved credentials, masked wherever the server's output, errors or logs go. */
  secrets: string[];
  /** An OAuth server's sign-in, as its latest connection uses it. */
  auth: StoredSignIn | null;
  /** An OAuth server without a usable sign-in: it waits for one instead of retrying. */
  needsSignIn: boolean;
  calls: Set<Call>;
  /** Removed or shut down: a connect still in flight closes its client again. */
  closed: boolean;
}

/** An admin's sign-in, waiting for the authorization server to send the browser back. */
interface SignIn {
  flow: PendingSignIn;
  userId: string;
  /** Started in a browser, whose sign-in to Atelier the callback must carry too. */
  browser: boolean;
  timer: NodeJS.Timeout;
  /** The desktop's loopback listener. */
  close?: () => void;
}

/** Who starts a sign-in and, on the web, the origin they reach this server at, where the browser comes back to. */
export interface SignInStarter {
  userId: string;
  browser: boolean;
  origin?: string | undefined;
}

/** The call a server's request arrives within, where the transport keeps that context (Streamable HTTP). */
const within = new AsyncLocalStorage<Call>();

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
/** A legacy stdio server may never answer the modern probe. */
const PROBE_TIMEOUT_MS = 10_000;
/** How long a run waits for servers still connecting before it starts without their tools. */
const FIRST_USE_WAIT_MS = 10_000;
const MAX_RETRY_MS = 5 * 60_000;
/** The SDK's request timeout is replaced by the call's own, which pauses while the person answers. */
const NO_SDK_TIMEOUT = 2 ** 31 - 1;
/** Claude Code's cap on a connector tool's description. */
const MAX_DESCRIPTION_CHARS = 2048;
/** Shorter values (flags, ports) are too likely to appear by chance to be masked. */
const MIN_SECRET_CHARS = 8;
/** Log lines kept per server for Settings › Admin › Developer. */
const KEEP_LOG_LINES = 200;
/** How long a sign-in waits for the browser to come back. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const SIGN_IN_NEEDED = 'Not signed in.';

class SignInNeeded extends Error {
  constructor() {
    super(SIGN_IN_NEEDED);
  }
}

export class McpManager extends EventEmitter<{ changed: [McpServerStatus[]] }> {
  private servers = new Map<string, Server>();
  /** By server name, so a server's history survives its settings changing. */
  private logBook = new Map<string, string[]>();
  /** Pending sign-ins, by server name. */
  private signIns = new Map<string, SignIn>();

  constructor(private readonly deps: McpManagerDeps) {
    super();
    this.sync();
  }

  /** Call on every settings change: changed servers restart, removed ones close, new ones wait until needed. */
  sync(): void {
    const next = new Map<string, Server>();
    let changed = false;
    for (const [name, config] of Object.entries(this.deps.servers())) {
      const existing = this.servers.get(name);
      if (existing?.key === JSON.stringify(config)) {
        next.set(name, existing);
        continue;
      }
      // Switching tools on or off changes what is offered, not the connection.
      if (existing && existing.key === JSON.stringify({ ...config, disabledTools: existing.config.disabledTools })) {
        existing.config = config;
        existing.key = JSON.stringify(config);
        next.set(name, existing);
        changed = true;
        continue;
      }
      const server = this.create(name, config);
      next.set(name, server);
      changed = true;
      if (!existing) continue;
      void this.shutdown(existing);
      // A server in use stays in use with its new settings.
      if (existing.state === 'ready' && server.state === 'idle') void this.connect(server);
    }
    for (const [name, server] of this.servers) {
      if (next.has(name)) continue;
      void this.shutdown(server);
      changed = true;
    }
    this.servers = next;
    if (changed) this.publish();
  }

  /** Reconnects every server with its current settings (Settings › Admin › Developer). */
  restart(): void {
    for (const server of this.servers.values()) void this.shutdown(server);
    this.servers.clear();
    this.sync();
  }

  /** A server's recent log (its stderr, connections and failures), credentials masked; null when there is no such server. */
  logs(name: string): string[] | null {
    return this.servers.has(name) ? [...(this.logBook.get(name) ?? [])] : null;
  }

  /** Every server's status; servers not tried yet start connecting, and `changed` events follow. */
  status(): McpServerStatus[] {
    for (const server of this.servers.values()) void this.ensure(server);
    return this.statusList();
  }

  /** Every server's status as it is, connecting nothing. */
  current(): McpServerStatus[] {
    return this.statusList();
  }

  /** Connects a server now (after an edit); null when there is no such server. */
  async test(name: string): Promise<McpServerStatus | null> {
    const server = this.servers.get(name);
    if (!server) return null;
    if (this.startable(server)) {
      server.failures = 0;
      await this.connect(server);
    }
    return this.statusOf(server);
  }

  /** The tools of every ready server (except those switched `off` for the session), after waiting a little for servers still connecting. */
  async tools(off: readonly string[] = []): Promise<Tool[]> {
    const servers = [...this.servers.values()].filter((s) => !off.includes(s.name));
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise((resolve) => (timer = setTimeout(resolve, FIRST_USE_WAIT_MS)));
    await Promise.race([Promise.all(servers.map((s) => this.ensure(s))), waited]);
    clearTimeout(timer);
    const seen = new Set<string>();
    return servers.flatMap((server) => (server.state === 'ready' ? this.toolsOf(server, seen) : []));
  }

  async close(): Promise<void> {
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(servers.map((s) => this.shutdown(s)));
  }

  /** Connects again, now, every server that failed and doesn't wait for a sign-in (the computer it runs on came back). */
  retry(): void {
    for (const server of this.servers.values()) {
      if (server.state !== 'error' || server.needsSignIn || server.connecting || !this.startable(server)) continue;
      server.failures = 0;
      void this.connect(server);
    }
  }

  /** Whether a sign-in waiting here started with this OAuth `state`. */
  signingIn(state: string | null): boolean {
    return [...this.signIns.values()].some((p) => p.flow.id === state);
  }

  /**
   * Starts signing an OAuth server in and returns the page to open. The browser comes back to the desktop's loopback
   * listener, or to the web server's `/oauth/callback` on `starter.origin`.
   */
  async signIn(name: string, starter: SignInStarter): Promise<string> {
    const server = this.servers.get(name);
    if (!server?.config.auth) throw new Error(`${name} doesn’t sign in with OAuth.`);
    this.cancelSignIn(name);
    const { url } = await this.resolve(server);
    const loopback = this.deps.surface === 'desktop' ? await loopbackCallback((params) => this.finishSignIn(params, null)) : undefined;
    if (!loopback && !starter.origin) throw new Error('This server doesn’t know the address to come back to.');
    const redirectUrl = loopback?.redirectUrl ?? `${starter.origin}${OAUTH_CALLBACK_PATH}`;
    const metadataUrl = !loopback && starter.origin?.startsWith('https:') ? `${starter.origin}${CLIENT_METADATA_PATH}` : undefined;
    const flow = new PendingSignIn(new URL(url), redirectUrl, metadataUrl, this.deps.fetch);
    try {
      const page = await flow.start();
      const timer = setTimeout(() => this.cancelSignIn(name), SIGN_IN_TIMEOUT_MS);
      timer.unref();
      this.signIns.set(name, { flow, userId: starter.userId, browser: starter.browser, timer, ...(loopback ? { close: loopback.close } : {}) });
      this.publish();
      return page.href;
    } catch (error) {
      loopback?.close();
      server.error = this.redact(server, `Signing in failed: ${errorMessage(error)}`).slice(0, 500);
      this.note(server, server.error, true);
      this.publish();
      throw new Error(server.error, { cause: error });
    }
  }

  cancelSignIn(name: string): void {
    const pending = this.signIns.get(name);
    if (!pending) return;
    this.signIns.delete(name);
    clearTimeout(pending.timer);
    pending.close?.();
    this.publish();
  }

  /**
   * Where the browser comes back to: `state` names the sign-in, once. Exchanges the code, keeps the credentials and
   * connects the server. `userId` is whose Atelier sign-in the request carries, if any. Returns why it failed, or null.
   */
  async finishSignIn(params: URLSearchParams, userId: string | null): Promise<string | null> {
    const [name, pending] = [...this.signIns].find(([, p]) => p.flow.id === params.get('state')) ?? [];
    if (!name || !pending) return 'This sign-in has expired or was used already. Start it again in Settings › Admin › Connectors.';
    this.cancelSignIn(name);
    if (userId ? userId !== pending.userId : pending.browser) return 'Finish signing in in the browser where you started it, signed in to Atelier as yourself.';
    const server = this.servers.get(name);
    try {
      await saveCredentials(this.deps.secrets, this.signInSecret(name), name, await pending.flow.finish(params));
    } catch (error) {
      const message = `Signing in failed: ${errorMessage(error)}`.slice(0, 500);
      if (server) {
        server.error = message;
        this.note(server, message, true);
        this.publish();
      }
      return message;
    }
    if (server && this.startable(server)) {
      server.needsSignIn = false;
      server.failures = 0;
      void this.connect(server);
    }
    return null;
  }

  /** Forgets an OAuth server's sign-in, also once the server is removed: it needs signing in again. */
  async signOut(name: string): Promise<void> {
    this.cancelSignIn(name);
    await this.servers.get(name)?.connecting;
    const server = this.servers.get(name);
    if (server) this.endAuth(server);
    await this.deps.secrets.delete(this.signInSecret(name));
    if (server?.config.auth && this.startable(server)) this.failed(server, SIGN_IN_NEEDED, true);
  }

  private signInSecret(name: string): string {
    return this.deps.signInSecret?.(name) ?? oauthSecretId(name);
  }

  private create(name: string, config: McpServerConfig): Server {
    const server: Server = {
      name,
      config,
      key: JSON.stringify(config),
      state: 'idle',
      client: null,
      tools: [],
      sse: false,
      connecting: null,
      failures: 0,
      secrets: [],
      auth: null,
      needsSignIn: false,
      calls: new Set(),
      closed: false,
    };
    if (!config.enabled) server.state = 'disabled';
    else if (!this.startable(server)) {
      server.state = 'error';
      server.error = 'This server runs a program on this machine (stdio), which only the desktop app does. Use its HTTP endpoint instead.';
    }
    return server;
  }

  private startable(server: Server): boolean {
    return server.config.enabled && (this.deps.startable?.(server.config) ?? (server.config.type !== 'stdio' || this.deps.surface === 'desktop'));
  }

  private ensure(server: Server): Promise<void> {
    return server.state === 'idle' ? this.connect(server) : (server.connecting ?? Promise.resolve());
  }

  /** Never rejects: a failure shows in the status and schedules a retry. */
  private connect(server: Server): Promise<void> {
    if (server.connecting) return server.connecting;
    clearTimeout(server.retry);
    server.state = 'connecting';
    this.publish();
    // Outside any call: what the connection sets up (pipes, streams) must not carry a call's context.
    const run = within.exit(() => this.open(server)).then(
      () => {
        if (server.closed || !server.client) return;
        server.state = 'ready';
        server.error = undefined;
        server.failures = 0;
        this.note(server, `Connected (${server.era ?? 'modern'} protocol${server.sse ? ', SSE' : ''}), ${server.tools.length} tools.`);
        this.publish();
      },
      (error: unknown) => this.failed(server, errorMessage(error), error instanceof SignInNeeded || !!server.auth?.signedOut),
    );
    server.connecting = run.finally(() => (server.connecting = null));
    return server.connecting;
  }

  private async open(server: Server): Promise<void> {
    const previous = server.client;
    server.client = null;
    this.endAuth(server);
    await previous?.close().catch(() => undefined);
    const resolved = await this.resolve(server);
    if (server.config.auth) server.auth = await this.storedSignIn(server, resolved.url);
    const client = await this.handshake(server, resolved);
    if (server.closed) {
      await client.close();
      return;
    }
    server.client = client;
    server.era = client.getProtocolEra();
    // A modern verdict isn't reused: connecting from one, the SDK opens no list_changed subscription.
    if (server.era === 'legacy') server.prior = { kind: 'legacy' };
    // A modern server announces list changes on a stream; when that ends unexpectedly, the server went away.
    void client.autoOpenedSubscription?.closed.then((how) => how === 'remote' && this.dropped(server, client, 'The server ended the connection.'));
    server.tools = (await client.listTools()).tools;
  }

  private async handshake(server: Server, resolved: Resolved): Promise<Client> {
    const { env, headers, url } = resolved;
    const { config } = server;
    const options = { timeout: CONNECT_TIMEOUT_MS, ...(server.prior ? { prior: server.prior } : {}) };
    const reached = await this.deps.reach?.({ name: server.name, config }, resolved, (line) => this.note(server, line));
    if (reached && 'transport' in reached) return connected(this.client(server, true), reached.transport, options);
    if (config.type === 'stdio') {
      const transport = new StdioClientTransport({ command: config.command!, args: config.args, env: { ...getDefaultEnvironment(), ...env }, stderr: 'pipe' });
      if (transport.stderr) createInterface({ input: transport.stderr as Readable }).on('line', (line) => this.note(server, line));
      return connected(this.client(server, true), transport, options);
    }
    const target = new URL(url);
    const fetchFn = reached?.fetch ?? this.deps.fetch;
    const init = { requestInit: { headers }, ...(fetchFn ? { fetch: fetchFn } : {}), ...(server.auth ? { authProvider: server.auth } : {}) };
    if (config.type === 'sse' || server.sse) return connected(this.client(server, false), new SSEClientTransport(target, init), { timeout: CONNECT_TIMEOUT_MS });
    try {
      return await connected(this.client(server, true), new StreamableHTTPClientTransport(target, init), options);
    } catch (error) {
      // A server from before Streamable HTTP refuses its POST with a 4xx and speaks HTTP+SSE at the same URL.
      if (!(error instanceof SdkHttpError) || error.status < 400 || error.status >= 500 || error.status === 401 || error.status === 403) throw error;
      const legacy = await connected(this.client(server, false), new SSEClientTransport(target, init), { timeout: CONNECT_TIMEOUT_MS }).catch(() => Promise.reject(error));
      server.sse = true;
      return legacy;
    }
  }

  /** `negotiate`: probe for the modern protocol first, falling back to `initialize` (legacy SSE has no probe). */
  private client(server: Server, negotiate: boolean): Client {
    const client = new Client(
      { name: APP.name, version: APP.version },
      {
        capabilities: { elicitation: { form: {}, url: {} } },
        ...(negotiate ? { versionNegotiation: { mode: 'auto' as const, probe: { timeoutMs: PROBE_TIMEOUT_MS } } } : {}),
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (server.client !== client) return;
              if (error) this.note(server, `Refreshing its tools failed: ${error.message}`, true);
              if (tools) server.tools = tools;
              this.publish();
            },
          },
        },
      },
    );
    client.setRequestHandler('elicitation/create', (request, ctx) => this.elicit(server, request.params, ctx.mcpReq.signal));
    client.onclose = () => this.dropped(server, client, 'The connection closed.');
    return client;
  }

  /** A live connection ended without being closed here. */
  private dropped(server: Server, client: Client, reason: string): void {
    if (server.client === client) this.failed(server, reason);
  }

  /**
   * A connect failed or a connection dropped: try again after 1s, 2s, 4s … up to 5 minutes. An OAuth server without
   * a usable sign-in (`signIn`) waits for an admin to sign in instead.
   */
  private failed(server: Server, reason: string, signIn = false): void {
    if (server.closed) return;
    const message = this.redact(server, reason).slice(0, 500);
    const client = server.client;
    server.client = null;
    void client?.close().catch(() => undefined);
    server.state = 'error';
    server.error = signIn ? undefined : message;
    server.needsSignIn = signIn;
    this.note(server, message, !signIn);
    clearTimeout(server.retry);
    if (!signIn) {
      server.failures++;
      server.retry = setTimeout(() => void this.connect(server), Math.min(1000 * 2 ** (server.failures - 1), MAX_RETRY_MS));
      server.retry.unref();
    }
    this.publish();
  }

  /** Keeps a line for Settings › Admin › Developer and passes it to the backend's log, credentials masked. */
  private note(server: Server, line: string, error = false): void {
    const text = this.redact(server, line);
    const kept = [...(this.logBook.get(server.name) ?? []), `${new Date().toISOString().slice(11, 19)} ${text}`];
    this.logBook.set(server.name, kept.slice(-KEEP_LOG_LINES));
    if (error) this.deps.logger.error(`MCP server ${server.name}: ${text}`);
    else this.deps.logger.info(`mcp ${server.name}: ${text}`);
  }

  private async shutdown(server: Server): Promise<void> {
    server.closed = true;
    clearTimeout(server.retry);
    this.cancelSignIn(server.name);
    this.endAuth(server);
    const client = server.client;
    server.client = null;
    await client?.close().catch(() => undefined);
  }

  /** The OAuth server's stored sign-in, for a new connection; none means it needs one. */
  private async storedSignIn(server: Server, url: string): Promise<StoredSignIn> {
    const id = this.signInSecret(server.name);
    const credentials = await loadCredentials(this.deps.secrets, id);
    if (!credentials) throw new SignInNeeded();
    return new StoredSignIn(this.deps.secrets, id, server.name, new URL(url), credentials, this.deps.fetch);
  }

  /** The connection that used the sign-in is gone: a refresh still finishing must not touch the stored one. */
  private endAuth(server: Server): void {
    if (server.auth) server.auth.closed = true;
  }

  /** The server's env, headers and URL with `${secret:…}` and `${ENV}` filled in; the values are kept for masking. */
  private async resolve(server: Server): Promise<Resolved> {
    const used: string[] = [];
    const missing: string[] = [];
    const keep = (value: string | undefined) => {
      if (value) used.push(value);
      return value;
    };
    const fill = async (value: string, deferEnv = false) => {
      const result = await interpolate(value, { secret: async (id) => keep(await this.deps.secret(id)), env: (name) => (deferEnv ? null : keep(this.deps.env[name])) });
      missing.push(...result.missing);
      return result.value;
    };
    const fillAll = async (record: Record<string, string>, deferEnv = false) =>
      Object.fromEntries(await Promise.all(Object.entries(record).map(async ([k, v]) => [k, await fill(v, deferEnv)] as const)));
    const env = await fillAll(server.config.env, this.deps.deferEnv && server.config.type === 'stdio');
    const headers = await fillAll(server.config.headers);
    const url = server.config.url ? await fill(server.config.url) : '';
    // Every env and header value is masked too, whole and word by word (`Bearer <token>`), literal or not.
    server.secrets = [...used, ...Object.values(env), ...Object.values(headers)]
      .flatMap((v) => [v, ...v.split(/\s+/)])
      .filter((v) => v.length >= MIN_SECRET_CHARS)
      .sort((a, b) => b.length - a.length);
    if (missing.length) throw new Error(`Missing ${missing.map((m) => (m.startsWith('secret:') ? `the secret "${m.slice(7)}"` : `the environment variable ${m}`)).join(', ')}.`);
    return { env, headers, url };
  }

  /** Masks the resolved credentials, and an OAuth server's current tokens. */
  private redact(server: Server, text: string): string {
    return [...(server.auth?.values ?? []), ...server.secrets].reduce((out, secret) => out.replaceAll(secret, '••••'), text);
  }

  private toolsOf(server: Server, seen: Set<string>): Tool[] {
    return server.tools.flatMap((tool) => {
      const name = mcpToolName(server.name, tool.name);
      if (server.config.disabledTools.includes(tool.name) || seen.has(name)) return [];
      seen.add(name);
      const description = tool.description ?? tool.title ?? '';
      return [
        {
          name,
          // Written by the server's publisher: it can't open or close Atelier's tags (prompts/escape.ts).
          description: escapeTags(description.length > MAX_DESCRIPTION_CHARS ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…` : description),
          inputSchema: tool.inputSchema as JsonSchema,
          // Lets read-only calls run in parallel; permissions never trust it (see `decide`).
          readOnly: tool.annotations?.readOnlyHint === true,
          run: (input: unknown, ctx: ToolContext) => this.call(server, tool.name, input, ctx),
        },
      ];
    });
  }

  private async call(server: Server, tool: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    // Reconnecting after a drop: the call can wait for it.
    if (!server.client) await server.connecting;
    const client = server.client;
    if (!client) return textOutput(`The ${server.name} connector is not connected${server.error ? `: ${server.error}` : '.'}`, true);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    ctx.signal.addEventListener('abort', cancel, { once: true });
    const limit = this.deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const call: Call = {
      sessionId: ctx.sessionId,
      callId: ctx.callId,
      signal: controller.signal,
      hold: () => clearTimeout(timer),
      release: () => {
        clearTimeout(timer);
        if (controller.signal.aborted) return;
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, limit);
      },
    };
    call.release();
    server.calls.add(call);
    try {
      const args = (input ?? {}) as Record<string, unknown>;
      const result = await within.run(call, () => client.callTool({ name: tool, arguments: args }, { signal: controller.signal, timeout: NO_SDK_TIMEOUT }));
      return await toOutput(result, this.deps.blobs, (text) => this.redact(server, text));
    } catch (error) {
      if (timedOut) return textOutput(`The tool did not finish within ${limit / 1000} seconds and was cancelled.`, true);
      if (ctx.signal.aborted) return textOutput('The call was cancelled.', true);
      if (server.auth?.signedOut && server.client === client) {
        this.failed(server, errorMessage(error), true);
        return textOutput(`The ${server.name} connector is signed out. An admin needs to sign in to it again in Settings › Admin › Connectors.`, true);
      }
      // The connection itself failed: replace it, so the next call finds a working one.
      if (error instanceof TypeError || error instanceof SdkHttpError || (error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed)) {
        this.dropped(server, client, errorMessage(error));
      }
      return textOutput(this.redact(server, errorMessage(error)), true);
    } finally {
      clearTimeout(timer);
      server.calls.delete(call);
      ctx.signal.removeEventListener('abort', cancel);
    }
  }

  /**
   * A server's question during a call goes to the person behind that call. Streamable HTTP delivers it within the
   * call's context; on other transports it can only belong to the server's one running call. Otherwise it is declined.
   */
  private async elicit(server: Server, params: ElicitRequest['params'], signal: AbortSignal): Promise<ElicitResult> {
    const inside = within.getStore();
    const call = inside && server.calls.has(inside) ? inside : server.calls.size === 1 ? [...server.calls][0]! : null;
    if (!call) return { action: 'decline' };
    const request: ElicitationRequest = { callId: call.callId, server: server.name, message: params.message, ...(params.mode === 'url' ? { url: params.url } : { requestedSchema: params.requestedSchema }) };
    call.hold();
    try {
      const answer = await this.deps.elicit(call.sessionId, request, AbortSignal.any([call.signal, signal]));
      return answer.action === 'accept' && params.mode !== 'url' ? { action: 'accept', content: answer.content ?? {} } : { action: answer.action };
    } finally {
      call.release();
    }
  }

  private publish(): void {
    this.emit('changed', this.statusList());
  }

  private statusList(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => this.statusOf(s));
  }

  private statusOf(server: Server): McpServerStatus {
    return {
      name: server.name,
      type: server.config.type,
      state: server.state === 'idle' ? 'connecting' : server.state,
      ...(server.state === 'error' && server.error ? { error: server.error } : {}),
      tools: server.tools.map((t) => ({ name: t.name, description: t.description ?? '', readOnly: t.annotations?.readOnlyHint === true, enabled: !server.config.disabledTools.includes(t.name) })),
      ...(server.era ? { protocolEra: server.era } : {}),
      ...(this.signIns.has(server.name) ? { signIn: 'waiting' as const } : server.needsSignIn ? { signIn: 'needed' as const } : {}),
    };
  }
}

/** A server's env, headers and URL with their references filled in. */
export interface Resolved {
  env: Record<string, string>;
  headers: Record<string, string>;
  url: string;
}

/** Connects, or closes what was started (a spawned server) and rethrows. */
async function connected(client: Client, transport: Transport, options: ConnectOptions): Promise<Client> {
  try {
    await client.connect(transport, options);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
