import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SOCKET_FRAME_BYTES, NO_LENDING, RUNNER_PROTOCOL_VERSION, type DeviceLending, type DeviceSocketLine } from '@atelier/protocol';
import { hostRunnerBinary } from '../index.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { wsServer, type WsServer } from './__fixtures__/ws-server.ts';
import { deviceServices, lentHeaders, withinAddress, withinSocketAddress } from './services.ts';
import { applyLending, connectorFingerprint } from './lending.ts';

const runnerDir = join(import.meta.dirname, '../../../../runner/bin');
const built = existsSync(hostRunnerBinary(runnerDir)) && existsSync(join(runnerDir, 'checksums.json'));

/** Stands in for ssh: skips options, takes the host, and runs the rest as a shell command here, with HOME at FAKE_SSH_HOME. */
const FAKE_SSH = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
let i = 0;
while (i < args.length && args[i].startsWith('-')) i += args[i] === '-o' || args[i] === '-p' || args[i] === '-i' ? 2 : 1;
const host = args[i++];
if (host === 'down') { process.stderr.write('ssh: connect to host down port 22: Connection refused\\n'); process.exit(255); }
const child = spawn('/bin/sh', ['-c', args.slice(i).join(' ')], { stdio: 'inherit', env: { ...process.env, HOME: process.env.FAKE_SSH_HOME } });
child.on('close', (code) => process.exit(code ?? 1));
`;

let dir: string;
let lending: DeviceLending;
const connection = { name: 'Box', host: 'build@box', port: null, keyPath: null };

function services() {
  return deviceServices({
    deviceName: 'Laptop',
    lending: async () => lending,
    scratchDir: join(dir, 'scratch'),
    runnerDir: built ? runnerDir : null,
    ssh: join(dir, 'fake-ssh.mjs'),
    sshDir: join(dir, 'ssh'),
  });
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-services-')));
  lending = { ...NO_LENDING, scratch: false, ssh: [] };
  writeFileSync(join(dir, 'fake-ssh.mjs'), FAKE_SSH);
  chmodSync(join(dir, 'fake-ssh.mjs'), 0o755);
  mkdirSync(join(dir, 'home', 'app'), { recursive: true });
  process.env.FAKE_SSH_HOME = join(dir, 'home');
});
afterEach(() => {
  delete process.env.FAKE_SSH_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe('scratch folders lent to a server', () => {
  it('makes them only when the person allows it here, private to the account', async () => {
    const lent = services();
    await expect(lent.request({ op: 'scratch.create', user: 'ada', name: 'scratch-2026-10-25-abcdef' })).rejects.toMatchObject({ code: 'refused' });
    lending = { ...NO_LENDING, scratch: true, ssh: [] };
    const made = (await lent.request({ op: 'scratch.create', user: 'ada', name: 'scratch-2026-10-25-abcdef' })) as { root: string };
    expect(made.root).toBe(join(dir, 'scratch', 'ada', 'scratch-2026-10-25-abcdef'));
    if (process.platform !== 'win32') expect(statSync(made.root).mode & 0o777).toBe(0o700);
  });

  it('lends a runner only at exactly a scratch folder, keeping git inside it', async () => {
    lending = { ...NO_LENDING, scratch: true, ssh: [] };
    const lent = services();
    const { root } = (await lent.request({ op: 'scratch.create', user: 'ada', name: 'scratch-2026-10-25-abcdef' })) as { root: string };
    expect(await lent.scratchEnv(root)).toEqual({ GIT_CEILING_DIRECTORIES: join(dir, 'scratch', 'ada') });
    // Not the folder of all scratch folders, not an account's, not something inside one.
    expect(await lent.scratchEnv(join(dir, 'scratch'))).toBeNull();
    expect(await lent.scratchEnv(join(dir, 'scratch', 'ada'))).toBeNull();
    mkdirSync(join(root, 'deeper'));
    expect(await lent.scratchEnv(join(root, 'deeper'))).toBeNull();
    expect(await lent.scratchEnv(join(dir, 'home'))).toBeNull();
    lending = { ...NO_LENDING, scratch: false, ssh: [] };
    expect(await lent.scratchEnv(root)).toBeNull();
  });
});

describe.skipIf(!built || process.platform === 'win32')('SSH hosts lent to a server', () => {
  it('reaches only hosts the person uses from here', async () => {
    const lent = services();
    await expect(lent.request({ op: 'ssh.probe', connection, answers: { trust: false } })).rejects.toMatchObject({ code: 'refused' });
    await expect(lent.start({ kind: 'ssh', connection, answers: { trust: false }, root: '/tmp', env: {} }, () => {})).rejects.toMatchObject({ code: 'refused' });
    lending = { ...NO_LENDING, scratch: false, ssh: ['build@box'] };
    expect(await lent.request({ op: 'ssh.probe', connection, answers: { trust: false } })).toMatchObject({ code: 0, prompts: [] });
    expect(String(await lent.request({ op: 'ssh.test', connection, answers: { trust: false } })).trim()).toMatch(/\S+ \S+/);
  });

  it("starts a runner over there with this computer's runner build", async () => {
    lending = { ...NO_LENDING, scratch: false, ssh: ['build@box'] };
    const channel = await services().start({ kind: 'ssh', connection, answers: { trust: false }, root: join(dir, 'home', 'app'), env: {} }, () => {});
    const answered = new Promise<string>((resolve) => channel.onLine(resolve));
    channel.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: RUNNER_PROTOCOL_VERSION, client: { name: 'test', version: '0' } } }));
    const result = JSON.parse(await answered) as { result: { roots: string[]; home: string } };
    expect(result.result.roots[0]).toBe(join(dir, 'home', 'app'));
    expect(result.result.home).toBe(join(dir, 'home'));
    // The runner went to the host's ~/.atelier/runner.
    expect(existsSync(join(dir, 'home', '.atelier', 'runner'))).toBe(true);
    channel.kill();
    await channel.closed;
  });
});

describe('addresses lent to a server', () => {
  it('passes requests to a lent address and streams the answer back, nothing else', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/elsewhere') {
        res.writeHead(302, { location: 'http://example.com/', 'set-cookie': 'a=b' });
        return res.end();
      }
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'set-cookie': 'session=1' });
        res.write(`{"got":${JSON.stringify(body)}}\n`);
        setTimeout(() => res.end('{"done":true}\n'), 5);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const lent = services();
      const ask = (url: string, method: 'GET' | 'POST' = 'GET', body?: string) =>
        lent.start({ kind: 'http', target: 'ollama', method, url, headers: { 'content-type': 'application/json' }, ...(body ? { body: Buffer.from(body).toString('base64') } : {}) }, () => {});
      await expect(ask(`${base}/api/chat`)).rejects.toMatchObject({ code: 'refused' });
      lending = { ...NO_LENDING, http: [{ id: 'ollama', baseUrl: `${base}/api` }] };

      const channel = await ask(`${base}/api/chat`, 'POST', '{"model":"m"}');
      const lines: { head?: { status: number; headers: Record<string, string> }; chunk?: string }[] = [];
      channel.onLine((line) => lines.push(JSON.parse(line)));
      await channel.closed;
      expect(lines[0]!.head).toMatchObject({ status: 200, headers: { 'content-type': 'application/x-ndjson' } });
      expect(lines[0]!.head!.headers['set-cookie']).toBeUndefined();
      expect(lines.slice(1).map((l) => Buffer.from(l.chunk!, 'base64').toString()).join('')).toBe('{"got":"{\\"model\\":\\"m\\"}"}\n{"done":true}\n');

      // Not below the lent base, another host, or with a password in the URL: refused.
      for (const url of [`${base}/elsewhere`, `${base}/apix`, 'http://127.0.0.2:1/api/chat', `http://me:pw@127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`]) {
        await expect(ask(url)).rejects.toMatchObject({ code: 'refused' });
      }
    } finally {
      server.close();
    }
  });

  it('says which model servers answer on this computer’s default ports', async () => {
    const found = (await services().request({ op: 'providers.detect' })) as { type: string; baseUrl: string }[];
    for (const server of found) expect(['ollama', 'llamacpp', 'openai-compatible']).toContain(server.type);
  });

  it('knows what is at or below a base address', () => {
    expect(withinAddress('http://localhost:11434/api/tags', 'http://localhost:11434')).toBe(true);
    expect(withinAddress('http://localhost:11434/v1/models', 'http://localhost:11434/v1')).toBe(true);
    expect(withinAddress('http://localhost:11434/v1', 'http://localhost:11434/v1/')).toBe(true);
    expect(withinAddress('http://localhost:11434/v10', 'http://localhost:11434/v1')).toBe(false);
    expect(withinAddress('http://localhost:11435/v1', 'http://localhost:11434/v1')).toBe(false);
    expect(withinAddress('https://localhost:11434/v1', 'http://localhost:11434/v1')).toBe(false);
  });
});

