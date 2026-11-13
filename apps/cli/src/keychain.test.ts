import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { credentialStore, forgetStores, tokenName } from './keychain.ts';

let dir = '';
afterEach(async () => dir && (await rm(dir, { recursive: true, force: true })));

it('keeps secrets in a file only this user reads where asked to (or with no keyring)', async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-cli-keys-'));
  const file = join(dir, 'credentials.json');
  const store = await credentialStore(file, { ATELIER_CLI_CREDENTIALS: 'file' });
  expect(store.kind).toBe('file');
  const name = tokenName('https://atelier.example.com/');
  expect(name).toBe('token:atelier.example.com');
  await store.set(name, 'secret-token');
  expect(await store.get(name)).toBe('secret-token');
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [name]: 'secret-token' });
  await store.delete(name);
  expect(await (await credentialStore(file, { ATELIER_CLI_CREDENTIALS: 'file' })).get(name)).toBeNull();
});

it.skipIf(process.platform === 'win32')('trusts a socket only in a folder that is this user’s alone', async () => {
  const { checkPlace } = await import('./paths.ts');
  const { chmod, mkdir } = await import('node:fs/promises');
  dir = await mkdtemp(join(tmpdir(), 'atelier-cli-place-'));
  const run = join(dir, 'run');
  await mkdir(run, { mode: 0o700 });
  expect(await checkPlace(join(run, 'daemon.sock'))).toBeNull();
  await chmod(run, 0o777);
  expect(await checkPlace(join(run, 'daemon.sock'))).toMatch(/isn't yours alone/);
  // Someone else's folder: another user id.
  await chmod(run, 0o700);
  expect(await checkPlace(join(run, 'daemon.sock'), (process.getuid?.() ?? 0) + 1)).toMatch(/isn't yours alone/);
});

it('finds the Windows service by the random pipe name it wrote, and nothing else', async () => {
  const { newPipeName, pipeFile, servicePath } = await import('./paths.ts');
  const { mkdir, writeFile } = await import('node:fs/promises');
  dir = await mkdtemp(join(tmpdir(), 'atelier-cli-pipe-'));
  expect(await servicePath(dir, 'win32')).toBeNull();
  const name = newPipeName(dir);
  expect(name).toMatch(/^\\\\\.\\pipe\\atelier-cli-[0-9a-f]{8}-[0-9a-f]{24}$/);
  await mkdir(join(dir, 'run'));
  await writeFile(pipeFile(dir), name);
  expect(await servicePath(dir, 'win32')).toBe(name);
  await writeFile(pipeFile(dir), '\\\\.\\pipe\\someone-elses');
  expect(await servicePath(dir, 'win32')).toBeNull();
});

it.skipIf(process.platform === 'win32')('on Windows keeps what it saves: a new start reads it back (the token and the key were deleted right after saving)', async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-cli-dpapi-'));
  const file = join(dir, 'credentials.json');
  // A stand-in for PowerShell's DPAPI: seals as base64, unseals back.
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'powershell.exe'),
    `#!${process.execPath}\nlet s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{const t=s.trim();process.stdout.write(process.argv.join(' ').includes('Unprotect')?Buffer.from(t,'base64').toString():Buffer.from(t).toString('base64'));});\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  try {
    const first = await credentialStore(file, {}, 'win32');
    expect(first.kind).toBe('dpapi');
    await first.set('token:atelier.example.com', 'secret-token');
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    expect(saved['token:atelier.example.com']).toBe(`dpapi:${Buffer.from('secret-token').toString('base64')}`);
    // A new start: a fresh store reads it back.
    forgetStores();
    expect(await (await credentialStore(file, {}, 'win32')).get('token:atelier.example.com')).toBe('secret-token');
  } finally {
    process.env.PATH = path;
  }
});
