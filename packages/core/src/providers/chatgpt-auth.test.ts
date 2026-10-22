import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGptAuth, CHATGPT_CLIENT_ID, CHATGPT_ISSUER } from './chatgpt-auth.ts';

const device = { url: `${CHATGPT_ISSUER}/codex/device`, userCode: 'ABCD-EFGH' };
const usercode = { device_auth_id: 'device-secret', user_code: device.userCode, interval: '5' };
const authorization = {
  authorization_code: 'authorization-secret',
  code_verifier: 'verifier-secret',
  code_challenge: 'challenge',
};
const jwt = (claims: unknown) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const tokens = {
  access_token: jwt({ exp: 4_000_000_000 }),
  refresh_token: 'refresh-secret',
  id_token: jwt({
    email: 'person@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'account', chatgpt_plan_type: 'plus' },
  }),
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function setup() {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  const secrets = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const auth = new ChatGptAuth({ fetch, secrets, now: () => 0 });
  return { auth, fetch, secrets };
}

describe('ChatGPT device sign-in', () => {
  const active: ChatGptAuth[] = [];
  const create = () => {
    const deps = setup();
    active.push(deps.auth);
    return deps;
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    active.forEach((auth) => auth.dispose());
    active.length = 0;
    vi.useRealTimers();
  });

  it('returns the public code, exposes it on reload, polls pending statuses and exchanges using the device callback', async () => {
    const { auth, fetch, secrets } = create();
    fetch
      .mockResolvedValueOnce(json(usercode))
      .mockResolvedValueOnce(json({ hidden: 'do not expose' }, 403))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json(authorization))
      .mockResolvedValueOnce(json(tokens));
    expect(await auth.signInDevice()).toEqual(device);
    await flush();
    expect(await auth.status()).toMatchObject({ signedIn: false, signingIn: true, device });
    expect(fetch.mock.calls[0]![0]).toBe(`${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`);
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({ client_id: CHATGPT_CLIENT_ID });
    expect(fetch.mock.calls[1]![0]).toBe(`${CHATGPT_ISSUER}/api/accounts/deviceauth/token`);
    expect(JSON.parse(String(fetch.mock.calls[1]![1].body))).toEqual({
      device_auth_id: 'device-secret',
      user_code: device.userCode,
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(5);
    const exchange = fetch.mock.calls[4]!;
    expect(exchange[0]).toBe(`${CHATGPT_ISSUER}/oauth/token`);
    expect(Object.fromEntries(new URLSearchParams(String(exchange[1].body)))).toEqual({
      grant_type: 'authorization_code',
      code: authorization.authorization_code,
      redirect_uri: `${CHATGPT_ISSUER}/deviceauth/callback`,
      client_id: CHATGPT_CLIENT_ID,
      code_verifier: authorization.code_verifier,
    });
    expect(secrets.set).toHaveBeenCalledTimes(1);
    expect(await auth.credentials()).toMatchObject({ accessToken: tokens.access_token, accountId: 'account' });
    expect(await auth.status()).toMatchObject({ signedIn: true, signingIn: false, email: 'person@example.com' });
    expect((await auth.status()).device).toBeUndefined();
  });

  it('accepts the usercode alias and missing interval without busy-polling', async () => {
    const { auth, fetch } = create();
    fetch
      .mockResolvedValueOnce(json({ device_auth_id: 'id', usercode: device.userCode }))
      .mockResolvedValue(json({}, 403));
    expect(await auth.signInDevice()).toEqual(device);
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    {},
    null,
    { ...usercode, interval: 5 },
    { ...usercode, interval: '-1' },
    { ...usercode, interval: 'NaN' },
    { ...usercode, user_code: ' ' },
  ])('rejects invalid usercode data: %j', async (body) => {
    const { auth, fetch, secrets } = create();
    fetch.mockResolvedValue(json(body));
    await expect(auth.signInDevice()).rejects.toThrow('could not start');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(secrets.set).not.toHaveBeenCalled();
    expect(await auth.status()).toMatchObject({ signingIn: false, signedIn: false, error: expect.any(String) });
  });

  it.each([400, 401, 429, 500])('stops on non-pending poll HTTP %i without disclosing the response', async (status) => {
    const { auth, fetch } = create();
    fetch.mockResolvedValueOnce(json(usercode)).mockResolvedValue(json({ error: 'sensitive-secret' }, status));
    await auth.signInDevice();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await auth.status()).toMatchObject({
      signingIn: false,
      error: 'ChatGPT could not complete device sign-in. Start it again.',
    });
  });

  it.each([null, {}, { ...authorization, code_verifier: '' }, { ...authorization, code_challenge: null }])(
    'rejects invalid poll success: %j',
    async (body) => {
      const { auth, fetch, secrets } = create();
      fetch.mockResolvedValueOnce(json(usercode)).mockResolvedValueOnce(json(body));
      await auth.signInDevice();
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(secrets.set).not.toHaveBeenCalled();
      expect((await auth.status()).signingIn).toBe(false);
    },
  );

  it('expires after fifteen minutes, clears the code and stops polling', async () => {
    const { auth, fetch } = create();
    fetch.mockResolvedValueOnce(json(usercode)).mockResolvedValue(json({}, 403));
    await auth.signInDevice();
    await flush();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const calls = fetch.mock.calls.length;
    expect(await auth.status()).toEqual({
      available: true,
      signedIn: false,
      signingIn: false,
      error: 'The device sign-in timed out after 15 minutes. Start it again.',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it('bounds an initial request even when fetch ignores abort', async () => {
    const { auth, fetch } = create();
    fetch.mockReturnValue(new Promise(() => {}));
    const result = expect(auth.signInDevice()).rejects.toThrow('could not start');
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
    expect((await auth.status()).signingIn).toBe(false);
  });

  it('bounds a stalled response body read', async () => {
    const { auth, fetch } = create();
    const response = json(usercode);
    vi.spyOn(response, 'json').mockReturnValue(new Promise(() => {}));
    fetch.mockResolvedValueOnce(response);
    const result = expect(auth.signInDevice()).rejects.toThrow('could not start');
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect((await auth.status()).signingIn).toBe(false);
  });

  it.each([404, 500])('rejects usercode HTTP %i without polling', async (status) => {
    const { auth, fetch } = create();
    fetch.mockResolvedValueOnce(json({ error: 'private-body' }, status));
    await expect(auth.signInDevice()).rejects.toThrow('could not start');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await auth.status())).not.toContain('private-body');
  });

  it('cancels during pending polling without making further requests', async () => {
    const { auth, fetch } = create();
    fetch.mockResolvedValueOnce(json(usercode)).mockResolvedValue(json({}, 403));
    await auth.signInDevice();
    await flush();
    auth.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await auth.status()).toEqual({ available: true, signedIn: false, signingIn: false });
  });

  it('bounds token exchanges', async () => {
    const { auth, fetch, secrets } = create();
    fetch
      .mockResolvedValueOnce(json(usercode))
      .mockResolvedValueOnce(json(authorization))
      .mockReturnValueOnce(new Promise(() => {}));
    await auth.signInDevice();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await auth.status()).error).toContain('could not complete');
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'signOut', 'dispose'] as const)(
    '%s prevents a late exchange from saving credentials',
    async (method) => {
      const { auth, fetch, secrets } = create();
      const exchange = deferred<Response>();
      fetch
        .mockResolvedValueOnce(json(usercode))
        .mockResolvedValueOnce(json(authorization))
        .mockReturnValueOnce(exchange.promise);
      await auth.signInDevice();
      await flush();
      expect(fetch).toHaveBeenCalledTimes(3);
      await auth[method]();
      expect(fetch.mock.calls[2]![1].signal?.aborted).toBe(true);
      exchange.resolve(json(tokens));
      await flush();
      expect(secrets.set).not.toHaveBeenCalled();
      expect(await auth.status()).toEqual({ available: true, signedIn: false, signingIn: false });
    },
  );

  it('cancels an initial request and ignores its late response', async () => {
    const { auth, fetch } = create();
    const request = deferred<Response>();
    fetch.mockReturnValueOnce(request.promise);
    const result = expect(auth.signInDevice()).rejects.toThrow('cancelled');
    auth.cancel();
    await result;
    request.resolve(json(usercode));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await auth.status()).device).toBeUndefined();
  });

  it('replaces an attempt without allowing the old poll to exchange or clear the new state', async () => {
    const { auth, fetch, secrets } = create();
    const poll = deferred<Response>();
    fetch
      .mockResolvedValueOnce(json(usercode))
      .mockReturnValueOnce(poll.promise)
      .mockResolvedValueOnce(json({ ...usercode, user_code: 'NEW-CODE' }))
      .mockResolvedValue(json({}, 404));
    await auth.signInDevice();
    await flush();
    await auth.signInDevice();
    await flush();
    poll.resolve(json(authorization));
    await flush();
    expect(secrets.set).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(await auth.status()).toMatchObject({ signingIn: true, device: { ...device, userCode: 'NEW-CODE' } });
  });

  it('does not disclose network errors or malformed JSON', async () => {
    const { auth, fetch } = create();
    fetch.mockRejectedValueOnce(new Error('authorization-secret'));
    await expect(auth.signInDevice()).rejects.toThrow('could not start');
    expect(JSON.stringify(await auth.status())).not.toContain('authorization-secret');
    fetch.mockResolvedValueOnce(json(usercode)).mockResolvedValueOnce(new Response('token-secret'));
    await auth.signInDevice();
    await flush();
    expect(JSON.stringify(await auth.status())).not.toContain('token-secret');
    expect((await auth.status()).signingIn).toBe(false);
  });
});
