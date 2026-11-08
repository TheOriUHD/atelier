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
