import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
      else {
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
