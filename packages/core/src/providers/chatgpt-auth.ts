/**
 * "Sign in with ChatGPT" (docs/ARCHITECTURE.md §7): the plan's models through the sign-in OpenAI's Codex uses. It is
 * the browser OAuth flow with PKCE that `codex login` runs (the same public client, its callback on localhost:1455),
 * and the tokens it yields authorize requests to the ChatGPT backend's Responses endpoint, billed to the plan.
 *
 * Unofficial for anything but Codex: OpenAI documents the sign-in for its own tools, not as an API. Nothing here reads
 * Codex's own `~/.codex/auth.json`: refresh tokens are single-use, so two programs sharing one login would sign each
 * other out. Atelier signs in on its own, keeps its tokens encrypted in the secret store, and sends only what an
 * OpenAI client sends, under its own name.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { ChatGptPort } from './types.ts';

export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
/** The redirect address the public client is registered with. */
export const CALLBACK_PORT = 1455;
const SCOPE = 'openid profile email offline_access';
const SECRET_ID = 'chatgpt-oauth';
const SIGN_IN_MS = 5 * 60_000;
const DEVICE_SIGN_IN_MS = 15 * 60_000;
const AUTH_REQUEST_MS = 30_000;
const DEVICE_URL = `${CHATGPT_ISSUER}/codex/device`;

interface DeviceSignIn {
  controller: AbortController;
  timer: NodeJS.Timeout;
  device?: { url: string; userCode: string };
}
/** A token is renewed when it has this little time left. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** When a token carries no expiry: renewed after this long. */
const RENEW_AFTER_MS = 55 * 60_000;

export class ChatGptSignedOut extends Error {
  constructor(message = 'Sign in with ChatGPT in Settings › Admin › Providers.') {
    super(message);
  }
}

interface Stored {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  accountId: string;
  lastRefresh: number;
  /** Sent with every request, as Codex does: one per installation. */
  installationId: string;
}

export interface ChatGptLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface ChatGptStatusValue {
  available: true;
  signedIn: boolean;
  signingIn: boolean;
  device?: { url: string; userCode: string };
  email?: string;
  plan?: string;
  error?: string;
  limits?: { primary?: ChatGptLimitWindow; secondary?: ChatGptLimitWindow };
}

export interface ChatGptAuthDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  secrets: {
    get(id: string): Promise<string | undefined>;
    set(secret: { id: string; label: string; kind: 'token'; value: string }): Promise<unknown>;
    delete(id: string): Promise<unknown>;
  };
  /** Tests: the callback port (0 picks a free one) and the clock. */
  port?: number;
  now?: () => number;
}

