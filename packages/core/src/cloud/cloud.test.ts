import { describe, expect, it, vi } from 'vitest';
import { Codespaces } from './codespaces.ts';
import { GitHub, githubSecretId } from './github.ts';

/** The secret store, as far as these use it. */
function memorySecrets() {
  const values = new Map<string, { label: string; value: string }>();
  return {
    values,
    get: async (id: string) => values.get(id)?.value,
    set: async (input: { id?: string; label: string; value: string }) => (values.set(input.id!, { label: input.label, value: input.value }), input.id!),
    delete: async (id: string) => void values.delete(id),
    list: async () => [...values].map(([id, v]) => ({ id, label: v.label, kind: 'github' as const, masked: '••••', usedBy: [], createdAt: 0, rotatedAt: null, lastUsedAt: null })),
  };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });

describe('GitHub connection', () => {
  it('keeps a token GitHub accepts, with the codespace scope for classic tokens', async () => {
    const secrets = memorySecrets();
    const github = new GitHub({
      secrets,
      clientId: () => null,
      fetch: async (_url, init) => {
        const token = (init.headers as Record<string, string>).authorization;
        if (token === 'Bearer bad') return json({}, { status: 401 });
        return json({ login: 'ada' }, { headers: token === 'Bearer classic-no-scope' ? { 'x-oauth-scopes': 'repo' } : token === 'Bearer classic' ? { 'x-oauth-scopes': 'repo, codespace' } : {} });
      },
    });
    await expect(github.connectToken('u1', 'bad')).rejects.toThrow(/didn’t accept/);
    await expect(github.connectToken('u1', 'classic-no-scope')).rejects.toThrow(/codespace/);
    expect(await github.connectToken('u1', 'classic')).toEqual({ connected: true, login: 'ada' });
    expect(await github.status('u1')).toEqual({ connected: true, login: 'ada' });
    expect(secrets.values.get(githubSecretId('u1'))?.value).toBe('classic');
    await github.disconnect('u1');
    expect(await github.status('u1')).toEqual({ connected: false });
    await expect(github.deviceStart('u1')).rejects.toThrow(/OAuth app/);
  });

  it('follows the device flow until GitHub hands over a token', async () => {
    const answers = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'from-device' }];
    const github = new GitHub({
      secrets: memorySecrets(),
      clientId: () => 'Iv1.abc',
      fetch: async (url) => {
        if (url === 'https://github.com/login/device/code') return json({ device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 });
        if (url === 'https://github.com/login/oauth/access_token') return json(answers.shift());
        return json({ login: 'ada' });
      },
    });
    const flow = await github.deviceStart('u1');
    expect(flow).toMatchObject({ userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', interval: 5 });
    expect(await github.devicePoll('u1', flow.flowId)).toEqual({ status: 'pending', interval: 5 });
    expect(await github.devicePoll('u1', flow.flowId)).toEqual({ status: 'pending', interval: 10 });
    expect(await github.devicePoll('u2', flow.flowId)).toEqual({ status: 'expired' });
  });
});

describe('Codespaces', () => {
  it('lists, creates (waiting until available) and reaches codespaces with the person’s token', async () => {
    const secrets = memorySecrets();
    await secrets.set({ id: githubSecretId('u1'), label: 'GitHub (ada)', value: 'tok' });
    const states = ['Queued', 'Starting', 'Available'];
    const calls: string[] = [];
    const api = { name: 'fluffy-space', display_name: 'Fluffy', repository: { full_name: 'ada/app', name: 'app' }, machine: { display_name: '2 cores' }, idle_timeout_minutes: 30, last_used_at: '2026-10-13T10:00:00Z' };
    const fetch = async (url: string, init: RequestInit) => {
      calls.push(`${init.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`);
      if (url.endsWith('/user/codespaces?per_page=100')) return json({ codespaces: [{ ...api, state: 'Shutdown' }] });
      if (url.endsWith('/repos/ada/app/codespaces')) return json({ ...api, state: states.shift() }, { status: 201 });
      if (url.endsWith('/user/codespaces/fluffy-space')) return json({ ...api, state: states.shift() });
      return new Response(null, { status: 202 });
    };
    const codespaces = new Codespaces({ fetch, github: new GitHub({ secrets, clientId: () => null, fetch }), sleep: async () => {} });
    expect(await codespaces.list('u1')).toEqual([
      { name: 'fluffy-space', displayName: 'Fluffy', repo: 'ada/app', state: 'Shutdown', machine: '2 cores', idleTimeoutMinutes: 30, lastUsedAt: Date.parse('2026-10-13T10:00:00Z'), root: '/workspaces/app' },
    ]);
    expect((await codespaces.create('u1', { repo: 'ada/app', machine: 'basicLinux32gb' })).state).toBe('Available');
    await codespaces.stop('u1', 'fluffy-space');
    expect(calls).toEqual(['GET /user/codespaces?per_page=100', 'POST /repos/ada/app/codespaces', 'GET /user/codespaces/fluffy-space', 'GET /user/codespaces/fluffy-space', 'POST /user/codespaces/fluffy-space/stop']);
    expect(await codespaces.shell('u1', 'fluffy-space')).toEqual({ command: 'gh', args: ['codespace', 'ssh', '-c', 'fluffy-space', '--'], env: { GH_TOKEN: 'tok', GH_PROMPT_DISABLED: '1' }, label: 'fluffy-space', timeoutMs: 90_000 });
    await expect(codespaces.list('u2')).rejects.toThrow(/Connect GitHub/);
  });
});