describe('sockets to addresses lent to a server', () => {
  let server: WsServer;
  beforeEach(async () => {
    server = await wsServer();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await server.stop();
  });

  const lend = (baseUrl = server.http, id = 'comfy') => void (lending = { ...NO_LENDING, http: [{ id, baseUrl }] });
  type Lent = ReturnType<typeof services>;
  const open = (lent: Lent, url = `${server.ws}/ws?clientId=1`, headers: Record<string, string> = {}, target = 'comfy') => lent.start({ kind: 'ws', target, url, headers }, () => {});
  /** What the channel says, as it says it. */
  const follow = (channel: Awaited<ReturnType<typeof open>>) => {
    const lines: DeviceSocketLine[] = [];
    channel.onLine((line) => lines.push(JSON.parse(line) as DeviceSocketLine));
    return lines;
  };
  /** Opens one and waits for it to be up. */
  const connect = async (lent: Lent, url?: string, headers?: Record<string, string>) => {
    const channel = await open(lent, url, headers);
    const lines = follow(channel);
    await expect.poll(() => lines[0]).toEqual({ open: true });
    return { channel, lines, client: server.clients.at(-1)! };
  };

  it('is one of the things this computer offers', () => {
    expect(services().services).toContain('ws');
  });

  it('refuses a socket unless the person lent that very address', async () => {
    const lent = services();
    await expect(open(lent)).rejects.toMatchObject({ code: 'refused' });
    lend(server.http, 'another');
    await expect(open(lent)).rejects.toMatchObject({ code: 'refused' });
    lend(`http://127.0.0.1:${server.port + 1}`);
    await expect(open(lent)).rejects.toMatchObject({ code: 'refused' });
    expect(server.requests).toEqual([]);
    lend();
    await connect(lent);
    expect(server.clients[0]!.url).toBe('/ws?clientId=1');
  });

  it('refuses anything but a plain ws URL at or below the lent address', async () => {
    const lent = services();
    const refused = async (base: string, urls: string[]) => {
      lend(base);
      for (const url of urls) await expect(open(lent, url), url).rejects.toMatchObject({ code: 'refused' });
    };
    await refused(`${server.http}/comfy`, [
      `${server.http}/comfy/ws`, // Not a WebSocket URL.
      `wss://127.0.0.1:${server.port}/comfy/ws`, // TLS where the person lent plain HTTP.
      `${server.ws}/other`,
      `${server.ws}/comfyx`,
      `${server.ws}/comfy/../other`,
      `${server.ws}/comfy/%2e%2e/other`,
      `${server.ws}/comfy/..%2fother`,
      `${server.ws}/comfy/..%5cother`,
      `${server.ws}/comfy/ws#fragment`,
      `ws://me:pw@127.0.0.1:${server.port}/comfy/ws`,
      `ws://me@127.0.0.1:${server.port}/comfy/ws`,
      `ws://127.0.0.1:${server.port + 1}/comfy/ws`,
      `ws://127.0.0.1:${server.port}@example.com/comfy/ws`,
      'ws://example.com/comfy/ws',
      'ftp://127.0.0.1/comfy/ws',
    ]);
    await refused(`https://127.0.0.1:${server.port}`, [`${server.ws}/ws`, `https://127.0.0.1:${server.port}/ws`]); // Plain where the person lent HTTPS, and not a WebSocket URL.
    expect(server.requests).toEqual([]);
  });

  it('knows what is at or below a lent address', () => {
    expect(withinSocketAddress('ws://localhost:8188/ws?clientId=1', 'http://localhost:8188')).toBe(true);
    expect(withinSocketAddress('wss://comfy.example/ws', 'https://comfy.example')).toBe(true);
    expect(withinSocketAddress('wss://comfy.example:443/ws', 'https://comfy.example')).toBe(true);
    expect(withinSocketAddress('ws://localhost:80/ws', 'http://localhost')).toBe(true);
    expect(withinSocketAddress('ws://localhost:8188/api/ws', 'http://localhost:8188/api/')).toBe(true);
    expect(withinSocketAddress('ws://localhost:8188/api', 'http://localhost:8188/api')).toBe(true);
    expect(withinSocketAddress('ws://comfy.example:443/ws', 'https://comfy.example')).toBe(false);
    expect(withinSocketAddress('https://comfy.example/ws', 'https://comfy.example')).toBe(false);
    expect(withinSocketAddress('http://localhost:8188/ws', 'http://localhost:8188')).toBe(false);
    expect(withinSocketAddress('ws://localhost:8188/apix', 'http://localhost:8188/api')).toBe(false);
    expect(withinSocketAddress('not a url', 'http://localhost:8188')).toBe(false);
  });

  it('takes only the headers an address signs in with', async () => {
    const lent = services();
    lend();
    for (const name of ['host', 'Host', 'origin', 'cookie', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-protocol', 'x-forwarded-for', 'x-anything']) {
      await expect(open(lent, undefined, { [name]: 'x' }), name).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining(name) });
    }
    await expect(open(lent, undefined, { authorization: 'Bearer a\r\nHost: elsewhere' })).rejects.toMatchObject({ code: 'refused' });
    expect(server.requests).toEqual([]);
    await connect(lent, undefined, { Authorization: 'Bearer own' });
    expect(server.clients[0]!.headers.authorization).toBe('Bearer own');
  });

  it('carries messages each way, and says when the address closes it', async () => {
    lend();
    const { channel, lines, client } = await connect(services());
    client.text('{"type":"progress"}');
    client.binary(Buffer.from([1, 2, 3]));
    await expect.poll(() => lines.length).toBe(3);
    expect(lines.slice(1)).toEqual([{ text: '{"type":"progress"}' }, { binary: Buffer.from([1, 2, 3]).toString('base64') }]);
    channel.send(JSON.stringify({ text: 'first' }));
    channel.send(JSON.stringify({ text: 'second' }));
    await expect.poll(() => client.received).toEqual(['first', 'second']);
    client.close();
    await channel.closed;
    expect(lines.at(-1)).toEqual({ close: true });
  });

  it('closes it when the channel closes', async () => {
    lend();
    const { channel, client } = await connect(services());
    channel.kill();
    await client.closed;
    await channel.closed;
  });

  it('closes at once when the person takes the address back', async () => {
    lend();
    const lent = services();
    const { channel, lines, client } = await connect(lent);
    lending = { ...NO_LENDING };
    await lent.lendingChanged();
    expect(lines.at(-1)).toMatchObject({ code: 'refused' });
    await channel.closed;
    await client.closed;
  });

  it('closes when the lent address moves away from it', async () => {
    lend(`${server.http}/comfy`);
    const lent = services();
    const { channel, lines } = await connect(lent, `${server.ws}/comfy/ws`);
    lend(`${server.http}/elsewhere`);
    await lent.lendingChanged();
    expect(lines.at(-1)).toMatchObject({ code: 'refused' });
    await channel.closed;
  });

  it('leaves sockets to addresses still lent alone', async () => {
    lend();
    const lent = services();
    const { channel, lines } = await connect(lent);
    await lent.lendingChanged();
    expect(lines).toEqual([{ open: true }]);
    channel.kill();
  });

  it('reads the lending again before each thing the server sends', async () => {
    lend();
    const { channel, lines, client } = await connect(services());
    lending = { ...NO_LENDING };
    channel.send(JSON.stringify({ text: 'still here?' }));
    await channel.closed;
    expect(lines.at(-1)).toMatchObject({ code: 'refused' });
    expect(client.received).toEqual([]);
  });

  it('reads the lending again on a timer for a socket that only listens', async () => {
    lend();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { channel, lines } = await connect(services());
    lending = { ...NO_LENDING };
    await vi.advanceTimersByTimeAsync(5_000);
    await channel.closed;
    expect(lines.at(-1)).toMatchObject({ code: 'refused' });
  });

  it('fails closed when what is lent can’t be read', async () => {
    lend();
    let broken = false;
    const lent = deviceServices({ deviceName: 'Laptop', lending: async () => (broken ? Promise.reject(new Error('gone')) : lending), scratchDir: join(dir, 'scratch'), runnerDir: null, ssh: 'ssh', sshDir: join(dir, 'ssh') });
    const { channel, lines } = await connect(lent);
    broken = true;
    await lent.lendingChanged();
    expect(lines.at(-1)).toMatchObject({ code: 'refused' });
    await channel.closed;
  });

  it('ends a socket on a message too large for the link, from either side', async () => {
    lend();
    const lent = services();
    const fromThere = await connect(lent);
    fromThere.client.binary(Buffer.alloc(MAX_SOCKET_FRAME_BYTES + 1));
    await fromThere.channel.closed;
    expect(fromThere.lines).toEqual([{ open: true }, expect.objectContaining({ code: 'too_large' })]);

    const textThere = await connect(lent);
    textThere.client.text('é'.repeat(MAX_SOCKET_FRAME_BYTES / 2 + 1));
    await textThere.channel.closed;
    expect(textThere.lines).toEqual([{ open: true }, expect.objectContaining({ code: 'too_large' })]);

    const fromServer = await connect(lent);
    fromServer.channel.send(JSON.stringify({ text: 'x'.repeat(MAX_SOCKET_FRAME_BYTES + 1) }));
    await fromServer.channel.closed;
    expect(fromServer.lines).toEqual([{ open: true }, expect.objectContaining({ code: 'too_large' })]);
    expect(fromServer.client.received).toEqual([]);
  });

  it('carries a message of exactly the largest size', async () => {
    lend();
    const { channel, lines, client } = await connect(services());
    client.binary(Buffer.alloc(MAX_SOCKET_FRAME_BYTES));
    await expect.poll(() => lines.length, { timeout: 10_000 }).toBe(2);
    expect(Buffer.from((lines[1] as { binary: string }).binary, 'base64').length).toBe(MAX_SOCKET_FRAME_BYTES);
    channel.kill();
  });

  it('holds a limit of sockets per address', async () => {
    const other = await wsServer();
    try {
      lending = { ...NO_LENDING, http: [{ id: 'comfy', baseUrl: server.http }, { id: 'forge', baseUrl: other.http }] };
      const lent = services();
      const sockets = await Promise.all(Array.from({ length: 8 }, () => open(lent)));
      await expect(open(lent)).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('8 connections') });
      // Another address has its own.
      const elsewhere = await lent.start({ kind: 'ws', target: 'forge', url: `${other.ws}/ws`, headers: {} }, () => {});
      // A closed one leaves room.
      sockets[0]!.kill();
      const again = await open(lent);
      for (const socket of [...sockets, elsewhere, again]) socket.kill();
    } finally {
      await other.stop();
    }
  });

  it('counts sockets that are still connecting, so a burst can’t pass the limit', async () => {
    lend();
    const lent = services();
    const settled = await Promise.allSettled(Array.from({ length: 12 }, () => open(lent)));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(8);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(4);
    for (const s of settled) if (s.status === 'fulfilled') s.value.kill();
  });

  it('drops what the server sends that it can’t read, and sends nothing for it', async () => {
    lend();
    const { channel, client } = await connect(services());
    for (const line of ['not json', '{}', '[]', '{"text":1}', '{"binary":"AAAA"}', '{"text":"x","more":1}', '{"close":true}']) channel.send(line);
    channel.send(JSON.stringify({ text: 'good' }));
    await expect.poll(() => client.received).toEqual(['good']);
  });

  it('won’t follow a redirect away from the lent address', async () => {
    const elsewhere = await wsServer();
    try {
      lend();
      server.refuse(`HTTP/1.1 302 Found\r\nLocation: ${elsewhere.ws}/ws\r\nContent-Length: 0\r\n\r\n`);
      const channel = await open(services());
      const lines = follow(channel);
      await channel.closed;
      expect(lines).toEqual([expect.objectContaining({ error: expect.any(String) })]);
      expect(elsewhere.requests).toEqual([]);
    } finally {
      await elsewhere.stop();
    }
  });

  it('says so when nothing answers there', async () => {
    const closed = await wsServer();
    await closed.stop();
    lend(closed.http);
    const channel = await open(services(), `${closed.ws}/ws`);
    const lines = follow(channel);
    await channel.closed;
    expect(lines).toEqual([{ error: `The connection to 127.0.0.1:${closed.port} failed.` }]);
  });

  it('gives up on an address that never finishes the handshake', async () => {
    lend();
    server.refuse('');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const channel = await open(services());
    const lines = follow(channel);
    await vi.advanceTimersByTimeAsync(15_000);
    await channel.closed;
    expect(lines.at(-1)).toMatchObject({ code: 'timeout' });
  });
});

