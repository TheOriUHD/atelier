/**
 * "Sign in with GitHub" for GitHub Copilot (docs/ARCHITECTURE.md §7): the models in the person's Copilot plan. It is
 * GitHub's OAuth device flow as Copilot's own editor plugins run it (the same public client): the person enters a short
 * code at github.com/login/device, so no redirect comes back to Atelier and it works on a server as well as the desktop.
 * The GitHub token it yields is the lasting secret; it is exchanged for short-lived Copilot tokens, which authorize the
 * requests to the Copilot API.
 *
 * Unofficial for anything but GitHub's own clients: the token exchange and the API are not documented for others.
 */
import { z } from 'zod';
import type { CopilotPort } from './types.ts';

export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const COPILOT_BASE_URL = 'https://api.githubcopilot.com';
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const USER_URL = 'https://api.github.com/user';
/** The editor Copilot's API expects to be talking to: it refuses clients it doesn't know. */
export const EDITOR_HEADERS = { 'editor-version': 'vscode/1.95.0', 'editor-plugin-version': 'copilot-chat/0.22.0', 'user-agent': 'GitHubCopilotChat/0.22.0' } as const;
const SCOPE = 'read:user';
const SECRET_ID = 'copilot-oauth';
/** A Copilot token is exchanged again when it has this little time left. */
const RENEW_MARGIN_MS = 5 * 60_000;
const DEFAULT_INTERVAL_S = 5;

/** No usable sign-in: nobody signed in, the GitHub token was revoked, or the account has no Copilot. */
export class CopilotSignedOut extends Error {
  constructor(message = 'Sign in with GitHub in Settings › Admin › Providers.') {
    super(message);
  }
}

const DeviceCode = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url({ protocol: /^https$/ }),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});

const AccessToken = z.object({
  access_token: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  interval: z.number().positive().optional(),
});

const CopilotToken = z.object({
  token: z.string().min(1),
  expires_at: z.number(),
  refresh_in: z.number().positive().optional(),
  endpoints: z.object({ api: z.url({ protocol: /^https$/ }).optional() }).optional(),
});

interface Stored {
  githubToken: string;
  login?: string;
}

interface Session {
  token: string;
  baseUrl: string;
  /** Exchanged again from this time on. */
  renewAt: number;
}

interface Flow {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface CopilotStatusValue {
  signedIn: boolean;
  signingIn: boolean;
  login?: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  error?: string;
}

export interface CopilotAuthDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  secrets: {
    get(id: string): Promise<string | undefined>;
    set(secret: { id: string; label: string; kind: 'token'; value: string }): Promise<unknown>;
    delete(id: string): Promise<unknown>;
  };
  /** Tests: the clock and the wait between polls. */
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

export class CopilotAuth implements CopilotPort {
  private stored: Stored | null | undefined;
  private session: Session | null = null;
  private exchanging: Promise<Session> | null = null;
  private signing: Flow | null = null;
  private failure: string | null = null;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: CopilotAuthDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? pause;
  }

  private async load(): Promise<Stored | null> {
    if (this.stored !== undefined) return this.stored;
    const raw = await this.deps.secrets.get(SECRET_ID);
    try {
      const parsed = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
      this.stored = typeof parsed?.githubToken === 'string' && parsed.githubToken ? { githubToken: parsed.githubToken, ...(typeof parsed.login === 'string' ? { login: parsed.login } : {}) } : null;
    } catch {
      this.stored = null;
    }
    return this.stored;
  }

  async status(): Promise<CopilotStatusValue> {
    const stored = await this.load();
    const flow = this.signing;
    return {
      signedIn: !!stored,
      signingIn: !!flow,
      ...(stored?.login ? { login: stored.login } : {}),
      ...(flow ? { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAt: flow.expiresAt } : {}),
      ...(this.failure ? { error: this.failure } : {}),
    };
  }

