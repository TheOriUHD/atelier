import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerToDevice } from '@atelier/protocol';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { DeviceLinks } from './device-links.ts';
import { hostRunnerBinary, spawnRunner, type RunnerChannel } from './runner-client.ts';
import { WorkspaceError, WorkspaceManager } from './workspace-manager.ts';

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));
const built = existsSync(binary);

let db: Db;
let dir: string;
let changes: string[];
let links: DeviceLinks;
let server: WorkspaceManager;

/** A desktop device: trusts `trusted`, runs a real runner per channel and pipes its lines. */
function device(userId: string, deviceId: string, trusted: string) {
  const runners = new Map<string, RunnerChannel>();
  const reply = (frame: object) => link.receive(JSON.stringify(frame));
  const link = links.attach(userId, deviceId, {
    send(frame: ServerToDevice) {
      if (frame.t === 'open') {
        if (frame.root !== trusted) return reply({ t: 'closed', channel: frame.channel, reason: `${frame.root} isn't trusted here.` });
        const runner = spawnRunner({ binaryPath: binary, roots: [frame.root] });
        runner.onLine((line) => reply({ t: 'line', channel: frame.channel, line }));
        void runner.closed.then(() => runners.has(frame.channel) && reply({ t: 'closed', channel: frame.channel, reason: 'The runner stopped.' }));
        runners.set(frame.channel, runner);
        reply({ t: 'opened', channel: frame.channel });
      } else if (frame.t === 'line') runners.get(frame.channel)?.send(frame.line);
      else if (frame.t === 'ping') reply({ t: 'pong' });
      else if (frame.t === 'close') {
        runners.get(frame.channel)?.kill();
        runners.delete(frame.channel);
      }
    },
    close() {
      for (const runner of runners.values()) runner.kill();
      runners.clear();
      link.closed();
    },
  });
  return { disconnect: () => link.closed(), runners };
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  for (const id of ['ada', 'bob']) await db.insert(users).values({ id, username: id, name: id, role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-device-')));
  changes = [];
  links = new DeviceLinks((userId) => changes.push(userId));
  server = new WorkspaceManager({ db, runnerBinary: null, links, logger: { info: () => {}, error: () => {} } });
});
afterEach(async () => {
  vi.useRealTimers();
  await server.disposeAll();
  links.closeAll();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!built)('device links', () => {
  it('runs a workspace on the desktop the folder was added from', async () => {
    const laptop = device('ada', 'laptop', dir);
    expect(changes).toEqual(['ada']);
    const ws = await server.addLocal('ada', dir, 'laptop');
    expect(ws).toMatchObject({ root: dir, deviceId: 'laptop', available: true });

    const live = await server.open('ada', ws.id);
    const shell = await live.shellFor('s1');
    expect((await live.runner.call('shell.exec', { shellId: shell, command: 'pwd' })).output.trim().replaceAll('\\', '/')).toBe(dir.replaceAll('\\', '/'));

    laptop.disconnect();
    expect(changes).toEqual(['ada', 'ada']);
    expect((await server.list('ada'))[0]!.available).toBe(false);
    await expect(server.open('ada', ws.id)).rejects.toThrow(/isn't connected/);
  });

  it('keeps devices to their own account and passes on refusals', async () => {
    device('ada', 'laptop', join(dir, 'elsewhere'));
    await expect(server.addLocal('bob', dir, 'laptop')).rejects.toThrow(/Open the desktop app/);
    await expect(server.addLocal('ada', dir, null)).rejects.toThrow(/Open the desktop app/);
    const refused = await server.addLocal('ada', dir, 'laptop').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WorkspaceError);
    expect((refused as Error).message).toContain("isn't trusted here");
  });

  it('a newer link of the same device replaces the old one', async () => {
    const first = device('ada', 'laptop', dir);
    const ws = await server.addLocal('ada', dir, 'laptop');
    await server.open('ada', ws.id);
    device('ada', 'laptop', dir);
    // The old link was closed, its runner with it; the workspace reconnects through the new one.
    expect(first.runners.size).toBe(0);
    const live = await server.open('ada', ws.id);
    expect((await live.runner.call('fs.stat', { path: '.' })).type).toBe('dir');
  });
});

/**
 * A version-2 desktop: says what it lends, makes scratch folders under `<dir>/scratch`, and reaches "SSH hosts" by
 * running a runner here with `<dir>/home` as the host's home (what its ssh would start over there).
 */
function deviceV2(userId: string, deviceId: string) {
  const runners = new Map<string, RunnerChannel>();
  const started: unknown[] = [];
  const scratchBase = join(dir, 'scratch');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const reply = (frame: object) => link.receive(JSON.stringify(frame));
  const run = (channel: string, root: string, env: Record<string, string> = {}) => {
    const runner = spawnRunner({ binaryPath: binary, roots: [root], env: { ...process.env, HOME: home, ...env } });
    runner.onLine((line) => reply({ t: 'line', channel, line }));
    void runner.closed.then(() => runners.has(channel) && reply({ t: 'closed', channel, reason: 'The runner stopped.' }));
    runners.set(channel, runner);
    reply({ t: 'opened', channel });
  };
  const link = links.attach(userId, deviceId, {
    send(frame: ServerToDevice) {
      if (frame.t === 'open') {
        if (!frame.root.startsWith(scratchBase)) return reply({ t: 'closed', channel: frame.channel, reason: `${frame.root} isn't trusted here.` });
        run(frame.channel, frame.root);
      } else if (frame.t === 'start') {
        started.push(frame.service);
        run(frame.channel, frame.service.root, frame.service.env);
      } else if (frame.t === 'req') {
        const { request } = frame;
        if (request.op === 'scratch.create') {
          const root = join(scratchBase, request.user, request.name);
          mkdirSync(root, { recursive: true });
          reply({ t: 'res', id: frame.id, ok: true, value: { root } });
        } else reply({ t: 'res', id: frame.id, ok: false, code: 'unsupported', error: 'Not in this test.' });
      } else if (frame.t === 'line') runners.get(frame.channel)?.send(frame.line);
      else if (frame.t === 'ping') reply({ t: 'pong' });
      else if (frame.t === 'close') {
        runners.get(frame.channel)?.kill();
        runners.delete(frame.channel);
      }
    },
    close() {
      for (const runner of runners.values()) runner.kill();
      runners.clear();
      link.closed();
    },
  });
  reply({ t: 'hello', hello: { protocol: 2, app: '0.2.8', services: ['runner', 'scratch', 'ssh'], lending: { scratch: true, ssh: ['build@box'] }, home: '/Users/ada', sep: '/', os: 'darwin', arch: 'arm64' } });
  return { started, home, scratchBase };
}

describe.skipIf(!built)('device services', () => {
  const access = { connection: { name: 'Box', host: 'build@box', port: 2222, keyPath: '~/.ssh/box' }, answers: { trust: false, password: 'pw' } };
  const withSsh = () => new WorkspaceManager({ db, runnerBinary: null, links, deviceSsh: async () => access, logger: { info: () => {}, error: () => {} } });

  it('makes a folder on the desktop for a session started without one', async () => {
    const laptop = deviceV2('ada', 'laptop');
    const ws = await server.addScratch('ada', undefined, 'laptop');
    expect(ws).toMatchObject({ kind: 'local', deviceId: 'laptop', scratch: true, available: true });
    expect(ws.root.startsWith(join(laptop.scratchBase, 'ada', 'scratch-'))).toBe(true);
    const live = await server.open('ada', ws.id);
    expect((await live.runner.call('fs.stat', { path: '.' })).type).toBe('dir');
  });

  it('reaches an SSH host from the desktop: folders, browsing and scratch folders there', async () => {
    const laptop = deviceV2('ada', 'laptop');
    const manager = withSsh();
    try {
      const project = join(laptop.home, 'app');
      mkdirSync(join(project, 'src'), { recursive: true });
      const ws = await manager.addSsh('ada', 'build@box', '~/app', 'laptop');
      expect(ws).toMatchObject({ kind: 'ssh', host: 'build@box', deviceId: 'laptop', root: project, available: true });
      expect(laptop.started[0]).toMatchObject({ kind: 'ssh', connection: access.connection, answers: access.answers });

      const live = await manager.open('ada', ws.id);
      expect((await live.runner.call('fs.stat', { path: 'src' })).type).toBe('dir');

      const browsed = await manager.browseRemote('ada', 'build@box', '~', 'laptop');
      expect(browsed).toMatchObject({ home: laptop.home, dirs: ['app'] });

      const scratch = await manager.addScratch('ada', 'build@box', 'laptop');
      expect(scratch).toMatchObject({ kind: 'ssh', deviceId: 'laptop', scratch: true });
      expect(scratch.root.startsWith(`${laptop.home}/.atelier/scratch-workspaces/ada/scratch-`)).toBe(true);
      await manager.open('ada', scratch.id);
      // Git never looks above a scratch folder over there either.
      expect(laptop.started.at(-1)).toMatchObject({ env: { GIT_CEILING_DIRECTORIES: `${laptop.home}/.atelier/scratch-workspaces/ada` } });

      // The same host reached from this machine would be another workspace; through the same device it is the same one.
      expect((await manager.addSsh('ada', 'build@box', project, 'laptop')).id).toBe(ws.id);
    } finally {
      await manager.disposeAll();
    }
  });

  it('says why when the device refuses', async () => {
    const sent: ServerToDevice[] = [];
    const link = links.attach('ada', 'laptop', { send: (frame) => sent.push(frame), close: () => {} });
    link.receive(JSON.stringify({ t: 'hello', hello: { protocol: 2, app: '0.2.8', services: ['runner', 'scratch'], lending: { scratch: false, ssh: [] }, home: '/Users/ada', sep: '/', os: 'darwin', arch: 'arm64' } }));
    const making = server.addScratch('ada', undefined, 'laptop').catch((e: unknown) => e);
    await new Promise((r) => setImmediate(r));
    const req = sent.find((f) => f.t === 'req') as { id: number };
    link.receive(JSON.stringify({ t: 'res', id: req.id, ok: false, code: 'refused', error: 'Sessions without a folder are off on this computer.' }));
    expect(await making).toMatchObject({ message: 'Sessions without a folder are off on this computer.' });
    await expect(withSsh().addSsh('ada', 'build@box', '~/app', 'laptop')).rejects.toThrow(/too old/);
  });
});

describe('device link owners', () => {
  it('keeps links per account, so another account using a device id leaves the owner’s link alone', async () => {
    let closed = false;
    links.attach('ada', 'laptop', { send: () => {}, close: () => void (closed = true) });
    links.attach('bob', 'laptop', { send: () => {}, close: () => {} });
    expect(closed).toBe(false);
    expect(links.online('ada', 'laptop')).toBe(true);
    expect(links.online('bob', 'laptop')).toBe(true);
    expect(links.online('cy', 'laptop')).toBe(false);
  });
});

describe('device link liveness', () => {
  it('drops a device that stops answering pings, closing its channels', async () => {
    vi.useFakeTimers();
    const sent: ServerToDevice[] = [];
    let socketClosed = false;
    const link = links.attach('ada', 'laptop', { send: (frame) => sent.push(frame), close: () => void (socketClosed = true) });
    const opening = links.open('ada', 'laptop', '/work');
    link.receive(JSON.stringify({ t: 'opened', channel: (sent[0] as { channel: string }).channel }));
    const channel = await opening;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)).toEqual({ t: 'ping' });
    link.receive(JSON.stringify({ t: 'pong' }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(links.online('ada', 'laptop')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socketClosed).toBe(true);
    expect(links.online('ada', 'laptop')).toBe(false);
    expect(changes).toEqual(['ada', 'ada']);
    await channel.closed;
  });
});

describe('device link version 2', () => {
  const HELLO = {
    protocol: 2,
    app: '0.2.8',
    services: ['runner', 'scratch', 'ssh'],
    lending: { scratch: true, ssh: ['build@box'] },
    home: '/Users/ada',
    sep: '/',
    os: 'darwin',
    arch: 'arm64',
  };
  const SSH = { kind: 'ssh' as const, connection: { name: 'Box', host: 'build@box', port: null, keyPath: null }, answers: { trust: false }, root: '/srv/app', env: {} };

  const tick = () => new Promise((r) => setImmediate(r));

  function attach() {
    const sent: ServerToDevice[] = [];
    const link = links.attach('ada', 'laptop', { send: (frame) => sent.push(frame), close: () => link.closed() });
    return { sent, receive: (frame: object) => link.receive(JSON.stringify(frame)), link };
  }

  it('treats a desktop that says nothing as an older one: runners only', async () => {
    vi.useFakeTimers();
    attach();
    expect(links.info('ada', 'laptop')).toMatchObject({ services: ['runner'], lending: { scratch: false, ssh: [] }, home: null });
    const asked = links.request('ada', 'laptop', { op: 'ssh.hosts' });
    const settled = asked.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await settled).toMatchObject({ code: 'unsupported' });
  });

  it('learns what a device lends from its hello, and asks it things', async () => {
    const { sent, receive } = attach();
    receive({ t: 'hello', hello: HELLO });
    expect(links.info('ada', 'laptop')).toMatchObject({ services: HELLO.services, lending: HELLO.lending, home: '/Users/ada', os: 'darwin' });
    expect(changes).toEqual(['ada', 'ada']);

    const hosts = links.request('ada', 'laptop', { op: 'ssh.hosts' });
    await tick();
    const req = sent.find((f) => f.t === 'req')!;
    expect(req).toMatchObject({ t: 'req', request: { op: 'ssh.hosts' } });
    receive({ t: 'res', id: (req as { id: number }).id, ok: true, value: ['box', 'pi'] });
    expect(await hosts).toEqual(['box', 'pi']);

    const scratch = links.request('ada', 'laptop', { op: 'scratch.create', user: 'ada', name: 'scratch-2026-10-24-abcdef' });
    await tick();
    const second = sent.filter((f) => f.t === 'req').at(-1) as { id: number };
    receive({ t: 'res', id: second.id, ok: false, code: 'refused', error: 'Sessions without a folder are off on this computer.' });
    await expect(scratch).rejects.toMatchObject({ code: 'refused', message: 'Sessions without a folder are off on this computer.' });
  });

  it('hears when the person changes what the device lends', () => {
    const { receive } = attach();
    receive({ t: 'hello', hello: HELLO });
    receive({ t: 'event', event: 'lending.changed', lending: { scratch: false, ssh: [] } });
    expect(links.info('ada', 'laptop')?.lending).toEqual({ scratch: false, ssh: [] });
    expect(changes).toEqual(['ada', 'ada', 'ada']);
  });

  it('starts an SSH runner through the device, with its stderr kept apart', async () => {
    const { sent, receive } = attach();
    receive({ t: 'hello', hello: HELLO });
    const logged: string[] = [];
    const starting = links.start('ada', 'laptop', SSH, (line) => logged.push(line));
    await tick();
    const start = sent.find((f) => f.t === 'start') as { channel: string; service: unknown };
    expect(start.service).toEqual(SSH);
    receive({ t: 'opened', channel: start.channel });
    const channel = await starting;
    const lines: string[] = [];
    channel.onLine((line) => lines.push(line));
    receive({ t: 'line', channel: start.channel, line: '{"jsonrpc":"2.0"}' });
    receive({ t: 'log', channel: start.channel, line: 'runner: started' });
    expect(lines).toEqual(['{"jsonrpc":"2.0"}']);
    expect(logged).toEqual(['runner: started']);
    channel.send('{"id":1}');
    expect(sent.at(-1)).toEqual({ t: 'line', channel: start.channel, line: '{"id":1}' });
  });

  it("refuses to start what the device doesn't lend, and fails what's pending when it goes", async () => {
    const { receive, link } = attach();
    receive({ t: 'hello', hello: { ...HELLO, services: ['runner'] } });
    await expect(links.start('ada', 'laptop', SSH)).rejects.toMatchObject({ code: 'unsupported' });

    receive({ t: 'hello', hello: HELLO });
    const pending = links.request('ada', 'laptop', { op: 'ssh.hosts' }).catch((e: unknown) => e);
    await tick();
    link.closed();
    expect(await pending).toMatchObject({ code: 'offline' });
    expect(links.info('ada', 'laptop')).toBeNull();
  });

  it('drops frames it can’t read', () => {
    const { receive } = attach();
    receive({ t: 'hello', hello: { ...HELLO, protocol: 1 } });
    receive({ t: 'what' });
    expect(links.info('ada', 'laptop')?.services).toEqual(['runner']);
  });
});
