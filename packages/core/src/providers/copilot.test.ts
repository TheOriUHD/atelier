import { describe, expect, it } from 'vitest';
import type { Message, Part } from '@atelier/protocol';
import { ACCESS_TOKEN_URL, COPILOT_TOKEN_URL, CopilotAuth, CopilotSignedOut, DEVICE_CODE_URL } from './copilot-auth.ts';
import { autoTier, copilotFetch, copilotModels, createCopilotAdapter, requestHeaders } from './copilot.ts';
import type { CopilotPort, ProviderFetch, ProviderInstance } from './types.ts';

const instance: ProviderInstance = { id: 'copilot', type: 'copilot', name: 'GitHub Copilot', baseUrl: 'https://api.githubcopilot.com', headers: {} };

function secretStore(initial?: string) {
  const data = new Map<string, string>(initial ? [['copilot-oauth', initial]] : []);
  return {
    data,
    store: {
      get: async (id: string) => data.get(id),
      set: async (s: { id: string; value: string }) => void data.set(s.id, s.value),
      delete: async (id: string) => void data.delete(id),
    },
  };
}

const deviceCode = { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
const copilotToken = (expiresAt: number, extra: Record<string, unknown> = {}) => ({ token: `cop-${expiresAt}`, expires_at: expiresAt, endpoints: { api: 'https://api.individual.githubcopilot.com' }, ...extra });

/** Resolves once `check` holds, giving the background poll its turns. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out');
}

describe('CopilotAuth', () => {
  it('signs in with the device flow: waits while pending, slows down when told, then stores the GitHub token', async () => {
    const waits: number[] = [];
    const calls: { url: string; init: RequestInit }[] = [];
    const answers = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { error: 'authorization_pending' }, { access_token: 'gho_secret' }];
    const { store, data } = secretStore();
    const now = 1_000_000;
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === DEVICE_CODE_URL) return Response.json(deviceCode);
      if (url === ACCESS_TOKEN_URL) return Response.json(answers.shift());
      if (url === COPILOT_TOKEN_URL) return Response.json(copilotToken(now / 1000 + 1800));
      return Response.json({ login: 'octocat' });
    };
    const auth = new CopilotAuth({ fetch, secrets: store as never, now: () => now, wait: async (ms) => void waits.push(ms) });
    expect(await auth.signIn()).toEqual({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: now + 900_000 });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ client_id: 'Iv1.b507a08c87ecfe98', scope: 'read:user' });
    expect(new Headers(calls[0]!.init.headers).get('accept')).toBe('application/json');

    await until(async () => (await auth.status()).signedIn);
    expect(await auth.status()).toEqual({ signedIn: true, signingIn: false, login: 'octocat' });
    // The interval as given, then 5 s more after slow_down (or what GitHub names, if longer), kept from then on.
    expect(waits).toEqual([5000, 5000, 10_000, 10_000]);
    const poll = calls.find((c) => c.url === ACCESS_TOKEN_URL)!;
    expect(JSON.parse(String(poll.init.body))).toEqual({ client_id: 'Iv1.b507a08c87ecfe98', device_code: 'dev-1', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    expect(JSON.parse(data.get('copilot-oauth')!)).toEqual({ githubToken: 'gho_secret', login: 'octocat' });
    const exchange = new Headers(calls.find((c) => c.url === COPILOT_TOKEN_URL)!.init.headers);
    expect(exchange.get('authorization')).toBe('token gho_secret');
    expect(exchange.get('editor-version')).toBe('vscode/1.95.0');
    expect(exchange.get('editor-plugin-version')).toBe('copilot-chat/0.22.0');
    expect(exchange.get('user-agent')).toBe('GitHubCopilotChat/0.22.0');
  });

  it('shows the code while it waits, and can be cancelled', async () => {
    let release = () => {};
    const auth = new CopilotAuth({
      fetch: async (url) => (url === DEVICE_CODE_URL ? Response.json(deviceCode) : Response.json({ error: 'authorization_pending' })),
      secrets: secretStore().store as never,
      wait: () => new Promise((resolve) => (release = resolve)),
    });
    await auth.signIn();
    expect(await auth.status()).toMatchObject({ signedIn: false, signingIn: true, userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    auth.cancel();
    release();
    expect(await auth.status()).toEqual({ signedIn: false, signingIn: false });
  });

  it.each([
    ['access_denied', 'declined'],
    ['expired_token', 'expired'],
  ])('reports %s', async (error, words) => {
    const auth = new CopilotAuth({
      fetch: async (url) => (url === DEVICE_CODE_URL ? Response.json(deviceCode) : Response.json({ error })),
      secrets: secretStore().store as never,
      wait: async () => {},
    });
    await auth.signIn();
    await until(async () => !(await auth.status()).signingIn);
    expect((await auth.status()).error).toContain(words);
  });

  it('refuses an account without Copilot, keeping nothing', async () => {
    const { store, data } = secretStore();
    const auth = new CopilotAuth({
      fetch: async (url) =>
        url === DEVICE_CODE_URL ? Response.json(deviceCode) : url === ACCESS_TOKEN_URL ? Response.json({ access_token: 'gho_x' }) : new Response('', { status: 404 }),
      secrets: store as never,
      wait: async () => {},
    });
    await auth.signIn();
    await until(async () => !(await auth.status()).signingIn);
    expect(await auth.status()).toMatchObject({ signedIn: false, error: 'This GitHub account has no active Copilot subscription.' });
    expect(data.size).toBe(0);
  });

  it('rejects a garbled device-code answer at the boundary', async () => {
    const auth = new CopilotAuth({ fetch: async () => Response.json({ user_code: 'X', verification_uri: 'javascript:alert(1)' }), secrets: secretStore().store as never });
    await expect(auth.signIn()).rejects.toThrow('no sign-in code');
  });

  it('caches the Copilot token and exchanges it again shortly before it expires, once at a time', async () => {
    let now = 1_000_000_000;
    let exchanges = 0;
    const auth = new CopilotAuth({
      fetch: async (url, init) => {
        expect(url).toBe(COPILOT_TOKEN_URL);
        expect(new Headers(init.headers).get('authorization')).toBe('token gho_stored');
        exchanges++;
        return Response.json(copilotToken(now / 1000 + 1800));
      },
      secrets: secretStore(JSON.stringify({ githubToken: 'gho_stored' })).store as never,
      now: () => now,
    });
    const [a, b] = await Promise.all([auth.credentials(), auth.credentials()]);
    expect(a).toEqual({ token: `cop-${now / 1000 + 1800}`, baseUrl: 'https://api.individual.githubcopilot.com' });
    expect(b).toEqual(a);
    expect(exchanges).toBe(1);
    now += 20 * 60_000;
    expect(await auth.credentials()).toEqual(a);
    expect(exchanges).toBe(1);
    // Five minutes before it expires it is exchanged again.
    now += 6 * 60_000;
    expect((await auth.credentials()).token).not.toBe(a.token);
    expect(exchanges).toBe(2);
    await auth.credentials({ force: true });
    expect(exchanges).toBe(3);
  });

  it('is signed out when GitHub revokes the token, but not when the network fails', async () => {
    let answer: () => Response = () => {
      throw new TypeError('fetch failed');
    };
    const { store, data } = secretStore(JSON.stringify({ githubToken: 'gho_stored' }));
    const auth = new CopilotAuth({ fetch: async () => answer(), secrets: store as never });
    await expect(auth.credentials()).rejects.toThrow('fetch failed');
    expect((await auth.status()).signedIn).toBe(true);
    answer = () => new Response('', { status: 401 });
    await expect(auth.credentials()).rejects.toBeInstanceOf(CopilotSignedOut);
    expect(await auth.status()).toMatchObject({ signedIn: false, error: expect.stringContaining('Sign in again') });
    expect(data.size).toBe(0);
  });

  it('signs out', async () => {
    const { store, data } = secretStore(JSON.stringify({ githubToken: 'gho_stored', login: 'octocat' }));
    const auth = new CopilotAuth({ fetch: async () => new Response(''), secrets: store as never });
    expect(await auth.status()).toMatchObject({ signedIn: true, login: 'octocat' });
    await auth.signOut();
    expect(await auth.status()).toEqual({ signedIn: false, signingIn: false });
    expect(data.size).toBe(0);
    await expect(auth.credentials()).rejects.toBeInstanceOf(CopilotSignedOut);
  });
});

const message = (role: 'user' | 'assistant', parts: Part[]): Message => ({ id: 'm', sessionId: 's', parentId: null, role, parts, model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 });

describe('copilotFetch', () => {
  const port: CopilotPort = { credentials: async (o) => ({ token: o?.force ? 'cop-2' : 'cop-1', baseUrl: 'https://api.business.githubcopilot.com' }) };
  function setup(respond: (n: number) => Response, auth: CopilotPort = port) {
    const calls: { url: string; headers: Headers }[] = [];
    const inner: ProviderFetch = async (url, init) => (calls.push({ url, headers: new Headers(init.headers) }), respond(calls.length));
    return { fetch: copilotFetch(inner, auth), calls };
  }

  it('sends to the account’s API address as the editor Copilot expects', async () => {
    const { fetch, calls } = setup(() => new Response('ok'));
    await fetch('https://api.githubcopilot.com/chat/completions', { method: 'POST', headers: { 'x-initiator': 'user' }, body: '{}' });
    await fetch('https://api.githubcopilot.com/v1/responses', { method: 'POST', headers: {}, body: '{}' });
    expect(calls.map((c) => c.url)).toEqual(['https://api.business.githubcopilot.com/chat/completions', 'https://api.business.githubcopilot.com/responses']);
    const h = calls[0]!.headers;
    expect(h.get('authorization')).toBe('Bearer cop-1');
    expect(h.get('copilot-integration-id')).toBe('vscode-chat');
    expect(h.get('x-github-api-version')).toBe('2025-05-01');
    expect(h.get('editor-version')).toBe('vscode/1.95.0');
    expect(h.get('editor-plugin-version')).toBe('copilot-chat/0.22.0');
    expect(h.get('x-initiator')).toBe('user');
  });

  it('tries once more with a new token after a 401', async () => {
    const { fetch, calls } = setup((n) => (n === 1 ? new Response('', { status: 401 }) : new Response('ok')));
    expect((await fetch('https://api.githubcopilot.com/models', { method: 'GET', headers: {} })).status).toBe(200);
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer cop-2');
  });

  it('answers a request made while signed out as a 401 with the way back, without calling out', async () => {
    const { fetch, calls } = setup(() => new Response('never'), {
      credentials: async () => {
        throw new CopilotSignedOut();
      },
    });
    const res = await fetch('https://api.githubcopilot.com/chat/completions', { method: 'POST', headers: {}, body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Sign in with GitHub');
    expect(calls).toHaveLength(0);
  });
});

describe('requestHeaders', () => {
  const own = { priority: 'foreground' as const, owner: 's' };
  it('marks only the person’s own turn as theirs', () => {
    expect(requestHeaders({ messages: [message('user', [{ type: 'text', text: 'Hi' }])], queue: own })).toEqual({ 'openai-intent': 'conversation-edits', 'x-initiator': 'user' });
    const results = message('user', [{ type: 'tool_result', callId: 'c', content: [{ type: 'text', text: 'ok' }], isError: false }]);
    expect(requestHeaders({ messages: [results], queue: own })['x-initiator']).toBe('agent');
    expect(requestHeaders({ messages: [message('user', [{ type: 'text', text: 'Hi' }])], queue: { priority: 'subagent', owner: 's' } })['x-initiator']).toBe('agent');
    expect(requestHeaders({ messages: [message('user', [{ type: 'text', text: 'Title this' }])], queue: { priority: 'urgent', owner: 's' } })['x-initiator']).toBe('agent');
    // A summary or a helper's question has no conversation of its own.
    expect(requestHeaders({ messages: [message('user', [{ type: 'text', text: 'Summarize' }])], queue: { priority: 'foreground' } })['x-initiator']).toBe('agent');
  });

  it('says when images go along, also inside tool results', () => {
    const image = { type: 'image' as const, blob: 'abc', mime: 'image/png' };
    expect(requestHeaders({ messages: [message('user', [image])] })['copilot-vision-request']).toBe('true');
    const result = message('user', [{ type: 'tool_result', callId: 'c', content: [image], isError: false }]);
    expect(requestHeaders({ messages: [result] })['copilot-vision-request']).toBe('true');
    expect(requestHeaders({ messages: [message('user', [{ type: 'text', text: 'Hi' }])] })).not.toHaveProperty('copilot-vision-request');
  });
});

const model = (id: string, over: Record<string, unknown> = {}, supports: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  model_picker_enabled: true,
  capabilities: { family: id, limits: { max_context_window_tokens: 200_000, max_output_tokens: 32_000, max_prompt_tokens: 128_000 }, supports: { tool_calls: true, streaming: true, vision: true, ...supports } },
  ...over,
});

describe('copilotModels', () => {
  it('keeps the picker’s models with tool calls that an endpoint Atelier speaks reaches', () => {
    const { models, endpoints } = copilotModels(instance, {
      data: [
        model('claude-sonnet-4.5', { supported_endpoints: ['/chat/completions', '/v1/messages'] }),
        model('gpt-5-codex', { supported_endpoints: ['/responses'] }, { reasoning_effort: ['low', 'medium', 'high', 'bogus'] }),
        model('claude-messages-only', { supported_endpoints: ['/v1/messages'] }),
        model('hidden', { model_picker_enabled: false }),
        model('disabled', { policy: { state: 'disabled' } }),
        model('no-tools', {}, { tool_calls: false }),
        model('gpt-4.1'),
        model('gpt-4.1'),
        { id: 42 },
      ],
    });
    expect(models.map((m) => m.modelId)).toEqual(['claude-sonnet-4.5', 'gpt-5-codex', 'gpt-4.1', 'auto']);
    expect([...endpoints]).toEqual([
      ['claude-sonnet-4.5', 'chat'],
      ['gpt-5-codex', 'responses'],
      ['hidden', 'chat'],
      ['gpt-4.1', 'chat'],
    ]);
    expect(models[0]).toMatchObject({ ref: 'copilot/claude-sonnet-4.5', displayName: 'CLAUDE-SONNET-4.5', contextLength: 160_000, maxOutput: 32_000, tier: 'full' });
    expect(models[0]!.capabilities).toMatchObject({ tools: 'native', vision: true, reasoning: 'none' });
    expect(models[1]).toMatchObject({ effortLevels: ['low', 'medium', 'high'], capabilities: expect.objectContaining({ reasoning: 'effort' }) });
  });

  it('lists Auto last on a full plan, fitted to the router’s pool', () => {
    const { models } = copilotModels(instance, {
      data: [
        model('claude-opus-4.5', { billing: { auto_discount: 0.1 } }),
        model('gpt-5-mini', { billing: { auto_discount: 0.1 }, capabilities: { limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 }, supports: { tool_calls: true } } }),
        model('gpt-5.5', { capabilities: { limits: { max_context_window_tokens: 32_000, max_output_tokens: 4_000 }, supports: { tool_calls: true } } }),
      ],
    });
    expect(models.map((m) => m.modelId)).toEqual(['claude-opus-4.5', 'gpt-5-mini', 'gpt-5.5', 'auto']);
    expect(models.at(-1)).toMatchObject({
      ref: 'copilot/auto',
      displayName: 'Copilot Auto',
      contextLength: 128_000,
      maxOutput: 16_000,
      effortLevels: ['low', 'medium', 'high'],
      capabilities: expect.objectContaining({ reasoning: 'effort', vision: true, tools: 'native' }),
    });
  });

  it('on an Auto-only plan (Free, Student) lists Auto first, then what the policy enables, and keeps the rest reachable', () => {
    // As GET /models answers such plans: model_picker_enabled is false on every model.
    const hidden = { model_picker_enabled: false };
    const { models, endpoints, fallback } = copilotModels(instance, {
      data: [
        model('gpt-4.1', { ...hidden, is_chat_fallback: true, policy: { state: 'enabled' }, billing: { auto_discount: 0.1 } }),
        model('gpt-5-mini', { ...hidden, policy: { state: 'enabled' }, billing: { auto_discount: 0.1 } }),
        model('claude-haiku-4.5', { ...hidden, billing: { auto_discount: 0.1 } }),
        model('claude-opus-4.5', { ...hidden, policy: { state: 'disabled' } }),
        model('gpt-5.6-terra', { ...hidden, policy: { state: 'unconfigured' }, supported_endpoints: ['/responses'] }),
      ],
    });
    expect(models.map((m) => m.modelId)).toEqual(['auto', 'gpt-4.1', 'gpt-5-mini']);
    expect(models[0]).toMatchObject({ displayName: 'Copilot Auto', effortLevels: ['low', 'medium', 'high'] });
    expect([...endpoints.keys()]).toEqual(['gpt-4.1', 'gpt-5-mini', 'claude-haiku-4.5', 'gpt-5.6-terra']);
    expect(fallback).toBe('gpt-4.1');
  });

  it('maps effort to the router’s tier as VS Code names them', () => {
    expect([autoTier('low'), autoTier('medium'), autoTier(null), autoTier('high'), autoTier('xhigh')]).toEqual(['efficiency', 'balance', 'balance', 'intelligence', 'intelligence']);
  });

  it('lists nothing from an answer that isn’t a model list', () => {
    expect(copilotModels(instance, { models: [] }).models).toEqual([]);
    expect(copilotModels(instance, null).models).toEqual([]);
  });
});

describe('the adapter', () => {
  const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

  it('streams a chat completion with the turn’s headers, and a Responses-only model through /responses', async () => {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const adapter = createCopilotAdapter(instance, {
      fetch: async (url, init) => {
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, headers: new Headers(init.headers), body });
        if (url.endsWith('/models')) return Response.json({ data: [model('gpt-4.1'), model('gpt-5-codex', { supported_endpoints: ['/responses'] })] });
        if (url.endsWith('/responses'))
          return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Yo"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        return sse([{ choices: [{ delta: { content: 'Hello' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }]);
      },
      readBlob: async () => new Uint8Array(),
      copilot: { credentials: async () => ({ token: 'cop', baseUrl: 'https://api.githubcopilot.com' }) },
    });
    const request = (modelId: string) => ({
      model: modelId,
      system: [{ text: 'Be brief.' }],
      messages: [message('user', [{ type: 'text', text: 'Hi' }])],
      maxOutputTokens: 1000,
      signal: new AbortController().signal,
      queue: { priority: 'foreground' as const, owner: 's' },
    });
    const events = [];
    for await (const e of adapter.stream(request('gpt-4.1'))) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['text', 'usage', 'finish']);
    const chat = calls.find((c) => c.url.endsWith('/chat/completions'))!;
    expect(chat.url).toBe('https://api.githubcopilot.com/chat/completions');
    expect(chat.headers.get('authorization')).toBe('Bearer cop');
    expect(chat.headers.get('x-initiator')).toBe('user');
    expect(chat.headers.get('openai-intent')).toBe('conversation-edits');
    expect(chat.body).toMatchObject({ model: 'gpt-4.1', stream: true });

    const second = [];
    for await (const e of adapter.stream(request('gpt-5-codex'))) second.push(e);
    expect(second.map((e) => e.type)).toEqual(['text', 'usage', 'finish']);
    expect(calls.at(-1)!.url).toBe('https://api.githubcopilot.com/responses');
    expect(calls.filter((c) => c.url.endsWith('/models'))).toHaveLength(1);
  });

  describe('Copilot Auto', () => {
    const studentModels = (withFallback = true) => ({
      data: [
        model('gpt-4.1', { model_picker_enabled: false, is_chat_fallback: withFallback, policy: { state: 'enabled' } }),
        model('claude-haiku-4.5', { model_picker_enabled: false, billing: { auto_discount: 0.1 } }, { reasoning_effort: ['low', 'medium', 'high'] }),
        model('gpt-5.6-luna', { model_picker_enabled: false, supported_endpoints: ['/responses'], billing: { auto_discount: 0.1 } }),
      ],
    });
    function setup(auto: (body: Record<string, unknown>) => Response, withFallback = true) {
      const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
      const adapter = createCopilotAdapter(instance, {
        fetch: async (url, init) => {
          const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
          calls.push({ url, headers: new Headers(init.headers), body });
          if (new Headers(init.headers).get('x-github-api-version') !== '2025-05-01') {
            return new Response('bad request: error: invalid apiVersion', { status: 404 });
          }
          if (url.endsWith('/models')) return Response.json(studentModels(withFallback));
          if (url.endsWith('/auto')) return auto(body);
          if (url.endsWith('/responses'))
            return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
          return sse([{ choices: [{ delta: { content: 'Hi' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }]);
        },
        readBlob: async () => new Uint8Array(),
        copilot: { credentials: async () => ({ token: 'cop', baseUrl: 'https://api.individual.githubcopilot.com' }) },
      });
      return { adapter, calls };
    }
    const ask = (effort: 'low' | 'medium' | 'high' | null, owner = 's1', text = 'Fix the failing test') => ({
      model: 'auto',
      system: [{ text: 'Be brief.' }],
      messages: [message('user', [{ type: 'text', text }])],
      maxOutputTokens: 1000,
      effort,
      signal: new AbortController().signal,
      queue: { priority: 'foreground' as const, owner },
    });
    const run = async (adapter: ReturnType<typeof createCopilotAdapter>, request: ReturnType<typeof ask>) => {
      const events = [];
      for await (const e of adapter.stream(request)) events.push(e);
      return events;
    };
    const chosen = (id: string, extra: Record<string, unknown> = {}) => Response.json({ session_token: `st-${id}`, expires_at: Date.now() / 1000 + 86_400, selected_model: { id, ...extra } });

    it('asks the router with the prompt and the tier, then sends the chosen model the session token and no effort of its own', async () => {
      const { adapter, calls } = setup(() => chosen('claude-haiku-4.5'));
      expect((await run(adapter, ask('high'))).map((e) => e.type)).toEqual(['text', 'usage', 'finish']);
      const auto = calls.find((c) => c.url.endsWith('/auto'))!;
      expect(auto.url).toBe('https://api.individual.githubcopilot.com/auto');
      expect(auto.body).toEqual({ prompt: 'Fix the failing test', tier: 'intelligence' });
      expect(auto.headers.get('authorization')).toBe('Bearer cop');
      const chat = calls.find((c) => c.url.endsWith('/chat/completions'))!;
      expect(chat.body).toMatchObject({ model: 'claude-haiku-4.5', stream: true });
      expect(chat.body).not.toHaveProperty('reasoning_effort');
      expect(chat.headers.get('copilot-session-token')).toBe('st-claude-haiku-4.5');
      expect(chat.headers.get('x-initiator')).toBe('user');
    });

    it('routes a conversation once per tier, and every conversation on its own', async () => {
      const { adapter, calls } = setup((body) => chosen(body.tier === 'efficiency' ? 'gpt-4.1' : 'claude-haiku-4.5'));
      await run(adapter, ask(null));
      await run(adapter, ask('medium', 's1', 'And the next one'));
      expect(calls.filter((c) => c.url.endsWith('/auto')).map((c) => c.body.tier)).toEqual(['balance']);
      await run(adapter, ask('low'));
      await run(adapter, ask(null, 's2'));
      expect(calls.filter((c) => c.url.endsWith('/auto')).map((c) => c.body.tier)).toEqual(['balance', 'efficiency', 'balance']);
      expect(calls.filter((c) => c.url.endsWith('/chat/completions')).map((c) => c.body.model)).toEqual(['claude-haiku-4.5', 'claude-haiku-4.5', 'gpt-4.1', 'claude-haiku-4.5']);
    });

    it('reaches a chosen model that only takes /responses there', async () => {
      const { adapter, calls } = setup(() => chosen('gpt-5.6-luna'));
      expect((await run(adapter, ask('low'))).at(-1)).toMatchObject({ type: 'finish', reason: 'end' });
      const responses = calls.find((c) => c.url.endsWith('/responses'))!;
      expect(responses.body).toMatchObject({ model: 'gpt-5.6-luna' });
      expect(responses.body).not.toHaveProperty('reasoning');
      expect(responses.headers.get('copilot-session-token')).toBe('st-gpt-5.6-luna');
    });

    it('falls back to the plan’s fallback model without a token when the router fails', async () => {
      const { adapter, calls } = setup(() => new Response('{"error":"not_found"}', { status: 404 }));
      expect((await run(adapter, ask('medium'))).at(-1)).toMatchObject({ type: 'finish', reason: 'end' });
      const chat = calls.find((c) => c.url.endsWith('/chat/completions'))!;
      expect(chat.body).toMatchObject({ model: 'gpt-4.1' });
      expect(chat.headers.has('copilot-session-token')).toBe(false);
    });

    it('says why when the router fails and there is no fallback', async () => {
      const { adapter } = setup(() => new Response('{"error":"unavailable"}', { status: 503 }), false);
      expect((await run(adapter, ask('medium'))).at(-1)).toMatchObject({ type: 'finish', reason: 'error', error: expect.objectContaining({ retryable: true }) });
    });
  });

  it('lists nothing and says how to sign in when signed out', async () => {
    const adapter = createCopilotAdapter(instance, {
      fetch: async () => new Response('never'),
      readBlob: async () => new Uint8Array(),
      copilot: {
        credentials: async () => {
          throw new CopilotSignedOut();
        },
      },
    });
    expect(await adapter.listModels()).toEqual([]);
    expect(await adapter.health()).toMatchObject({ ok: false, error: expect.stringContaining('Sign in with GitHub') });
  });
});
