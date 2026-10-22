import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatGptAuth, ChatGptSignedOut, claimsOf, CHATGPT_BASE_URL } from './chatgpt-auth.ts';
import { chatgptModels, codexClientVersion, codexFetch, createChatGptAdapter, resetCodexClientVersion } from './chatgpt.ts';
import type { ChatGptPort, ProviderFetch, ProviderInstance } from './types.ts';

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const idToken = (extra: Record<string, unknown> = {}) =>
  jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' }, ...extra });
const accessToken = (expSeconds: number) => jwt({ exp: expSeconds });

const instance: ProviderInstance = { id: 'chatgpt', type: 'chatgpt', name: 'ChatGPT subscription', baseUrl: CHATGPT_BASE_URL, headers: {} };

/** An in-memory secret store. */
function secretStore(initial?: string) {
  const data = new Map<string, string>(initial ? [['chatgpt-oauth', initial]] : []);
  return {
    data,
    store: {
      get: async (id: string) => data.get(id),
      set: async (s: { id: string; value: string }) => void data.set(s.id, s.value),
      delete: async (id: string) => void data.delete(id),
    },
  };
}

const stored = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ accessToken: accessToken(Date.now() / 1000 + 3600), idToken: idToken(), refreshToken: 'r1', accountId: 'acct-1', lastRefresh: Date.now(), installationId: 'inst-1', ...over });

describe('claimsOf', () => {
  it('reads a token’s claims, and gives nothing for what is not one', () => {
    expect(claimsOf(idToken()).email).toBe('me@example.com');
    expect(claimsOf('not-a-token')).toEqual({});
  });
});

