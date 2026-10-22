/**
 * Runs every runner protocol v1 method against the real binary for this host.
 * Build it first with `pnpm runner:build` (all targets) or `pnpm --filter @atelier/core test:conformance`
 * (host only, then this suite); without a build the suite is skipped.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RpcError,
  RunnerErrorCode,
  type FsChangedNotification,
  type PtyExitNotification,
  type RunnerMethod,
} from '@atelier/protocol';
import { hostRunnerBinary, RunnerClient } from './runner-client.ts';

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));
const built = existsSync(binary);
if (!built) console.warn(`runner conformance suite skipped: ${binary} is not built; run \`pnpm runner:build\` first`);

const isWindows = process.platform === 'win32';

const METHODS: RunnerMethod[] = [
  'initialize',
  'shutdown',
  'sys.info',
  'sys.ping',
  'sys.addRoot',
  'fs.stat',
  'fs.read',
  'fs.write',
  'fs.list',
  'fs.mkdir',
  'fs.remove',
  'fs.rename',
  'fs.readAncestors',
  'fs.glob',
  'fs.grep',
  'fs.watch',
  'fs.unwatch',
  'shell.open',
  'shell.exec',
  'shell.read',
  'shell.kill',
  'shell.close',
  'proc.exec',
  'pty.open',
  'pty.write',
  'pty.resize',
  'pty.close',
];

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

function writeTree(base: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(base, ...name.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!built)('runner conformance', { timeout: 30_000 }, () => {
  let tmp: string;
  let client: RunnerClient;
  let root: string;
  const at = (...parts: string[]) => join(root, ...parts);

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'atelier-conformance-'));
    writeTree(join(tmp, 'workspace'), {
      '.gitignore': 'dist/\n',
      'CLAUDE.md': 'workspace instructions\n',
      'README.md': '# Fixture\nhello world\n',
      'src/index.ts': "export const greeting = 'hello';\n// TODO: wave\n",
      'src/util.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
      'dist/bundle.js': 'hello from dist\n',
    });
    writeTree(join(tmp, 'outside'), { 'secret.txt': 'secret\n' });
    writeTree(join(tmp, 'extra'), { 'note.txt': 'extra root\n' });
    client = await RunnerClient.spawn({
      binaryPath: binary,
      roots: [join(tmp, 'workspace')],
      client: { name: 'conformance', version: '1' },
    });
    root = client.info.roots[0]!;
  });

  afterAll(async () => {
    await client?.shutdown();
    // Windows lets go of a folder a moment after the process that had it open is gone (or doesn't: it is a temp folder).
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        if (process.platform !== 'win32') throw error;
      }
    }
  });

  describe('sys', () => {
    it('initialize reports the host, the roots and every method', () => {
      const { info } = client;
      expect(info.protocolVersion).toBe(1);
      expect(info.os).toBe(isWindows ? 'windows' : process.platform);
      expect(info.arch).toBe(process.arch === 'x64' ? 'amd64' : process.arch);
      expect(info.roots).toHaveLength(2);
      // Only the skills cache of ~/.atelier, never the rest (the desktop's data folder lives there).
      expect(info.roots[1]!.toLowerCase().endsWith(`${sep}.atelier${sep}skills-cache`)).toBe(true);
      expect(info.home).toBe(homedir());
      expect(info.pathSep).toBe(sep);
      expect(info.shell).not.toBe('');
      expect([...info.capabilities.methods].sort()).toEqual([...METHODS].sort());
      expect(['bash', 'sh', 'powershell']).toContain(info.capabilities.execShell);
    });

    it('requires initialize first and rejects a protocol version mismatch with -32020', async () => {
      const child = spawn(binary, ['--stdio', '--root', root], { windowsHide: true });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const next = async () =>
        JSON.parse((await lines.next()).value as string) as { error?: { code: number; data: { code: string } } };
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"sys.ping"}\n');
      expect((await next()).error?.code).toBe(RunnerErrorCode.NotInitialized);
      child.stdin.write(
        '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":999,"client":{"name":"t","version":"0"}}}\n',
      );
      const reply = await next();
      expect(reply.error?.code).toBe(RunnerErrorCode.VersionMismatch);
      expect(reply.error?.data.code).toBe('VersionMismatch');
      child.kill();
    });

    it('sys.info and sys.ping', async () => {
      const info = await client.call('sys.info', {});
      expect(info.os).toBe(client.info.os);
      expect(info.cpu.count).toBeGreaterThan(0);
      expect(info.mem.total).toBeGreaterThan(0);
      expect(info.disk.total).toBeGreaterThan(0);
      expect(info.disk.path).toBe(root);
      expect(info.load === null).toBe(isWindows);
      expect(info.defaultShell).not.toBe('');
      if (!isWindows) expect(info.gitBash).toBeNull();
      const { time } = await client.call('sys.ping', {});
      expect(Math.abs(time - Date.now())).toBeLessThan(60_000);
    });

    it('sys.addRoot widens the workspace', async () => {
      const note = join(tmp, 'extra', 'note.txt');
      expect((await failure(client.call('fs.read', { path: note }))).code).toBe(RunnerErrorCode.PathOutsideWorkspace);
      const { roots } = await client.call('sys.addRoot', { path: join(tmp, 'extra') });
      expect(roots).toHaveLength(3);
      expect((await client.call('fs.read', { path: note })).content).toBe('extra root\n');
    });
  });

  describe('fs', () => {
    it('fs.write, fs.read and fs.stat with optimistic concurrency', async () => {
      const created = await client.call('fs.write', {
        path: 'notes/a.txt',
        content: 'one\ntwo\nthree\n',
        mkdirp: true,
      });
      expect(created.created).toBe(true);
      const read = await client.call('fs.read', { path: at('notes', 'a.txt') });
      expect(read).toMatchObject({
        content: 'one\ntwo\nthree\n',
        sha256: created.sha256,
        totalLines: 3,
        truncated: false,
        binary: false,
      });
      expect(await client.call('fs.read', { path: 'notes/a.txt', offset: 1, limit: 1 })).toMatchObject({
        content: 'two\n',
        truncated: true,
      });

      const updated = await client.call('fs.write', {
        path: 'notes/a.txt',
        content: 'changed\n',
        expectSha256: read.sha256,
      });
      expect(updated.created).toBe(false);
      const conflict = await failure(
        client.call('fs.write', { path: 'notes/a.txt', content: 'stale\n', expectSha256: read.sha256 }),
      );
      expect(conflict.code).toBe(RunnerErrorCode.Conflict);
      expect(conflict.data).toMatchObject({ code: 'Conflict', actualSha256: updated.sha256 });

      const bytes = Buffer.from([0, 1, 2, 250, 255]);
      await client.call('fs.write', { path: 'notes/blob.bin', content: bytes.toString('base64'), encoding: 'base64' });
      expect(await client.call('fs.read', { path: 'notes/blob.bin' })).toMatchObject({
        binary: true,
        content: '',
        size: 5,
      });
      expect((await client.call('fs.read', { path: 'notes/blob.bin', encoding: 'base64' })).content).toBe(
        bytes.toString('base64'),
      );

      const stat = await client.call('fs.stat', { path: 'notes/a.txt' });
      expect(stat).toMatchObject({ path: at('notes', 'a.txt'), type: 'file', size: 8 });
      const missing = await failure(client.call('fs.stat', { path: 'notes/missing.txt' }));
      expect(missing.code).toBe(RunnerErrorCode.IO);
      expect(missing.data?.code).toBe('ENOENT');
    });

    it('fs.list, fs.mkdir, fs.rename and fs.remove', async () => {
      const top = await client.call('fs.list', { path: root, depth: 1, respectGitignore: true });
      const names = top.entries.map((e) => `${e.name}:${e.type}`);
      expect(names).toContain('src:dir');
      expect(names).toContain('README.md:file');
      expect(names).not.toContain('dist:dir');
      const all = await client.call('fs.list', { path: root, depth: 2 });
      expect(all.entries.map((e) => e.path)).toContain(at('dist', 'bundle.js'));

      await client.call('fs.mkdir', { path: 'tmp/a/b', recursive: true });
      await client.call('fs.write', { path: 'tmp/a/b/f.txt', content: 'x' });
      await client.call('fs.rename', { from: 'tmp/a/b/f.txt', to: 'tmp/g.txt' });
      expect((await client.call('fs.read', { path: 'tmp/g.txt' })).content).toBe('x');
      await client.call('fs.write', { path: 'tmp/h.txt', content: 'y' });
      expect((await failure(client.call('fs.rename', { from: 'tmp/g.txt', to: 'tmp/h.txt' }))).data?.code).toBe(
        'EEXIST',
      );
      await client.call('fs.rename', { from: 'tmp/g.txt', to: 'tmp/h.txt', overwrite: true });
      expect((await failure(client.call('fs.remove', { path: 'tmp' }))).data?.code).toBe('ENOTEMPTY');
      await client.call('fs.remove', { path: 'tmp', recursive: true });
      expect((await failure(client.call('fs.stat', { path: 'tmp' }))).data?.code).toBe('ENOENT');
      expect((await failure(client.call('fs.remove', { path: root, recursive: true }))).data?.code).toBe('EPERM');
    });

    it('fs.readAncestors reads only instruction files, walking up from inside a root', async () => {
      const { files } = await client.call('fs.readAncestors', { from: 'src' });
      expect(files.find((f) => f.path === at('CLAUDE.md'))?.content).toBe('workspace instructions\n');
      expect(files.every((f) => /(CLAUDE|AGENTS|ATELIER|CLAUDE\.local)\.md$/.test(f.path))).toBe(true);
      // None found is an empty list, never null.
      expect((await client.call('fs.readAncestors', { from: 'src', names: ['CLAUDE.local.md'] })).files).toEqual([]);
      const bad = await failure(client.call('fs.readAncestors', { from: 'src', names: ['secret.txt' as 'CLAUDE.md'] }));
      expect(bad.code).toBe(RunnerErrorCode.InvalidParams);
    });

    it('rejects every path outside the workspace with -32010', async () => {
      const secret = join(tmp, 'outside', 'secret.txt');
      const calls = [
        client.call('fs.read', { path: secret }),
        client.call('fs.read', { path: '../outside/secret.txt' }),
        client.call('fs.write', { path: 'src/../../outside/new.txt', content: 'x' }),
        client.call('fs.list', { path: join(tmp, 'outside'), depth: 1 }),
        client.call('fs.glob', { pattern: '../outside/*' }),
        client.call('fs.grep', { pattern: 'secret', path: join(tmp, 'outside') }),
        client.call('fs.watch', { path: join(tmp, 'outside') }),
        client.call('shell.open', { cwd: join(tmp, 'outside') }),
        client.call('proc.exec', { argv: [process.execPath, '-v'], cwd: join(tmp, 'outside') }),
        client.call('pty.open', { cwd: join(tmp, 'outside') }),
      ];
      for (const error of await Promise.all(calls.map(failure))) {
        expect(error.code).toBe(RunnerErrorCode.PathOutsideWorkspace);
      }
      try {
        symlinkSync(join(tmp, 'outside'), at('escape'), 'dir');
      } catch (error) {
        if (isWindows) return; // creating symlinks needs Developer Mode or admin rights there
        throw error;
      }
      expect((await failure(client.call('fs.read', { path: 'escape/secret.txt' }))).code).toBe(
        RunnerErrorCode.PathOutsideWorkspace,
      );
      await client.call('fs.remove', { path: 'escape' }); // the link itself lives inside the root
      expect(existsSync(join(tmp, 'outside', 'secret.txt'))).toBe(true);
    });
  });

  describe('search', () => {
    it('fs.glob honors .gitignore and sorts newest first', async () => {
      await client.call('fs.write', { path: 'src/newest.ts', content: 'export {};\n' });
      const { files, truncated } = await client.call('fs.glob', { pattern: '**/*.ts' });
      expect(files[0]).toBe(at('src', 'newest.ts'));
      expect([...files].sort()).toEqual([at('src', 'index.ts'), at('src', 'newest.ts'), at('src', 'util.ts')]);
      expect(truncated).toBe(false);
      expect((await client.call('fs.glob', { pattern: '*.ts', cwd: 'src', limit: 1 })).truncated).toBe(true);
      expect((await client.call('fs.glob', { pattern: 'dist/*.js' })).files).toEqual([at('dist', 'bundle.js')]);
      await client.call('fs.remove', { path: 'src/newest.ts' });
    });

    it('fs.grep in files, content and count modes', async () => {
      const files = await client.call('fs.grep', { pattern: 'hello' });
      expect([...files.files].sort()).toEqual([at('README.md'), at('src', 'index.ts')]);
      expect(files.outputMode).toBe('files');

      const content = await client.call('fs.grep', {
        pattern: 'todo',
        caseInsensitive: true,
        outputMode: 'content',
        lineNumbers: true,
        before: 1,
        type: 'ts',
      });
      expect(content.lines).toEqual([
        `${at('src', 'index.ts')}-1-export const greeting = 'hello';`,
        `${at('src', 'index.ts')}:2:// TODO: wave`,
      ]);

      const count = await client.call('fs.grep', { pattern: 'a', outputMode: 'count', glob: '*.ts' });
      expect(count.counts).toEqual([
        { path: at('src', 'index.ts'), count: 1 },
        { path: at('src', 'util.ts'), count: 2 },
      ]);
      const multi = await client.call('fs.grep', {
        pattern: 'add.*\\n.*return',
        multiline: true,
        outputMode: 'content',
        path: 'src/util.ts',
      });
      expect(multi.lines).toEqual(['export function add(a: number, b: number) {', '  return a + b;']);
      expect((await failure(client.call('fs.grep', { pattern: '(' }))).code).toBe(RunnerErrorCode.InvalidParams);
    });
  });

  describe('watch', () => {
    it('fs.watch reports debounced fs.changed events until fs.unwatch', async () => {
      const batches: FsChangedNotification[] = [];
      const off = client.on('fs.changed', (n) => batches.push(n));
      const { watchId } = await client.call('fs.watch', { path: root, recursive: true });
      await client.call('fs.write', { path: 'src/watched.ts', content: '1' });
      const event = await waitFor(
        () =>
          batches
            .flatMap((b) => (b.watchId === watchId ? b.events : []))
            .find((e) => e.path === at('src', 'watched.ts')),
        'fs.changed',
      );
      expect(['create', 'write', 'rename']).toContain(event.op);
      await client.call('fs.unwatch', { watchId });
      await client.call('fs.remove', { path: 'src/watched.ts' });
      off();
    });
  });

  describe('shell', () => {
    it('streams output, keeps cwd between commands and drops exports', async () => {
      const { shellId, cwd } = await client.call('shell.open', { env: { ATELIER_CONFORMANCE: 'on' } });
      expect(cwd).toBe(root);
      const chunks: string[] = [];
      const off = client.on('shell.output', (n) => n.execId === 'stream-1' && chunks.push(n.chunk));
      const first = await client.call('shell.exec', {
        shellId,
        execId: 'stream-1',
        command: 'cd src && export FOO=1 && echo "$ATELIER_CONFORMANCE" && echo err >&2',
      });
      off();
      expect(first).toMatchObject({
        execId: 'stream-1',
        exitCode: 0,
        cwd: at('src'),
        timedOut: false,
        truncated: false,
      });
      expect(first.output).toBe('on\nerr\n');
      expect(chunks.join('')).toBe(first.output);

      const second = await client.call('shell.exec', {
        shellId,
        command: 'echo "FOO=${FOO:-unset}"; ls index.ts; exit 4',
      });
      expect(second).toMatchObject({ exitCode: 4, cwd: at('src'), output: 'FOO=unset\nindex.ts\n' });

      const timedOut = await client.call('shell.exec', { shellId, command: 'sleep 30', timeoutMs: 300 });
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.exitCode).not.toBe(0);
      expect(timedOut.durationMs).toBeLessThan(10_000);
      await client.call('shell.close', { shellId });
    });

    it('runs background commands readable with shell.read until shell.kill', async () => {
      const { shellId } = await client.call('shell.open', {});
      const started = await client.call('shell.exec', { shellId, command: 'echo ready; sleep 30', background: true });
      expect(started.exitCode).toBeNull();
      const { execId } = started;
      let offset = 0;
      let output = '';
      const deadline = Date.now() + 10_000;
      while (!output.includes('ready')) {
        if (Date.now() > deadline) throw new Error('no background output');
        const r = await client.call('shell.read', { execId, sinceOffset: offset });
        expect(r.running).toBe(true);
        output += r.output;
        offset = r.offset;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await client.call('shell.kill', { execId })).killed).toBe(true);
      for (;;) {
        const r = await client.call('shell.read', { execId, sinceOffset: 0 });
        if (!r.running) {
          expect(r.output).toBe('ready\n');
          expect(r.exitCode).not.toBe(0);
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      await client.call('shell.close', { shellId });
      expect((await failure(client.call('shell.read', { execId, sinceOffset: 0 }))).code).toBe(
        RunnerErrorCode.ShellRestarted,
      );
      expect((await failure(client.call('shell.exec', { shellId, command: 'true' }))).code).toBe(
        RunnerErrorCode.ShellRestarted,
      );
      expect((await failure(client.call('shell.kill', { execId: 'never-existed' }))).code).toBe(
        RunnerErrorCode.ShellRestarted,
      );
    });

    it('$/cancel from an AbortSignal kills the running command', async () => {
      const { shellId } = await client.call('shell.open', {});
      const controller = new AbortController();
      const running = client.call('shell.exec', { shellId, command: 'sleep 30' }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      expect((await failure(running)).code).toBe(RunnerErrorCode.Cancelled);
      // The shell runs one foreground command at a time, so this only returns once the runner killed sleep.
      const started = Date.now();
      expect((await client.call('shell.exec', { shellId, command: 'echo after' })).output).toBe('after\n');
      expect(Date.now() - started).toBeLessThan(10_000);

      const aborted = new AbortController();
      const proc = client.call(
        'proc.exec',
        { argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'] },
        { signal: aborted.signal },
      );
      setTimeout(() => aborted.abort(), 300);
      expect((await failure(proc)).code).toBe(RunnerErrorCode.Cancelled);
      await client.call('shell.close', { shellId });
    });
  });

  describe('proc', () => {
    it('proc.exec runs argv without a shell', async () => {
      const script =
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s.toUpperCase()+process.env.ATELIER_X+process.cwd());process.stderr.write("warn");process.exit(3)})';
      const res = await client.call('proc.exec', {
        argv: [process.execPath, '-e', script],
        cwd: 'src',
        env: { ATELIER_X: '|x|' },
        stdin: 'piped',
      });
      expect(res).toMatchObject({
        exitCode: 3,
        stdout: `PIPED|x|${at('src')}`,
        stderr: 'warn',
        timedOut: false,
        truncated: false,
      });
      const literal = await client.call('proc.exec', {
        argv: [process.execPath, '-e', 'console.log(process.argv[1])', '$HOME;`id`'],
      });
      expect(literal.stdout).toBe('$HOME;`id`\n');
      const slow = await client.call('proc.exec', {
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'],
        timeoutMs: 300,
      });
      expect(slow.timedOut).toBe(true);
      expect((await failure(client.call('proc.exec', { argv: ['atelier-no-such-binary'] }))).data?.code).toBe('ENOENT');
    });
  });

  describe('pty', () => {
    it('pty.open streams a terminal session until pty.exit', async () => {
      let output = '';
      const exits: PtyExitNotification[] = [];
      const { ptyId, pid } = await client.call('pty.open', {
        cols: 100,
        rows: 30,
        shell: isWindows ? 'cmd.exe' : '/bin/sh',
      });
      expect(pid).toBeGreaterThan(0);
      const offData = client.on(
        'pty.data',
        (n) => n.ptyId === ptyId && (output += Buffer.from(n.b64, 'base64').toString()),
      );
      const offExit = client.on('pty.exit', (n) => exits.push(n));
      if (isWindows) {
        await client.call('pty.write', { ptyId, data: 'echo pty-ok\r\n' });
        await waitFor(() => (output.includes('pty-ok') ? true : undefined), 'pty output');
        await client.call('pty.resize', { ptyId, cols: 120, rows: 40 });
        await client.call('pty.write', { ptyId, data: 'exit 7\r\n' });
      } else {
        await client.call('pty.write', { ptyId, data: 'echo pty-ok; stty size\n' });
        await waitFor(() => (output.includes('30 100') ? true : undefined), 'pty output');
        await client.call('pty.resize', { ptyId, cols: 120, rows: 40 });
        await client.call('pty.write', {
          ptyId,
          data: Buffer.from('stty size; exit 7\n').toString('base64'),
          encoding: 'base64',
        });
        await waitFor(() => (output.includes('40 120') ? true : undefined), 'resized pty');
      }
      const exit = await waitFor(() => exits.find((e) => e.ptyId === ptyId), 'pty.exit');
      expect(exit.code).toBe(7);
      expect((await failure(client.call('pty.write', { ptyId, data: 'x' }))).code).toBe(RunnerErrorCode.ShellRestarted);

      const second = await client.call('pty.open', {});
      await client.call('pty.close', { ptyId: second.ptyId });
      await waitFor(() => exits.find((e) => e.ptyId === second.ptyId), 'pty.exit after close');
      offData();
      offExit();
    });
  });

  describe('lifecycle', () => {
    it('shutdown exits the runner, and a dead runner is detected', async () => {
      const other = await RunnerClient.spawn({ binaryPath: binary, roots: [root] });
      expect(other.alive).toBe(true);
      expect(await other.shutdown()).toEqual({ code: 0, signal: null });
      expect(other.alive).toBe(false);

      const doomed = await RunnerClient.spawn({ binaryPath: binary, roots: [root] });
      const pending = doomed
        .call('shell.open', {})
        .then((r) => doomed.call('shell.exec', { shellId: r.shellId, command: 'sleep 30' }));
      setTimeout(() => doomed.kill(), 300);
      await expect(pending).rejects.toBeInstanceOf(RpcError);
      expect((await doomed.exited).code === 0).toBe(false);
      await expect(doomed.call('sys.ping', {})).rejects.toBeInstanceOf(RpcError);

      await expect(
        RunnerClient.spawn({ binaryPath: join(tmp, 'no-such-runner'), roots: [root] }),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });
});