/** The claims of a JWT, without checking its signature: they say who the token is for, not whether to trust it. */
export function claimsOf(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const accountOf = (idToken: string) => record(claimsOf(idToken)['https://api.openai.com/auth']);

const base64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:6rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p>`;

/** Where the plan's usage windows are read, as Codex's own status does (its backend client's `wham/usage`). */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/** The usage is asked for at most this often, however often the status is. */
const USAGE_TTL_MS = 30_000;

const numeric = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

/**
 * The windows in the usage answer: `rate_limit.primary_window` and `secondary_window`, each with `used_percent`,
 * `limit_window_seconds` and either `reset_at` (Unix seconds) or `reset_after_seconds`. Anything missing is left out.
 */
export function usageWindows(json: unknown, now: number): { limits?: ChatGptStatusValue['limits']; plan?: string } {
  const body = record(json);
  const rate = record(body.rate_limit);
  const window = (value: unknown): ChatGptLimitWindow | undefined => {
    const w = record(value);
    const used = numeric(w.used_percent);
    if (used === undefined) return undefined;
    const seconds = numeric(w.limit_window_seconds);
    const at = numeric(w.reset_at);
    const after = numeric(w.reset_after_seconds);
    return {
      usedPercent: used,
      windowMinutes: seconds !== undefined && seconds > 0 ? Math.round(seconds / 60) : null,
      // A timestamp in seconds (or already in milliseconds), else how long from now.
      resetsAt:
        at !== undefined && at > 0 ? (at < 1e11 ? at * 1000 : at) : after !== undefined ? now + after * 1000 : null,
    };
  };
  const primary = window(rate.primary_window);
  const secondary = window(rate.secondary_window);
  const plan = text(body.plan_type);
  return {
    ...(primary || secondary
      ? { limits: { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) } }
      : {}),
    ...(plan ? { plan } : {}),
  };
}

export class ChatGptAuth implements ChatGptPort {
  private tokens: Stored | null | undefined;
  /** The plan as the usage answer names it: newer than the one in the sign-in's token after a change of plan. */
  private usagePlan: string | undefined;
  private usageTriedAt = 0;
  private reading: Promise<void> | null = null;
  private refreshing: Promise<Stored> | null = null;
  private signing: { server: Server; timer: NodeJS.Timeout } | null = null;
  private deviceSigning: DeviceSignIn | null = null;
  private failure: string | null = null;
  private limits: ChatGptStatusValue['limits'];
  private readonly now: () => number;

  constructor(private readonly deps: ChatGptAuthDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async load(): Promise<Stored | null> {
    if (this.tokens !== undefined) return this.tokens;
    const raw = await this.deps.secrets.get(SECRET_ID);
    try {
      const parsed = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
      this.tokens =
        parsed?.accessToken && parsed.refreshToken && parsed.accountId
          ? ({ idToken: '', lastRefresh: 0, installationId: randomUUID(), ...parsed } as Stored)
          : null;
    } catch {
      this.tokens = null;
    }
    return this.tokens;
  }

  private async save(tokens: Stored): Promise<void> {
    this.tokens = tokens;
    // A refresh token is good once: it is stored before it is used, and kept in memory if storing fails.
    await this.deps.secrets
      .set({ id: SECRET_ID, label: 'ChatGPT sign-in', kind: 'token', value: JSON.stringify(tokens) })
      .catch(() => undefined);
  }

  /**
   * Asks the account's usage the way Codex does for its own status, so the windows are known before the first reply
   * and between replies. Never fails the status: without an answer, what the replies' headers said stays.
   */
  private async readUsage(): Promise<void> {
    this.usageTriedAt = this.now();
    try {
      const { accessToken, accountId } = await this.credentials();
      const res = await this.deps.fetch(CHATGPT_USAGE_URL, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
          originator: 'atelier',
          accept: 'application/json',
          'user-agent': 'Atelier',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return void res.body?.cancel().catch(() => undefined);
      const { limits, plan } = usageWindows(await res.json(), this.now());
      if (limits) this.limits = limits;
      if (plan) this.usagePlan = plan;
    } catch {
      // Offline, signed out or a changed answer: the status is what it was.
    }
  }

  async status(): Promise<ChatGptStatusValue> {
    const tokens = await this.load();
    if (tokens && this.now() - this.usageTriedAt > USAGE_TTL_MS)
      await (this.reading ??= this.readUsage().finally(() => void (this.reading = null)));
    const claims = tokens ? claimsOf(tokens.idToken) : {};
    const plan = tokens ? (this.usagePlan ?? text(accountOf(tokens.idToken).chatgpt_plan_type)) : undefined;
    return {
      available: true,
      signedIn: !!tokens,
      signingIn: !!this.signing || !!this.deviceSigning,
      ...(this.deviceSigning?.device ? { device: { ...this.deviceSigning.device } } : {}),
      ...(tokens && text(claims.email) ? { email: text(claims.email)! } : {}),
      ...(plan ? { plan } : {}),
      ...(this.failure ? { error: this.failure } : {}),
      ...(this.limits ? { limits: this.limits } : {}),
    };
  }

  /** Opens the callback and returns the address the person signs in at; the result shows in `status`. */
  async signIn(): Promise<{ url: string }> {
    this.cancel();
    this.failure = null;
    const verifier = base64url(randomBytes(64));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = randomBytes(32).toString('hex');
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) =>
        reject(
          new Error(
            e.code === 'EADDRINUSE'
              ? `Port ${this.deps.port ?? CALLBACK_PORT} is in use, probably by another sign-in (is the Codex CLI signing in?). Finish or close it and try again.`
              : e.message,
          ),
        ),
      );
      server.listen(this.deps.port ?? CALLBACK_PORT, '127.0.0.1', () =>
        resolve((server.address() as { port: number }).port),
      );
    });
    const redirect = `http://localhost:${port}/auth/callback`;
    const timer = setTimeout(() => this.finish(server, 'The sign-in timed out. Start it again.'), SIGN_IN_MS);
    timer.unref();
    this.signing = { server, timer };

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const reply = (status: number, title: string, body: string) =>
        res
          .writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(page(title, body));
      if (url.pathname !== '/auth/callback') return void res.writeHead(404).end();
      if (url.searchParams.get('state') !== state)
        return reply(
          400,
          'Not this sign-in',
          'That link is not from the sign-in Atelier started. Close this tab and start it again in Atelier.',
        );
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        reply(400, 'Not signed in', 'ChatGPT did not complete the sign-in. You can close this tab.');
        return this.finish(
          server,
          `ChatGPT did not sign you in (${url.searchParams.get('error_description') ?? error ?? 'no code'}).`,
        );
      }
      this.exchange(code, redirect, verifier)
        .then(async (tokens) => {
          await this.save(tokens);
          reply(200, 'You are signed in', 'You can close this tab and go back to Atelier.');
          this.finish(server, null);
        })
        .catch((e: unknown) => {
          reply(500, 'Not signed in', 'Atelier could not finish the sign-in. You can close this tab.');
          this.finish(server, e instanceof Error ? e.message : 'The sign-in failed.');
        });
    });

    const authorize = new URL('/oauth/authorize', CHATGPT_ISSUER);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: CHATGPT_CLIENT_ID,
      redirect_uri: redirect,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state,
      originator: 'atelier',
    }).toString();
    return { url: authorize.href };
  }

  /** Headless sign-in: return the code promptly, then complete it in the background. */
  async signInDevice(): Promise<{ url: string; userCode: string }> {
    this.cancel();
    this.failure = null;
    const controller = new AbortController();
    const attempt: DeviceSignIn = {
      controller,
      timer: setTimeout(
        () => this.finishDevice(attempt, 'The device sign-in timed out after 15 minutes. Start it again.'),
        DEVICE_SIGN_IN_MS,
      ),
    };
    attempt.timer.unref();
    this.deviceSigning = attempt;
    try {
      const body = record(await this.deviceRequest('/usercode', { client_id: CHATGPT_CLIENT_ID }, controller.signal));
      this.checkDevice(attempt);
      const id = text(body.device_auth_id);
      const userCode = text(body.user_code) ?? text(body.usercode);
      // Codex accepts an absent interval as zero; avoid an unbounded busy loop by waiting at least one second.
      const interval =
        body.interval === undefined
          ? 0
          : typeof body.interval === 'string' && /^\d+$/.test(body.interval.trim())
            ? Number(body.interval)
            : NaN;
      if (!id?.trim() || !userCode?.trim() || !Number.isSafeInteger(interval) || interval < 0)
        throw new Error('Invalid device response.');
      const device = { url: DEVICE_URL, userCode };
      attempt.device = device;
      void this.pollDevice(attempt, id, userCode, Math.max(1, Math.min(interval, DEVICE_SIGN_IN_MS / 1000)) * 1000);
      return { ...device };
    } catch {
      const message = 'ChatGPT could not start device sign-in. Try again.';
      if (this.deviceSigning === attempt) this.finishDevice(attempt, message);
      throw new Error(controller.signal.aborted ? (this.failure ?? 'The device sign-in was cancelled.') : message);
    }
  }

  private checkDevice(attempt: DeviceSignIn): void {
    if (this.deviceSigning !== attempt || attempt.controller.signal.aborted) throw new Error('Device sign-in ended.');
  }

  private finishDevice(attempt: DeviceSignIn, failure: string | null): void {
    if (this.deviceSigning !== attempt) return;
    this.deviceSigning = null;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    this.failure = failure;
  }

  /** Bound the entire operation (including reading JSON), even if a transport ignores abort. */
  private async authRequest<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), AUTH_REQUEST_MS);
    timer.unref();
    const bounded = AbortSignal.any([signal, timeout.signal]);
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          abort = () => reject(new Error('ChatGPT sign-in request ended.'));
          bounded.addEventListener('abort', abort, { once: true });
        }),
        operation(bounded),
      ]);
    } finally {
      clearTimeout(timer);
      bounded.removeEventListener('abort', abort);
    }
  }

  private deviceRequest(path: string, body: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    return this.authRequest(signal, async (bounded) => {
      const res = await this.deps.fetch(`${CHATGPT_ISSUER}/api/accounts/deviceauth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: bounded,
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        if (path === '/token' && (res.status === 403 || res.status === 404)) return undefined;
        throw new Error(`ChatGPT device sign-in answered ${res.status}.`);
      }
      return res.json();
    });
  }

  private async pollDevice(attempt: DeviceSignIn, id: string, userCode: string, interval: number): Promise<void> {
    try {
      for (;;) {
        this.checkDevice(attempt);
        const result = await this.deviceRequest(
          '/token',
          { device_auth_id: id, user_code: userCode },
          attempt.controller.signal,
        );
        this.checkDevice(attempt);
        if (result !== undefined) {
          const body = record(result);
          const code = text(body.authorization_code);
          const verifier = text(body.code_verifier);
          const challenge = text(body.code_challenge);
          if (!code?.trim() || !verifier?.trim() || !challenge?.trim()) throw new Error('Invalid device response.');
          const tokens = await this.exchange(
            code,
            `${CHATGPT_ISSUER}/deviceauth/callback`,
            verifier,
            attempt.controller.signal,
          );
          this.checkDevice(attempt);
          await this.save(tokens);
          this.finishDevice(attempt, null);
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const signal = attempt.controller.signal;
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('Device sign-in ended.'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          }, interval);
          timer.unref();
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    } catch {
      // Never surface upstream bodies or exception messages: they can contain authorization codes or tokens.
      this.finishDevice(attempt, 'ChatGPT could not complete device sign-in. Start it again.');
    }
  }

  cancel(): void {
    if (this.signing) this.finish(this.signing.server, null);
    if (this.deviceSigning) this.finishDevice(this.deviceSigning, null);
  }

  dispose(): void {
    this.cancel();
  }

  private finish(server: Server, failure: string | null): void {
    if (this.signing?.server === server) {
      clearTimeout(this.signing.timer);
      this.signing = null;
    }
    this.failure = failure;
    // The page that was just answered is still being written: it ends its own connection, and anything left is cut.
    server.close();
    setTimeout(() => server.closeAllConnections(), 1000).unref();
  }

  async signOut(): Promise<void> {
    this.cancel();
    this.tokens = null;
    this.failure = null;
    this.limits = undefined;
    this.usagePlan = undefined;
    this.usageTriedAt = 0;
    await this.deps.secrets.delete(SECRET_ID).catch(() => undefined);
  }

  private async token(
    body: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ id_token?: string; access_token?: string; refresh_token?: string }> {
    const res = await this.deps.fetch(`${CHATGPT_ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw Object.assign(new Error(`ChatGPT's sign-in answered ${res.status}.`), { status: res.status });
    return (await res.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
  }

  private async exchange(code: string, redirect: string, verifier: string, signal?: AbortSignal): Promise<Stored> {
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: CHATGPT_CLIENT_ID,
      code_verifier: verifier,
    };
    const out = signal
      ? await this.authRequest(signal, (bounded) => this.token(body, bounded))
      : await this.token(body);
    if (signal && (!text(out?.access_token) || !text(out?.refresh_token) || !text(out?.id_token)))
      throw new Error('ChatGPT sign-in returned invalid tokens.');
    const accountId = out.id_token ? text(accountOf(out.id_token).chatgpt_account_id) : undefined;
    if (!out.access_token || !out.refresh_token || !out.id_token)
      throw new Error('ChatGPT sign-in returned no tokens.');
    if (!accountId) throw new Error('This ChatGPT account has no plan to sign in with.');
    const previous = await this.load();
    return {
      accessToken: out.access_token,
      idToken: out.id_token,
      refreshToken: out.refresh_token,
      accountId,
      lastRefresh: this.now(),
      installationId: previous?.installationId ?? randomUUID(),
    };
  }

  private stale(tokens: Stored): boolean {
    const exp = claimsOf(tokens.accessToken).exp;
    if (typeof exp === 'number') return exp * 1000 - this.now() < RENEW_MARGIN_MS;
    return this.now() - tokens.lastRefresh >= RENEW_AFTER_MS;
  }

  private refresh(current: Stored): Promise<Stored> {
    // One at a time: a second refresh with the same single-use token would be refused.
    this.refreshing ??= (async () => {
      try {
        const out = await this.token({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: CHATGPT_CLIENT_ID,
        });
        if (!out.access_token) throw new Error('ChatGPT sign-in returned no access token.');
        const next: Stored = {
          ...current,
          accessToken: out.access_token,
          idToken: out.id_token ?? current.idToken,
          refreshToken: out.refresh_token || current.refreshToken,
          accountId: (out.id_token && text(accountOf(out.id_token).chatgpt_account_id)) || current.accountId,
          lastRefresh: this.now(),
        };
        await this.save(next);
        this.failure = null;
        return next;
      } catch (e) {
        const status = (e as { status?: number }).status;
        // A refused refresh token won't work again: signing in is the only way back. A network error says nothing.
        if (status === 400 || status === 401 || status === 403) {
          this.tokens = null;
          this.failure = 'Your ChatGPT sign-in has expired or was revoked. Sign in again.';
          await this.deps.secrets.delete(SECRET_ID).catch(() => undefined);
          throw new ChatGptSignedOut(this.failure);
        }
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async credentials(
    options: { force?: boolean } = {},
  ): Promise<{ accessToken: string; accountId: string; installationId: string }> {
    let tokens = await this.load();
    if (!tokens) throw new ChatGptSignedOut(this.failure ?? undefined);
    if (options.force || this.stale(tokens)) tokens = await (this.refreshing ?? this.refresh(tokens));
    return { accessToken: tokens.accessToken, accountId: tokens.accountId, installationId: tokens.installationId };
  }

  observe(headers: Headers): void {
    const window = (name: 'primary' | 'secondary'): ChatGptLimitWindow | undefined => {
      const used = Number(headers.get(`x-codex-${name}-used-percent`));
      if (!headers.get(`x-codex-${name}-used-percent`) || Number.isNaN(used)) return undefined;
      const minutes = Number(headers.get(`x-codex-${name}-window-minutes`));
      const after = Number(headers.get(`x-codex-${name}-reset-after-seconds`));
      return {
        usedPercent: used,
        windowMinutes: headers.get(`x-codex-${name}-window-minutes`) && !Number.isNaN(minutes) ? minutes : null,
        resetsAt:
          headers.get(`x-codex-${name}-reset-after-seconds`) && !Number.isNaN(after) ? this.now() + after * 1000 : null,
      };
    };
    const primary = window('primary');
    const secondary = window('secondary');
    if (primary || secondary) this.limits = { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
  }
}