  /** Asks GitHub for a device code and polls for the token in the background; the result shows in `status`. */
  async signIn(): Promise<{ userCode: string; verificationUri: string; expiresAt: number }> {
    this.cancel();
    this.failure = null;
    const res = await this.deps.fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Atelier' },
      body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: SCOPE }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GitHub's sign-in answered ${res.status}.`);
    const parsed = DeviceCode.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error('GitHub returned no sign-in code.');
    const code = parsed.data;
    const flow: Flow = { userCode: code.user_code, verificationUri: code.verification_uri, expiresAt: this.now() + code.expires_in * 1000 };
    this.signing = flow;
    void this.poll(flow, code.device_code, (code.interval ?? DEFAULT_INTERVAL_S) * 1000);
    return { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAt: flow.expiresAt };
  }

  cancel(): void {
    this.signing = null;
  }

  private async poll(flow: Flow, deviceCode: string, startMs: number): Promise<void> {
    let intervalMs = startMs;
    try {
      for (;;) {
        await this.wait(intervalMs);
        if (this.signing !== flow) return;
        if (this.now() >= flow.expiresAt) throw new Error('The code expired before it was entered. Start the sign-in again.');
        let answer: z.infer<typeof AccessToken>;
        try {
          const res = await this.deps.fetch(ACCESS_TOKEN_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Atelier' },
            body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
            signal: AbortSignal.timeout(30_000),
          });
          answer = AccessToken.parse(await res.json());
        } catch {
          // A dropped connection or a garbled answer: the next poll asks again until the code expires.
          continue;
        }
        if (this.signing !== flow) return;
        if (answer.access_token) {
          const session = await this.exchange(answer.access_token);
          const login = await this.login(answer.access_token);
          if (this.signing !== flow) return;
          await this.save({ githubToken: answer.access_token, ...(login ? { login } : {}) });
          this.session = session;
          this.signing = null;
          return;
        }
        if (answer.error === 'authorization_pending') continue;
        if (answer.error === 'slow_down') {
          intervalMs = Math.max(intervalMs + 5000, (answer.interval ?? 0) * 1000);
          continue;
        }
        if (answer.error === 'expired_token') throw new Error('The code expired before it was entered. Start the sign-in again.');
        if (answer.error === 'access_denied') throw new Error('The sign-in was declined on GitHub.');
        throw new Error(`GitHub did not sign you in (${answer.error_description ?? answer.error ?? 'no token'}).`);
      }
    } catch (e) {
      if (this.signing !== flow) return;
      this.signing = null;
      this.failure = e instanceof Error ? e.message : 'The sign-in failed.';
    }
  }

  private async save(stored: Stored): Promise<void> {
    this.stored = stored;
    await this.deps.secrets.set({ id: SECRET_ID, label: 'GitHub Copilot sign-in', kind: 'token', value: JSON.stringify(stored) }).catch(() => undefined);
  }

  /** The account's name, to show who is signed in; nothing when GitHub doesn't say. */
  private async login(githubToken: string): Promise<string | undefined> {
    try {
      const res = await this.deps.fetch(USER_URL, {
        method: 'GET',
        headers: { authorization: `token ${githubToken}`, accept: 'application/vnd.github+json', 'user-agent': 'Atelier' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return void res.body?.cancel().catch(() => undefined);
      const login = z.object({ login: z.string().min(1) }).safeParse(await res.json());
      return login.success ? login.data.login : undefined;
    } catch {
      return undefined;
    }
  }

  /** A Copilot token for the GitHub token; fails with the status GitHub answered. */
  private async exchange(githubToken: string): Promise<Session> {
    const res = await this.deps.fetch(COPILOT_TOKEN_URL, {
      method: 'GET',
      headers: { authorization: `token ${githubToken}`, accept: 'application/json', ...EDITOR_HEADERS },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      const message =
        res.status === 401
          ? 'Your GitHub sign-in has expired or was revoked. Sign in again.'
          : res.status === 403 || res.status === 404
            ? 'This GitHub account has no active Copilot subscription.'
            : `GitHub's Copilot token service answered ${res.status}.`;
      throw Object.assign(new Error(message), { status: res.status });
    }
    const parsed = CopilotToken.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error('GitHub returned no Copilot token.');
    const { token, expires_at, refresh_in, endpoints } = parsed.data;
    const now = this.now();
    // `refresh_in` is relative, so a skewed clock can't make every request exchange again.
    const renewAt = refresh_in !== undefined ? now + refresh_in * 1000 : expires_at * 1000 - RENEW_MARGIN_MS;
    return { token, baseUrl: (endpoints?.api ?? COPILOT_BASE_URL).replace(/\/+$/, ''), renewAt: Math.max(renewAt, now + 60_000) };
  }

  async credentials(options: { force?: boolean } = {}): Promise<{ token: string; baseUrl: string }> {
    const stored = await this.load();
    if (!stored) throw new CopilotSignedOut(this.failure ?? undefined);
    if (!options.force && this.session && this.now() < this.session.renewAt) return { token: this.session.token, baseUrl: this.session.baseUrl };
    // One exchange at a time: requests that arrive meanwhile share it.
    this.exchanging ??= this.exchange(stored.githubToken)
      .then((session) => {
        this.session = session;
        this.failure = null;
        return session;
      })
      .catch(async (e: unknown) => {
        const status = (e as { status?: number }).status;
        if (status === 401) {
          this.stored = null;
          this.session = null;
          await this.deps.secrets.delete(SECRET_ID).catch(() => undefined);
        }
        if (status === 401 || status === 403 || status === 404) {
          this.failure = (e as Error).message;
          throw new CopilotSignedOut(this.failure);
        }
        throw e;
      })
      .finally(() => {
        this.exchanging = null;
      });
    const session = await this.exchanging;
    return { token: session.token, baseUrl: session.baseUrl };
  }

  async signOut(): Promise<void> {
    this.cancel();
    this.stored = null;
    this.session = null;
    this.failure = null;
    await this.deps.secrets.delete(SECRET_ID).catch(() => undefined);
  }
}