describe('finding image servers here for a server', () => {
  it('says which image servers answer on this computer’s default ports', async () => {
    const found = (await services().request({ op: 'images.detect' })) as { preset: string; baseUrl: string }[];
    // Whatever runs on this machine, only presets' own addresses can come back.
    for (const server of found) expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('the ChatGPT window lent to a server', () => {
  it('passes calls to it only once the person allows it here', async () => {
    const calls: string[][] = [];
    const lent = deviceServices({
      deviceName: 'Laptop',
      lending: async () => lending,
      scratchDir: join(dir, 'scratch'),
      runnerDir: null,
      ssh: 'ssh',
      sshDir: join(dir, 'ssh'),
      chatgptChat: async (operation, value) => (calls.push([operation, value]), '{"signedIn":true}'),
    });
    expect(lent.services).toContain('chatgptChat');
    await expect(lent.request({ op: 'chatgptChat', operation: 'open' })).rejects.toMatchObject({ code: 'refused' });
    expect(calls).toEqual([]);
    lending = { ...NO_LENDING, chatgptChat: true };
    expect(await lent.request({ op: 'chatgptChat', operation: 'status' })).toBe('{"signedIn":true}');
    await lent.request({ op: 'chatgptChat', operation: 'start', value: '{"id":"1"}' });
    expect(calls).toEqual([
      ['status', ''],
      ['start', '{"id":"1"}'],
    ]);
  });

  it('isn’t offered where there is no ChatGPT window', async () => {
    const lent = services();
    expect(lent.services).not.toContain('chatgptChat');
    lending = { ...NO_LENDING, chatgptChat: true };
    await expect(lent.request({ op: 'chatgptChat', operation: 'status' })).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe("a person's connectors run here", () => {
  /** The MCP mock server the core tests use, over stdio. */
  const server = join(import.meta.dirname, '../mcp/__fixtures__/stdio-server.ts');
  const start = (env: Record<string, string>, args = [server]) => services().start({ kind: 'mcp', connectorId: 'c1', command: process.execPath, args, env }, () => {});
  const allow = (envKeys: string[], args = [server]) => {
    lending = { ...NO_LENDING, connectors: [{ id: 'c1', name: 'mock', fingerprint: connectorFingerprint(process.execPath, args, envKeys) }] };
  };

  it('runs only exactly the program the person allowed here', async () => {
    await expect(start({})).rejects.toMatchObject({ code: 'refused' });
    allow(['MOCK_TOKEN']);
    // Other arguments or other variables than allowed: another program, as far as this computer is concerned.
    await expect(start({ MOCK_TOKEN: 'x' }, [server, '--extra'])).rejects.toMatchObject({ code: 'refused' });
    await expect(start({ MOCK_TOKEN: 'x', OTHER: 'y' })).rejects.toMatchObject({ code: 'refused' });
    const channel = await start({ MOCK_TOKEN: 'x' });
    channel.kill();
    await channel.closed;
  });

  it('never lets a connector set what changes which code runs', async () => {
    for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PATH', 'path', 'PYTHONPATH', 'PERL5LIB', 'npm_config_registry', 'GIT_DIR']) {
      // Even when the fingerprint matches (an older desktop wrote it, or a server sent it).
      allow([key]);
      await expect(start({ [key]: '/tmp/evil' })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining(key) });
    }
    expect(() => applyLending(NO_LENDING, { kind: 'connector', id: 'c1', name: 'x', command: 'npx', args: [], envKeys: ['NODE_OPTIONS'], allowed: true })).toThrow(/NODE_OPTIONS/);
  });

  it("fills ${VAR} from this computer's environment, and speaks MCP over the channel's lines", async () => {
    allow(['MOCK_TOKEN']);
    await expect(start({ MOCK_TOKEN: '${ATELIER_TEST_MISSING}' })).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('ATELIER_TEST_MISSING') });
    process.env.ATELIER_TEST_TOKEN = 'from-this-computer';
    try {
      const channel = await start({ MOCK_TOKEN: 'Bearer ${ATELIER_TEST_TOKEN}' });
      const lines: string[] = [];
      channel.onLine((line) => lines.push(line));
      const ask = (id: number, method: string, params: object) => channel.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      await expect.poll(() => lines.length).toBe(1);
      channel.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      ask(2, 'tools/call', { name: 'whoami', arguments: {} });
      await expect.poll(() => lines.length).toBe(2);
      expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2, result: { content: [{ type: 'text', text: 'token: Bearer from-this-computer' }] } });
      channel.kill();
      await channel.closed;
    } finally {
      delete process.env.ATELIER_TEST_TOKEN;
    }
  });
});

describe('the config in the home folder', () => {
  const lentHome = (home: string) => deviceServices({ deviceName: 'Laptop', lending: async () => lending, scratchDir: join(dir, 'scratch'), runnerDir: null, ssh: 'ssh', sshDir: join(dir, 'ssh'), home });

  it('is read only when the person allows it, and only what a server may read', async () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.claude', 'skills', 'notes'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: Takes notes.\n---\nWrite them down.\n');
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Be brief.\n');
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"token":"secret"}');
    const lent = lentHome(home);
    lending = { ...NO_LENDING, home: false };
    await expect(lent.request({ op: 'home.scan' })).rejects.toMatchObject({ code: 'refused' });
    lending = { ...NO_LENDING };
    const scan = (await lent.request({ op: 'home.scan' })) as { files: Record<string, string | null> };
    expect(scan.files[join(home, '.claude', 'CLAUDE.md')]).toBe('Be brief.\n');
    expect(scan.files[join(home, '.claude', 'skills', 'notes', 'SKILL.md')]).toContain('Takes notes.');
    expect(await lent.request({ op: 'home.read', path: join(home, '.claude', '.credentials.json') })).toBeNull();
  });

  it("gives Claude Code's connectors only right after the person asked for them here", async () => {
    const home = join(dir, 'home');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['docs-mcp'] } } }));
    const lent = lentHome(home);
    await expect(lent.request({ op: 'mcp.import' })).rejects.toMatchObject({ code: 'refused' });
    lent.allowImport();
    expect(await lent.request({ op: 'mcp.import' })).toMatchObject([{ name: 'docs', config: { type: 'stdio', command: 'npx', args: ['docs-mcp'] } }]);
  });
});