describe('Opening a repository', () => {
  /** A tiny GitHub: the codespaces it holds, with the requests it saw. */
  function github(initial: { name: string; repo: string; state: string; lastUsed?: string }[], machines = [{ name: 'basicLinux32gb', display_name: '2 cores', cpus: 2, memory_in_bytes: 8e9 }, { name: 'premiumLinux', display_name: '8 cores', cpus: 8, memory_in_bytes: 32e9 }, { name: 'standardLinux32gb', display_name: '4 cores', cpus: 4, memory_in_bytes: 16e9 }]) {
    const secrets = memorySecrets();
    void secrets.set({ id: githubSecretId('u1'), label: 'GitHub (ada)', value: 'tok' });
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const rows = initial.map((c) => ({ name: c.name, display_name: c.name, state: c.state, repository: { full_name: c.repo, name: c.repo.split('/')[1] }, last_used_at: c.lastUsed ?? null }));
    const fetch = async (url: string, init: RequestInit) => {
      const path = url.replace('https://api.github.com', '');
      calls.push(`${init.method ?? 'GET'} ${path}`);
      if (init.body) bodies.push(JSON.parse(init.body as string));
      if (path.startsWith('/user/codespaces?')) return json({ codespaces: rows });
      if (path.endsWith('/codespaces/machines')) return json({ machines });
      if (path.startsWith('/repos/') && path.endsWith('/codespaces') && init.method === 'POST') {
        const repo = path.split('/').slice(2, 4).join('/');
        const made = { name: 'new-space', display_name: 'new-space', state: 'Available', repository: { full_name: repo, name: repo.split('/')[1] }, last_used_at: null };
        rows.push(made);
        return json(made, { status: 201 });
      }
      const row = rows.find((r) => path.includes(`/user/codespaces/${r.name}`));
      if (row && path.endsWith('/start')) {
        row.state = 'Starting';
        return json(row);
      }
      if (row) {
        // Starting comes up on its next look.
        if (row.state === 'Starting') row.state = 'Available';
        return json(row);
      }
      if (path.startsWith('/user/repos')) {
        return json(
          path.includes('page=1')
            ? [
                { full_name: 'ada/app', private: true, default_branch: 'main', pushed_at: '2026-10-13T10:00:00Z', archived: false },
                { full_name: 'ada/old', private: false, default_branch: 'master', pushed_at: null, archived: true },
              ]
            : [],
        );
      }
      return json({}, { status: 404 });
    };
    return { calls, bodies, rows, codespaces: new Codespaces({ fetch, github: new GitHub({ secrets, clientId: () => null, fetch }), sleep: async () => {} }) };
  }

  it('lists the repositories, leaving out archived ones', async () => {
    const { codespaces } = github([]);
    expect(await codespaces.repos('u1')).toEqual([{ fullName: 'ada/app', private: true, defaultBranch: 'main', pushedAt: Date.parse('2026-10-13T10:00:00Z') }]);
  });

  it('creates a codespace on the largest machine with the longest idle timeout when the repository has none', async () => {
    const { codespaces, bodies, calls } = github([{ name: 'other', repo: 'ada/other', state: 'Available' }]);
    expect((await codespaces.open('u1', { repo: 'ada/app' })).name).toBe('new-space');
    expect(bodies).toEqual([{ machine: 'premiumLinux', idle_timeout_minutes: 240 }]);
    expect(calls.some((c) => c.endsWith('/start'))).toBe(false);
  });

  it('reuses the repository’s newest codespace and wakes it when it went to sleep', async () => {
    const { codespaces, calls, rows } = github([
      { name: 'old-one', repo: 'ada/app', state: 'Available', lastUsed: '2026-10-01T00:00:00Z' },
      { name: 'recent', repo: 'ada/app', state: 'Shutdown', lastUsed: '2026-10-13T00:00:00Z' },
    ]);
    const opened = await codespaces.open('u1', { repo: 'ADA/app' });
    expect(opened).toMatchObject({ name: 'recent', state: 'Available' });
    expect(calls).toContain('POST /user/codespaces/recent/start');
    expect(calls.some((c) => c.startsWith('POST /repos/'))).toBe(false);
    expect(rows.find((r) => r.name === 'recent')?.state).toBe('Available');
  });

  it('makes a new one when the repository’s codespace is broken, and creates without a machine when none is listed', async () => {
    const { codespaces, bodies } = github([{ name: 'broken', repo: 'ada/app', state: 'Failed' }], []);
    expect((await codespaces.open('u1', { repo: 'ada/app', ref: 'dev' })).name).toBe('new-space');
    expect(bodies).toEqual([{ ref: 'dev', idle_timeout_minutes: 240 }]);
  });

  it('tells the caller once that it had to wait for a sleeping codespace', async () => {
    const { codespaces } = github([{ name: 'asleep', repo: 'ada/app', state: 'Shutdown' }]);
    const waking = vi.fn();
    expect((await codespaces.wake('u1', 'asleep', waking)).state).toBe('Available');
    expect(waking).toHaveBeenCalledOnce();
  });

  it('wakes a codespace only once and returns one that is already running untouched', async () => {
    const { codespaces, calls } = github([{ name: 'up', repo: 'ada/app', state: 'Available' }]);
    const waking = vi.fn();
    expect((await codespaces.wake('u1', 'up', waking)).state).toBe('Available');
    expect(calls).toEqual(['GET /user/codespaces/up']);
    expect(waking).not.toHaveBeenCalled();
  });
});

