import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig, ProviderDraft } from '@atelier/protocol';
import { OpenRouterConnect, OPENROUTER_KEYS_URL, type OpenRouterConnectDeps } from './openrouter-auth.ts';

const draft = { id: 'openrouter', type: 'openai-compatible' as const, name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: {}, enabled: true };

function setup(surface: 'desktop' | 'web', answer: () => Response = () => Response.json({ key: 'sk-or-v1-minted' })) {
  const requests: { url: string; body: Record<string, string> }[] = [];
  const saved: ProviderDraft[] = [];
  const deps: OpenRouterConnectDeps = {
    surface,
    fetch: async (url, init) => (requests.push({ url, body: JSON.parse(String(init.body)) as Record<string, string> }), answer()),
    save: async (d) => (saved.push(d), { ...d, apiKey: '${secret:provider-openrouter}' } as ProviderConfig),
  };
  return { connect: new OpenRouterConnect(deps), requests, saved };
}

describe('OpenRouterConnect', () => {
  const open: OpenRouterConnect[] = [];
  afterEach(() => open.splice(0).forEach((c) => c.cancel()));

  it('sends the person to OpenRouter with an S256 challenge and a loopback callback on the desktop, and saves the minted key', async () => {
    const { connect, requests, saved } = setup('desktop');
    open.push(connect);
    const url = new URL(await connect.start(draft, { userId: 'u1', browser: false }));
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(url.searchParams.get('callback_url')!);
    expect(callback.hostname).toBe('127.0.0.1');
    expect(callback.pathname).toBe('/oauth/callback');
    expect(connect.status()).toEqual({ connecting: true });

    const state = url.searchParams.get('state')!;
    const wrong = await fetch(`${callback.href}?code=x&state=nope`);
    expect(wrong.status).toBe(400);
    expect(connect.status().connecting).toBe(true);

    const ok = await fetch(`${callback.href}?code=the-code&state=${state}`);
    expect(ok.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(OPENROUTER_KEYS_URL);
    const { code, code_verifier, code_challenge_method } = requests[0]!.body;
    expect({ code, code_challenge_method }).toEqual({ code: 'the-code', code_challenge_method: 'S256' });
    // The verifier sent is the one the challenge was made from.
    expect(createHash('sha256').update(code_verifier!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(saved).toEqual([{ ...draft, apiKey: 'sk-or-v1-minted' }]);
    expect(connect.status()).toMatchObject({ connecting: false, provider: { id: 'openrouter', apiKey: '${secret:provider-openrouter}' } });
  });

  it('comes back to the web server’s own callback, for the same person only', async () => {
    const { connect, saved } = setup('web');
    open.push(connect);
    await expect(connect.start(draft, { userId: 'u1', browser: true })).rejects.toThrow('address to come back to');
    const url = new URL(await connect.start(draft, { userId: 'u1', browser: true, origin: 'https://atelier.example.com' }));
    expect(url.searchParams.get('callback_url')).toBe('https://atelier.example.com/oauth/callback');
    const state = url.searchParams.get('state')!;
    const params = new URLSearchParams({ code: 'c', state });
    expect(connect.owns(params)).toBe(true);
    expect(connect.owns(new URLSearchParams({ code: 'c', state: 'a-connector' }))).toBe(false);
    expect(await connect.finish(params, null)).toContain('browser where you started it');
    expect(await connect.finish(params, 'u2')).toContain('browser where you started it');
    expect(await connect.finish(params, 'u1')).toBeNull();
    expect(saved).toHaveLength(1);
    // Used once.
    expect(connect.owns(params)).toBe(false);
  });

  it('reports a refused exchange and a declined connection', async () => {
    const refused = setup('web', () => Response.json({ error: { message: 'Invalid code or code_verifier', code: 403 } }, { status: 403 }));
    const url = new URL(await refused.connect.start(draft, { userId: 'u1', browser: false, origin: 'https://a.example' }));
    const error = await refused.connect.finish(new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! }), null);
    expect(error).toBe('OpenRouter refused the connection (403: Invalid code or code_verifier).');
    expect(refused.connect.status()).toEqual({ connecting: false, error });
    expect(refused.saved).toEqual([]);

    const keyless = setup('web', () => Response.json({ nope: true }));
    const again = new URL(await keyless.connect.start(draft, { userId: 'u1', browser: false, origin: 'https://a.example' }));
    expect(await keyless.connect.finish(new URLSearchParams({ code: 'c', state: again.searchParams.get('state')! }), null)).toBe('OpenRouter answered without a key.');

    // Declining sends the browser back without a code or state: on the desktop's own listener, that ends the flow.
    const desktop = setup('desktop');
    open.push(desktop.connect);
    const callback = new URL(await desktop.connect.start(draft, { userId: 'u1', browser: false })).searchParams.get('callback_url')!;
    expect((await fetch(callback)).status).toBe(400);
    expect(desktop.connect.status()).toEqual({ connecting: false, error: 'OpenRouter didn’t connect: access was declined.' });
  });

  it('can be cancelled', async () => {
    const { connect } = setup('desktop');
    const callback = new URL(await connect.start(draft, { userId: 'u1', browser: false })).searchParams.get('callback_url')!;
    connect.cancel();
    expect(connect.status()).toEqual({ connecting: false });
    await expect(fetch(callback)).rejects.toThrow();
  });
});
