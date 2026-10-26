import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { NO_LENDING } from '@atelier/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceLink, insideTrusted, trustedPath } from './device-link.ts';

class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  sent: unknown[] = [];
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
  /** A frame from the server. */
  frame(value: object) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000) {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

class FakeRunner extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  written: string[] = [];
  killed = false;
  constructor(readonly root: string) {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.written.push(chunk.toString()));
  }
  kill() {
    this.killed = true;
    this.emit('close');
  }
}

const device = { id: '6f1c2c8e-8a39-4a8e-9d55-0f0b6f5f6d7a', name: 'Laptop', platform: 'macOS' };
let sockets: FakeSocket[];
let runners: FakeRunner[];
let dir: string;
/** The trusted folder. */
let app: string;
const tick = () => new Promise((r) => setImmediate(r));

function link(trusted = [app], runnerBinary: string | null = '/bin/runner', trustedFolders = async () => trusted) {
  return createDeviceLink({
    serverUrl: 'https://atelier.example.com',
    device,
    runnerBinary,
    trustedFolders,
    openSocket: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    spawnRunner: (_binary, root) => {
      const r = new FakeRunner(root);
      runners.push(r);
      return r as never;
    },
  });
}

beforeEach(() => {
  sockets = [];
  runners = [];
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-link-')));
  app = join(dir, 'app');
  mkdirSync(app);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('insideTrusted', () => {
  it('accepts trusted folders and folders inside them only', () => {
    expect(insideTrusted('/work/app', ['/work/app'])).toBe(true);
    expect(insideTrusted('/work/app/packages/ui', ['/work/app'])).toBe(true);
    expect(insideTrusted('/work/app-old', ['/work/app'])).toBe(false);
    expect(insideTrusted('/work', ['/work/app'])).toBe(false);
    expect(insideTrusted('/work/app/../secrets', ['/work/app'])).toBe(false);
  });
});

describe('trustedPath', () => {
  it('resolves existing files inside trusted folders and refuses the rest, symlinks included', async () => {
    mkdirSync(join(app, 'out'));
    writeFileSync(join(app, 'out', 'report.docx'), '');
    writeFileSync(join(dir, 'secret.txt'), '');
    symlinkSync(join(dir, 'secret.txt'), join(app, 'link.txt'));
    expect(await trustedPath(join(app, 'out', 'report.docx'), [app])).toBe(join(app, 'out', 'report.docx'));
    expect(await trustedPath(join(dir, 'secret.txt'), [app])).toBeNull();
    expect(await trustedPath(join(app, 'link.txt'), [app])).toBeNull();
    expect(await trustedPath(join(app, 'missing.txt'), [app])).toBeNull();
    expect(await trustedPath('out/report.docx', [app])).toBeNull();
    expect(await trustedPath(42, [app])).toBeNull();
  });
});

describe('device link', () => {
  it('signs in with the token and names the device', () => {
    const l = link();
    expect(sockets).toHaveLength(0);
    l.setToken('tok');
    expect(sockets[0]).toMatchObject({
      url: 'wss://atelier.example.com/api/devices/link',
      headers: { Authorization: 'Bearer tok', 'x-atelier-device-id': device.id, 'x-atelier-device-name': 'Laptop', 'x-atelier-device-platform': 'macOS' },
    });
  });

  it('runs trusted roots, pipes lines both ways and refuses the rest', async () => {
    const l = link();
    l.setToken('tok');
    const s = sockets[0]!;
    s.open();
    s.frame({ t: 'open', channel: 'c1', root: dir });
    s.frame({ t: 'open', channel: 'c2', root: app });
    await vi.waitFor(() => expect(s.sent).toHaveLength(2));
    // Both folders are checked at once (two `realpath` calls), so the replies can come in either order.
    expect(s.sent).toEqual(
      expect.arrayContaining([
        { t: 'closed', channel: 'c1', reason: `${dir} isn't a folder you opened in Laptop's desktop app.` },
        { t: 'opened', channel: 'c2' },
      ]),
    );
    expect(runners.map((r) => r.root)).toEqual([app]);

    s.frame({ t: 'line', channel: 'c2', line: '{"id":1}' });
    expect(runners[0]!.written).toEqual(['{"id":1}\n']);
    runners[0]!.stdout.write('{"id":1,"result":null}\n');
    await tick();
    expect(s.sent.at(-1)).toEqual({ t: 'line', channel: 'c2', line: '{"id":1,"result":null}' });

    s.frame({ t: 'close', channel: 'c2' });
    expect(runners[0]!.killed).toBe(true);
  });

  it('resolves symlinks in the requested root before checking it', async () => {
    symlinkSync(dir, join(app, 'escape'));
    // Another name for the trusted folder, as /tmp is for /private/tmp on macOS.
    symlinkSync(app, join(dir, 'alias'));
    const l = link();
    l.setToken('tok');
    const s = sockets[0]!;
    s.open();
    s.frame({ t: 'open', channel: 'c1', root: join(app, 'escape') });
    s.frame({ t: 'open', channel: 'c2', root: join(dir, 'alias') });
    s.frame({ t: 'open', channel: 'c3', root: join(app, 'missing') });
    await vi.waitFor(() => expect(s.sent).toHaveLength(3));
    expect(s.sent).toEqual(
      expect.arrayContaining([
        { t: 'closed', channel: 'c1', reason: `${join(app, 'escape')} isn't a folder you opened in Laptop's desktop app.` },
        { t: 'opened', channel: 'c2' },
        { t: 'closed', channel: 'c3', reason: `${join(app, 'missing')} isn't a folder you opened in Laptop's desktop app.` },
      ]),
    );
    expect(runners.map((r) => r.root)).toEqual([app]);
  });

  it('starts no runner for a channel closed while its root is checked', async () => {
    let answer: ((folders: string[]) => void) | undefined;
    const l = link([app], '/bin/runner', () => new Promise((resolve) => (answer = resolve)));
    l.setToken('tok');
    const s = sockets[0]!;
    s.open();
    s.frame({ t: 'open', channel: 'c1', root: app });
    s.frame({ t: 'close', channel: 'c1' });
    await vi.waitFor(() => expect(answer).toBeDefined());
    answer!([app]);
    await tick();
    expect(runners).toHaveLength(0);
    expect(s.sent).toEqual([]);
  });

  it('refuses everything without a runner build', async () => {
    const l = link([app], null);
    l.setToken('tok');
    sockets[0]!.open();
    sockets[0]!.frame({ t: 'open', channel: 'c1', root: app });
    await tick();
    expect(sockets[0]!.sent).toEqual([{ t: 'closed', channel: 'c1', reason: 'Laptop has no runner build for this platform.' }]);
  });

  it('stops runners when the link drops, reconnects, and waits for a new token after a refused sign-in', async () => {
    vi.useFakeTimers();
    const l = link();
    l.setToken('tok');
    sockets[0]!.open();
    sockets[0]!.frame({ t: 'open', channel: 'c1', root: app });
    await vi.waitFor(() => expect(runners).toHaveLength(1));
    sockets[0]!.close(1006);
    expect(runners[0]!.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);

    sockets[1]!.close(4401);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    l.setToken('fresh');
    expect(sockets).toHaveLength(3);
    l.close();
    expect(sockets[2]!.readyState).toBe(WebSocket.CLOSED);
  });

  it('tries a refused token again when given it again (an account that had to change its password keeps its token)', async () => {
    vi.useFakeTimers();
    const l = link();
    l.setToken('tok');
    sockets[0]!.close(4401);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    l.setToken('tok');
    expect(sockets).toHaveLength(2);
    // A link that is up isn't reconnected by the same token.
    sockets[1]!.open();
    l.setToken('tok');
    expect(sockets).toHaveLength(2);
    l.close();
  });

  it('answers pings, and drops and reconnects a link the server stopped pinging', async () => {
    vi.useFakeTimers();
    const l = link();
    l.setToken('tok');
    const s = sockets[0]!;
    s.open();
    s.frame({ t: 'open', channel: 'c1', root: app });
    await vi.waitFor(() => expect(runners).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(25_000);
    s.frame({ t: 'ping' });
    expect(s.sent.at(-1)).toEqual({ t: 'pong' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.readyState).toBe(WebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.readyState).toBe(WebSocket.CLOSED);
    expect(runners[0]!.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);
    l.close();
  });
});

describe('device link version 2', () => {
  const HELLO = { protocol: 2, app: '0.2.8', services: ['runner', 'scratch', 'ssh'], lending: { ...NO_LENDING, scratch: true, ssh: ['box'] }, home: '/Users/ada', sep: '/' as const, os: 'darwin', arch: 'arm64' };

  /** A lent SSH runner: lines written to it, and its own lines and end. */
  function fakeChannel() {
    let onLine: ((line: string) => void) | undefined;
    let end!: () => void;
    const written: string[] = [];
    const channel = {
      send: (line: string) => void written.push(line),
      onLine: (handler: (line: string) => void) => void (onLine = handler),
      closed: new Promise<{ code: null; signal: null }>((r) => (end = () => r({ code: null, signal: null }))),
      kill: () => end(),
    };
    return { channel, written, say: (line: string) => onLine?.(line), end: () => end() };
  }

  function linkWith(services: Partial<NonNullable<Parameters<typeof createDeviceLink>[0]['services']>>) {
    return createDeviceLink({
      serverUrl: 'https://atelier.example.com',
      device,
      runnerBinary: '/bin/runner',
      trustedFolders: async () => [app],
      services: { hello: async () => HELLO, request: async () => null, start: async () => fakeChannel().channel, scratchEnv: async () => null, ...services },
      openSocket: (url, headers) => {
        const s = new FakeSocket(url, headers);
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      spawnRunner: (_binary, root, env) => {
        const r = new FakeRunner(root);
        (r as FakeRunner & { env?: unknown }).env = env;
        runners.push(r);
        return r as never;
      },
    });
  }

  it('says what it lends first, and again when the person changes it', async () => {
    const l = linkWith({});
    l.setToken('tok');
    sockets[0]!.open();
    await tick();
    expect(sockets[0]!.sent[0]).toEqual({ t: 'hello', hello: HELLO });
    l.lendingChanged();
    await tick();
    expect(sockets[0]!.sent.at(-1)).toEqual({ t: 'event', event: 'lending.changed', lending: HELLO.lending });
  });

  it('answers requests with their value, or with why not', async () => {
    const l = linkWith({
      request: async (request) => {
        if (request.op === 'ssh.hosts') return ['box'];
        throw Object.assign(new Error('Sessions without a folder aren’t allowed on Laptop.'), { code: 'refused' });
      },
    });
    l.setToken('tok');
    const s = sockets[0]!;
    s.open();
    s.frame({ t: 'req', id: 1, request: { op: 'ssh.hosts' } });
    s.frame({ t: 'req', id: 2, request: { op: 'scratch.create', user: 'ada', name: 'scratch-2026-10-25-abcdef' } });
    await tick();
    expect(s.sent).toContainEqual({ t: 'res', id: 1, ok: true, value: ['box'] });
    expect(s.sent).toContainEqual({ t: 'res', id: 2, ok: false, code: 'refused', error: 'Sessions without a folder aren’t allowed on Laptop.' });
  });

  it('lends an SSH runner: lines both ways, stderr apart, its end said', async () => {
    const lent = fakeChannel();
    let logged: ((line: string) => void) | undefined;
    const l = linkWith({
      start: async (_service, log) => {
        logged = log;
        return lent.channel;
      },
    });
    l.setToken('tok');
    const s = sockets[0]!;
    s.open();
    s.frame({ t: 'start', channel: 'c1', service: { kind: 'ssh', connection: { name: 'Box', host: 'box', port: null, keyPath: null }, answers: { trust: false }, root: '/srv', env: {} } });
    await tick();
    expect(s.sent).toContainEqual({ t: 'opened', channel: 'c1' });
    s.frame({ t: 'line', channel: 'c1', line: '{"id":1}' });
    expect(lent.written).toEqual(['{"id":1}']);
    lent.say('{"result":1}');
    logged?.('remote says hi');
    expect(s.sent).toContainEqual({ t: 'line', channel: 'c1', line: '{"result":1}' });
    expect(s.sent).toContainEqual({ t: 'log', channel: 'c1', line: 'remote says hi' });
    lent.end();
    await tick();
    expect(s.sent.at(-1)).toEqual({ t: 'closed', channel: 'c1', reason: 'The connection ended.' });
  });

  it('passes on why a service wasn’t started', async () => {
    const l = linkWith({
      start: async () => {
        throw new Error("box isn't an SSH host you use from Laptop.");
      },
    });
    l.setToken('tok');
    const s = sockets[0]!;
    s.open();
    s.frame({ t: 'start', channel: 'c1', service: { kind: 'ssh', connection: { name: 'Box', host: 'box', port: null, keyPath: null }, answers: { trust: false }, root: '/srv', env: {} } });
    await tick();
    expect(s.sent.at(-1)).toEqual({ t: 'closed', channel: 'c1', reason: "box isn't an SSH host you use from Laptop." });
  });

  it('lends a runner at one of its scratch folders, with what keeps git inside it', async () => {
    const scratch = join(dir, 'scratch', 'ada', 'scratch-2026-10-25-abcdef');
    mkdirSync(scratch, { recursive: true });
    const l = linkWith({ scratchEnv: async (real) => (real === scratch ? { GIT_CEILING_DIRECTORIES: join(dir, 'scratch', 'ada') } : null) });
    l.setToken('tok');
    const s = sockets[0]!;
    s.open();
    s.frame({ t: 'open', channel: 'c1', root: scratch });
    s.frame({ t: 'open', channel: 'c2', root: dir });
    await vi.waitFor(() => expect(s.sent.filter((f) => (f as { t: string }).t !== 'hello')).toHaveLength(2));
    expect(s.sent).toContainEqual({ t: 'opened', channel: 'c1' });
    expect((runners[0] as FakeRunner & { env?: unknown }).env).toEqual({ GIT_CEILING_DIRECTORIES: join(dir, 'scratch', 'ada') });
    expect(s.sent).toContainEqual({ t: 'closed', channel: 'c2', reason: `${dir} isn't a folder you opened in Laptop's desktop app.` });
  });
});
