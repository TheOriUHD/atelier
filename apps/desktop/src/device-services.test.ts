import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_LENDING, RUNNER_PROTOCOL_VERSION, type DeviceLending } from '@atelier/protocol';
import { hostRunnerBinary } from '@atelier/core';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deviceServices, withinAddress } from './device-services.ts';

const runnerDir = join(import.meta.dirname, '../../../runner/bin');
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

  it('knows what is at or below a base address', () => {
    expect(withinAddress('http://localhost:11434/api/tags', 'http://localhost:11434')).toBe(true);
    expect(withinAddress('http://localhost:11434/v1/models', 'http://localhost:11434/v1')).toBe(true);
    expect(withinAddress('http://localhost:11434/v1', 'http://localhost:11434/v1/')).toBe(true);
    expect(withinAddress('http://localhost:11434/v10', 'http://localhost:11434/v1')).toBe(false);
    expect(withinAddress('http://localhost:11435/v1', 'http://localhost:11434/v1')).toBe(false);
    expect(withinAddress('https://localhost:11434/v1', 'http://localhost:11434/v1')).toBe(false);
  });
});