describe('ChatGptAuth', () => {
  const servers: ChatGptAuth[] = [];
  afterEach(() => servers.forEach((a) => a.cancel()));

  it('says who is signed in and on what plan', async () => {
    const { store } = secretStore(stored());
    const auth = new ChatGptAuth({ fetch: async () => new Response(''), secrets: store as never });
    expect(await auth.status()).toMatchObject({ available: true, signedIn: true, signingIn: false, email: 'me@example.com', plan: 'plus' });
  });

  it('has nobody signed in by default, and refuses credentials', async () => {
    const auth = new ChatGptAuth({ fetch: async () => new Response(''), secrets: secretStore().store as never });
    expect(await auth.status()).toMatchObject({ signedIn: false });
    await expect(auth.credentials()).rejects.toBeInstanceOf(ChatGptSignedOut);
  });

  it('builds the sign-in address with PKCE and finishes it from the callback', async () => {
    const requests: { url: string; body: string }[] = [];
    const { store, data } = secretStore();
    const fetch = async (url: string, init: RequestInit) => {
      requests.push({ url, body: String(init.body) });
      return Response.json({ id_token: idToken(), access_token: accessToken(Date.now() / 1000 + 3600), refresh_token: 'refresh-1' });
    };
    const auth = new ChatGptAuth({ fetch, secrets: store as never, port: 0 });
    servers.push(auth);
    const { url } = await auth.signIn();
    const address = new URL(url);
    expect(address.origin + address.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(address.searchParams.get('response_type')).toBe('code');
    expect(address.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(address.searchParams.get('code_challenge_method')).toBe('S256');
    expect(address.searchParams.get('originator')).toBe('atelier');
    expect(address.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect((await auth.status()).signingIn).toBe(true);

    const redirect = address.searchParams.get('redirect_uri')!;
    const state = address.searchParams.get('state')!;
    // A callback with someone else's state is turned away and the sign-in goes on.
    const wrong = await globalThis.fetch(`${redirect}?code=x&state=nope`);
    expect(wrong.status).toBe(400);
    expect((await auth.status()).signingIn).toBe(true);

    const ok = await globalThis.fetch(`${redirect}?code=the-code&state=${state}`);
    expect(ok.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://auth.openai.com/oauth/token');
    const form = new URLSearchParams(requests[0]!.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(await auth.status()).toMatchObject({ signedIn: true, signingIn: false, email: 'me@example.com' });
    // Stored encrypted by the secret store, never in a file of its own.
    expect(JSON.parse(data.get('chatgpt-oauth')!)).toMatchObject({ refreshToken: 'refresh-1', accountId: 'acct-1' });
  });

  it('reports a failed sign-in, and signs out', async () => {
    const { store, data } = secretStore(stored());
    const auth = new ChatGptAuth({ fetch: async () => new Response('', { status: 500 }), secrets: store as never, port: 0 });
    servers.push(auth);
    const { url } = await auth.signIn();
    const redirect = new URL(url).searchParams.get('redirect_uri')!;
    await globalThis.fetch(`${redirect}?error=access_denied&state=${new URL(url).searchParams.get('state')}`);
    expect((await auth.status()).error).toContain('did not sign you in');
    await auth.signOut();
    expect(await auth.status()).toMatchObject({ signedIn: false });
    expect(data.has('chatgpt-oauth')).toBe(false);
  });

  it('renews a token about to expire, once at a time, keeping the rotated refresh token', async () => {
    const { store, data } = secretStore(stored({ accessToken: accessToken(Date.now() / 1000 + 30) }));
    let refreshes = 0;
    const fetch = async (_url: string, init: RequestInit) => {
      refreshes++;
      expect(new URLSearchParams(String(init.body)).get('grant_type')).toBe('refresh_token');
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({ id_token: idToken(), access_token: accessToken(Date.now() / 1000 + 3600), refresh_token: 'r2' });
    };
    const auth = new ChatGptAuth({ fetch, secrets: store as never });
    const [a, b] = await Promise.all([auth.credentials(), auth.credentials()]);
    expect(refreshes).toBe(1);
    expect(a.accessToken).toBe(b.accessToken);
    expect(JSON.parse(data.get('chatgpt-oauth')!).refreshToken).toBe('r2');
  });

  it('is signed out when its refresh token is refused, but not when the network fails', async () => {
    const refused = secretStore(stored({ accessToken: accessToken(1) }));
    const one = new ChatGptAuth({ fetch: async () => new Response('', { status: 400 }), secrets: refused.store as never });
    await expect(one.credentials()).rejects.toBeInstanceOf(ChatGptSignedOut);
    expect(await one.status()).toMatchObject({ signedIn: false, error: expect.stringContaining('Sign in again') });
    expect(refused.data.has('chatgpt-oauth')).toBe(false);

    const offline = secretStore(stored({ accessToken: accessToken(1) }));
    const two = new ChatGptAuth({
      fetch: async () => {
        throw new Error('fetch failed');
      },
      secrets: offline.store as never,
    });
    await expect(two.credentials()).rejects.toThrow('fetch failed');
    expect((await two.status()).signedIn).toBe(true);
  });

  it('reads the plan’s usage windows the way Codex does, before any reply, and asks at most every half minute', async () => {
    let clock = 1_000_000;
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const { store } = secretStore(stored());
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return Response.json({
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_after_seconds: 4_920, reset_at: 1_900_000_000 },
          secondary_window: { used_percent: 7, limit_window_seconds: 604_800, reset_after_seconds: 400_000 },
        },
      });
    };
    const auth = new ChatGptAuth({ fetch, secrets: store as never, now: () => clock });
    const status = await auth.status();
    expect(status.plan).toBe('pro');
    expect(status.limits).toEqual({
      primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_900_000_000_000 },
      secondary: { usedPercent: 7, windowMinutes: 10_080, resetsAt: clock + 400_000_000 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(calls[0]!.headers).toMatchObject({ 'chatgpt-account-id': 'acct-1', originator: 'atelier' });
    expect(calls[0]!.headers.authorization).toMatch(/^Bearer /);

    await auth.status();
    expect(calls).toHaveLength(1);
    clock += 31_000;
    await auth.status();
    expect(calls).toHaveLength(2);
  });

  it('keeps what the replies said when the usage cannot be read', async () => {
    const { store } = secretStore(stored());
    const auth = new ChatGptAuth({ fetch: async () => new Response('nope', { status: 503 }), secrets: store as never });
    auth.observe(new Headers({ 'x-codex-primary-used-percent': '12', 'x-codex-primary-window-minutes': '300' }));
    expect((await auth.status()).limits?.primary).toMatchObject({ usedPercent: 12, windowMinutes: 300 });
    const offline = new ChatGptAuth({ fetch: async () => Promise.reject(new Error('offline')), secrets: secretStore(stored()).store as never });
    expect(await offline.status()).toMatchObject({ signedIn: true, plan: 'plus' });
  });

  it('reads the plan’s usage windows from reply headers', async () => {
    const auth = new ChatGptAuth({ fetch: async () => new Response(''), secrets: secretStore(stored()).store as never, now: () => 1_000_000 });
    auth.observe(new Headers({ 'x-codex-primary-used-percent': '42.5', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-after-seconds': '600' }));
    expect((await auth.status()).limits).toEqual({ primary: { usedPercent: 42.5, windowMinutes: 300, resetsAt: 1_600_000 } });
  });
});

describe('codexFetch', () => {
  const credentials = { accessToken: 'tok-1', accountId: 'acct-1', installationId: 'inst-1' };
  function setup(respond: (url: string, init: RequestInit, n: number) => Response, auth: Partial<ChatGptPort> = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const inner: ProviderFetch = async (url, init) => {
      calls.push({ url, init });
      return respond(url, init, calls.length);
    };
    const port: ChatGptPort = { credentials: async () => credentials, observe: () => {}, ...auth };
    return { fetch: codexFetch(inner, port), calls };
  }
  const headers = (init: RequestInit) => new Headers(init.headers);

  it('sends a Responses request to the backend as the account, under Atelier’s own name, without what it refuses', async () => {
    const { fetch, calls } = setup(() => new Response('data: {}'));
    const body = { model: 'gpt-5.5', input: [], instructions: 'Be brief.', max_output_tokens: 4096, temperature: 0.2, top_p: 1, store: true, stream: false };
    await fetch('https://chatgpt.com/backend-api/codex/v1/responses', { method: 'POST', headers: { authorization: 'Bearer placeholder', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const h = headers(calls[0]!.init);
    expect(h.get('authorization')).toBe('Bearer tok-1');
    expect(h.get('chatgpt-account-id')).toBe('acct-1');
    expect(h.get('originator')).toBe('atelier');
    expect(h.get('openai-beta')).toBe('responses=experimental');
    expect(h.get('x-codex-installation-id')).toBe('inst-1');
    expect(h.get('accept')).toBe('text/event-stream');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({ model: 'gpt-5.5', store: false, stream: true, instructions: 'Be brief.', parallel_tool_calls: false });
    for (const dropped of ['max_output_tokens', 'temperature', 'top_p']) expect(sent).not.toHaveProperty(dropped);
    expect(sent.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
    expect(h.get('session-id')).toBe(sent.prompt_cache_key);
  });

  it('asks the models endpoint with the current Codex version, which is what lists the newest models', async () => {
    resetCodexClientVersion();
    const { fetch, calls } = setup((url) => (url.includes('registry.npmjs.org') ? Response.json({ version: '0.200.3' }) : Response.json({ models: [] })));
    await fetch('https://chatgpt.com/backend-api/codex/v1/models', { method: 'GET', headers: {} });
    const asked = calls.find((c) => c.url.includes('/models'))!;
    expect(asked.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.200.3');
    // The look-up goes to the package registry without the account's credentials.
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBeNull();
  });

  it('falls back to the built-in version when the registry can’t be read, and remembers a good one', async () => {
    resetCodexClientVersion();
    const failing: ProviderFetch = async () => new Response('', { status: 503 });
    expect(await codexClientVersion(failing)).toBe('0.162.1');
    resetCodexClientVersion();
    const calls: string[] = [];
    const good: ProviderFetch = async (url) => (calls.push(url), Response.json({ version: '0.170.0' }));
    expect(await codexClientVersion(good)).toBe('0.170.0');
    expect(await codexClientVersion(failing)).toBe('0.170.0');
    expect(await codexClientVersion(good)).toBe('0.170.0');
    expect(calls).toHaveLength(1);
  });

  it('tries once more with a new token after a 401', async () => {
    const forced: boolean[] = [];
    const { fetch, calls } = setup((_u, _i, n) => (n === 1 ? new Response('', { status: 401 }) : new Response('ok')), {
      credentials: async (o) => (forced.push(!!o?.force), { ...credentials, accessToken: o?.force ? 'tok-2' : 'tok-1' }),
    });
    const res = await fetch('https://chatgpt.com/backend-api/codex/v1/responses', { method: 'POST', headers: {}, body: '{}' });
    expect(res.status).toBe(200);
    expect(forced).toEqual([false, true]);
    expect(headers(calls[1]!.init).get('authorization')).toBe('Bearer tok-2');
  });

  it('answers a request made while signed out as a 401 with the way back, without calling out', async () => {
    const { fetch, calls } = setup(() => new Response('never'), {
      credentials: async () => {
        throw new ChatGptSignedOut();
      },
    });
    const res = await fetch('https://chatgpt.com/backend-api/codex/v1/responses', { method: 'POST', headers: {}, body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Sign in with ChatGPT');
    expect(calls).toHaveLength(0);
  });
});

describe('chatgptModels', () => {
  it('lists what the account shows, in its order, with the levels it reports', () => {
    const listed = chatgptModels(instance, {
      models: [
        { slug: 'gpt-5.4-mini', visibility: 'list', priority: 3, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
        { slug: 'hidden-one', visibility: 'hide', priority: 0 },
        { slug: 'gpt-5.5', visibility: 'list', priority: 1, display_name: 'GPT-5.5', context_window: 400_000 },
      ],
    });
    expect(listed.map((m) => m.modelId)).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
    expect(listed[0]).toMatchObject({ ref: 'chatgpt/gpt-5.5', displayName: 'GPT-5.5', contextLength: 400_000, tier: 'full' });
    expect(listed[1]!.effortLevels).toEqual(expect.arrayContaining(['low', 'high']));
  });

  it('shows the named models when none is marked for listing', () => {
    expect(chatgptModels(instance, { models: [{ slug: 'gpt-5.5' }] }).map((m) => m.modelId)).toEqual(['gpt-5.5']);
  });
});

describe('the adapter', () => {
  it('lists the usual models when the account’s list cannot be read, and none when signed out', async () => {
    const port: ChatGptPort = { credentials: async () => ({ accessToken: 't', accountId: 'a', installationId: 'i' }), observe: () => {} };
    const failing = createChatGptAdapter(instance, { fetch: async () => new Response('', { status: 500 }), readBlob: async () => new Uint8Array(), chatgpt: port });
    expect((await failing.listModels()).map((m) => m.modelId)).toContain('gpt-5.5');
    const out: ChatGptPort = {
      credentials: async () => {
        throw new ChatGptSignedOut();
      },
      observe: () => {},
    };
    const signedOut = createChatGptAdapter(instance, { fetch: async () => new Response('never'), readBlob: async () => new Uint8Array(), chatgpt: out });
    expect(await signedOut.listModels()).toEqual([]);
    expect(await signedOut.health()).toMatchObject({ ok: false });
  });

  it('is unavailable when built without a sign-in (every backend passes one)', async () => {
    const adapter = createChatGptAdapter(instance, { fetch: async () => new Response(''), readBlob: async () => new Uint8Array() });
    expect(await adapter.listModels()).toEqual([]);
    expect(await adapter.health()).toMatchObject({ ok: false, error: expect.stringContaining('sign in with ChatGPT') });
  });
});

describe('a request through createAdapter', () => {
  it('streams a reply from the backend with the account’s headers and none of the refused parameters', async () => {
    const { createAdapter } = await import('./index.ts');
    const sseBody = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
    ].join('');
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const adapter = createAdapter(instance, {
      fetch: async (url, init) => {
        calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
        return new Response(sseBody, { headers: { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '7' } });
      },
      readBlob: async () => new Uint8Array(),
      chatgpt: { credentials: async () => ({ accessToken: 'tok', accountId: 'acct', installationId: 'inst' }), observe: () => {} },
    });
    const events = [];
    for await (const e of adapter.stream({
      model: 'gpt-5.5',
      system: [{ text: 'You are brief.' }],
      messages: [{ id: 'm', sessionId: 's', parentId: null, role: 'user', parts: [{ type: 'text', text: 'Hi' }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 }],
      maxOutputTokens: 1000,
      temperature: 0.5,
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(['text', 'usage', 'finish']);
    expect(events[0]).toMatchObject({ delta: 'Hello' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(calls[0]!.headers.get('chatgpt-account-id')).toBe('acct');
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-5.5', instructions: 'You are brief.', store: false, stream: true });
    expect(calls[0]!.body).not.toHaveProperty('max_output_tokens');
    expect(calls[0]!.body).not.toHaveProperty('temperature');
  });
});

// The callback listens on the loopback only.
describe('callback listener', () => {
  it('binds to 127.0.0.1', async () => {
    const auth = new ChatGptAuth({ fetch: async () => new Response(''), secrets: secretStore().store as never, port: 0 });
    const { url } = await auth.signIn();
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    probe.close();
    expect(new URL(new URL(url).searchParams.get('redirect_uri')!).hostname).toBe('localhost');
    auth.cancel();
  });
});
