/**
 * "Connect with OpenRouter" (docs/ARCHITECTURE.md §7): OpenRouter's OAuth PKCE flow for apps, which mints a key in the
 * person's account (openrouter.ai/docs/guides/overview/auth/oauth). The browser comes back to the desktop's loopback
 * listener, or to the web server's `/oauth/callback` (the connectors' own, told apart by `state`). The code is
 * exchanged here and the drafted provider saved with the key, which the registry keeps in the secret store.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ProviderConfig, ProviderDraft } from '@atelier/protocol';
import { loopbackCallback, OAUTH_CALLBACK_PATH } from '../mcp/oauth.ts';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
/** OpenRouter's codes expire after ten minutes. */
const CONNECT_MS = 10 * 60_000;

const KeyAnswer = z.object({ key: z.string().min(1) });
const ErrorAnswer = z.object({ error: z.object({ message: z.string() }) });

export interface OpenRouterStatusValue {
  connecting: boolean;
  provider?: ProviderConfig;
  error?: string;
}

export interface OpenRouterConnectDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** The desktop's own backend listens on loopback; a server sends the browser back to its own address. */
  surface: 'desktop' | 'web';
  /** Saves the provider with its key (ProviderRegistry.save). */
  save(draft: ProviderDraft): Promise<ProviderConfig>;
}

export interface ConnectStarter {
  userId: string;
  /** Started in a browser: the callback must carry the same person's cookie. */
  browser: boolean;
  /** Web: the origin the client reached this server at. */
  origin?: string | undefined;
}

interface Pending {
  state: string;
  verifier: string;
  draft: Omit<ProviderDraft, 'apiKey' | 'apiKeyFromEnv'>;
  userId: string;
  browser: boolean;
  timer: NodeJS.Timeout;
  close?: () => void;
}

const base64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

export class OpenRouterConnect {
  private pending: Pending | null = null;
  private provider: ProviderConfig | undefined;
  private failure: string | undefined;

  constructor(private readonly deps: OpenRouterConnectDeps) {}

  status(): OpenRouterStatusValue {
    return { connecting: !!this.pending, ...(this.provider ? { provider: this.provider } : {}), ...(this.failure ? { error: this.failure } : {}) };
  }

  /**
   * Whether the shared `/oauth/callback` hands a callback here: its `state` is this flow's, or it has none while this
   * flow waits (OpenRouter sends none back when the person declines; connectors' sign-ins always carry one).
   */
  owns(params: URLSearchParams): boolean {
    const state = params.get('state');
    return !!this.pending && (state ? this.pending.state === state : !params.get('code'));
  }

  /** Returns the page to open; the outcome shows in `status`. */
  async start(draft: Omit<ProviderDraft, 'apiKey' | 'apiKeyFromEnv'>, starter: ConnectStarter): Promise<string> {
    this.cancel();
    this.provider = undefined;
    this.failure = undefined;
    const state = randomBytes(24).toString('base64url');
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const loopback = this.deps.surface === 'desktop' ? await loopbackCallback((params) => this.finish(params, null, true)) : undefined;
    if (!loopback && !starter.origin) throw new Error('This server doesn’t know the address to come back to.');
    const callback = loopback?.redirectUrl ?? `${starter.origin}${OAUTH_CALLBACK_PATH}`;
    const timer = setTimeout(() => this.end('Connecting timed out. Start it again.'), CONNECT_MS);
    timer.unref();
    this.pending = { state, verifier, draft, userId: starter.userId, browser: starter.browser, timer, ...(loopback ? { close: loopback.close } : {}) };
    const url = new URL(OPENROUTER_AUTH_URL);
    url.search = new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256', key_label: 'Atelier', state }).toString();
    return url.href;
  }

  cancel(): void {
    if (this.pending) this.end(undefined);
  }

  private end(failure: string | undefined): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.close?.();
    }
    this.failure = failure;
  }

  /**
   * Where the browser comes back to. `userId` is whose Atelier sign-in the request carries, if any; `loopback` is the
   * desktop's own listener, only this flow's. Returns why it failed, or null.
   */
  async finish(params: URLSearchParams, userId: string | null, loopback = false): Promise<string | null> {
    const pending = this.pending;
    const code = params.get('code');
    if (pending && !code && !params.get('state')) {
      const declined = 'OpenRouter didn’t connect: access was declined.';
      // Anyone can open the web server's callback: there, a refusal doesn't end the flow, cancelling in Atelier does.
      if (loopback) this.end(declined);
      return declined;
    }
    if (!pending || params.get('state') !== pending.state || !code) return 'This connection has expired or was used already. Start it again in Settings › Admin › Providers.';
    if (userId ? userId !== pending.userId : pending.browser) return 'Finish connecting in the browser where you started it, signed in to Atelier as yourself.';
    this.end(undefined);
    try {
      const key = await this.exchange(code, pending.verifier);
      this.provider = await this.deps.save({ ...pending.draft, apiKey: key });
      return null;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : 'Connecting to OpenRouter failed.';
      return this.failure;
    }
  }

  private async exchange(code: string, verifier: string): Promise<string> {
    const res = await this.deps.fetch(OPENROUTER_KEYS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.timeout(30_000),
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const said = ErrorAnswer.safeParse(body);
      throw new Error(`OpenRouter refused the connection (${res.status}${said.success ? `: ${said.data.error.message}` : ''}).`);
    }
    const answer = KeyAnswer.safeParse(body);
    if (!answer.success) throw new Error('OpenRouter answered without a key.');
    return answer.data.key;
  }
}