describe('what `http` lets a server send to a lent address', () => {
  it('refuses a way out of the base path spelled with encoded dots or slashes', () => {
    const base = 'http://proxy.lan/comfy';
    expect(withinAddress('http://proxy.lan/comfy/..%2f..%2fadmin', base)).toBe(false);
    expect(withinAddress('http://proxy.lan/comfy/%2e%2e/admin', base)).toBe(false);
    expect(withinAddress('http://proxy.lan/comfy/%2E%2E%5cadmin', base)).toBe(false);
  });

  it('keeps an encoded slash that goes nowhere, which ComfyUI and model ids need', () => {
    expect(withinAddress('http://proxy.lan/comfy/userdata/workflows%2Fmine.json', 'http://proxy.lan/comfy')).toBe(true);
  });

  it('drops headers that would pick another site behind the same address', () => {
    expect(lentHeaders({ Host: 'other.lan', Forwarded: 'x', 'X-Forwarded-Host': 'y', 'x-real-ip': '1.1.1.1', 'Proxy-Authorization': 'z', authorization: 'Bearer k', 'content-type': 'application/json' })).toEqual({ authorization: 'Bearer k', 'content-type': 'application/json' });
  });
});

describe('computer use lent to a server', () => {
  it('passes each call to main’s controller here, and is refused by a desktop that can’t use the computer', async () => {
    const calls: unknown[][] = [];
    const lent = deviceServices({
      deviceName: 'Laptop',
      lending: async () => lending,
      scratchDir: join(dir, 'scratch'),
      runnerDir: null,
      ssh: 'ssh',
      sshDir: join(dir, 'ssh'),
      computer: async (sessionId, method, params) => (calls.push([sessionId, method, params]), method === 'available' ? true : { ok: 1 }),
    });
    expect(lent.services).toContain('computer');
    expect(await lent.request({ op: 'computer', sessionId: '', method: 'available', params: {} })).toBe(true);
    expect(await lent.request({ op: 'computer', sessionId: 's1', method: 'screenshot', params: { app: 'Notes' } })).toEqual({ ok: 1 });
    expect(calls).toEqual([
      ['', 'available', {}],
      ['s1', 'screenshot', { app: 'Notes' }],
    ]);
    const without = services();
    expect(without.services).not.toContain('computer');
    await expect(without.request({ op: 'computer', sessionId: 's1', method: 'screenshot', params: {} })).rejects.toMatchObject({ code: 'unsupported' });
  });
});
