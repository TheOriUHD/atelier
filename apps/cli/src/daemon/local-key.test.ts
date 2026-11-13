import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LOCAL_KEY, type CredentialStore } from '../keychain.ts';
import { localKey } from './daemon.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-local-key-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A store with what it holds, writes counted, and reads that fail on request (a slow PowerShell, a locked keychain). */
function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const s = {
    kind: 'dpapi' as const,
    failing: false,
    writes: 0,
    async get(name: string) {
      if (s.failing) throw new Error('PowerShell took too long');
      return values.get(name) ?? null;
    },
    async set(name: string, value: string) {
      s.writes++;
      values.set(name, value);
    },
    async delete(name: string) {
      values.delete(name);
    },
  };
  return s satisfies CredentialStore & { failing: boolean; writes: number };
}

it('makes the key once, and never writes a new one over a key it can’t read or that went missing', async () => {
  const check = join(dir, 'local-key.check');
  const s = store();
  const key = await localKey(s, check);
  expect(s.writes).toBe(1);
  expect((await localKey(s, check)).equals(key)).toBe(true);
  expect(s.writes).toBe(1);

  // Windows can't unseal it right now: the failure is told, the key stays.
  s.failing = true;
  await expect(localKey(s, check)).rejects.toThrow(/PowerShell took too long/);
  s.failing = false;
  expect(s.writes).toBe(1);

  // The store lost it: no new key in its place, and how to start over.
  await s.delete(LOCAL_KEY);
  await expect(localKey(s, check)).rejects.toThrow(/missing from Windows.*atelier reset-keys/);
  expect(s.writes).toBe(1);

  // Another key turned up in its place: the saved API keys can't be read with it, so it isn't used.
  await s.set(LOCAL_KEY, 'ab'.repeat(32));
  await expect(localKey(s, check)).rejects.toThrow(/changed/);
});

it('notes the key of an install from before the check, without changing it', async () => {
  const check = join(dir, 'local-key.check');
  const s = store({ [LOCAL_KEY]: 'cd'.repeat(32) });
  expect((await localKey(s, check)).toString('hex')).toBe('cd'.repeat(32));
  expect(s.writes).toBe(0);
  expect((await readFile(check, 'utf8')).trim()).toMatch(/^[0-9a-f]{32}$/);
});
