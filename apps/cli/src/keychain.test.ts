import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { credentialStore, tokenName } from './keychain.ts';

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
