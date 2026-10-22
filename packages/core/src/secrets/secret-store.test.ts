import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { AesGcmCipher, loadServerKey, SecretStore } from './secret-store.ts';

let dir: string;
let db: Db;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-sec-'));
  db = openDatabase(':memory:');
});
afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe('SecretStore', () => {
  it('encrypts at rest and only exposes a masked tail', async () => {
    const key = await loadServerKey(join(dir, 'secret.key'));
    // Windows has no POSIX modes: the file is in the person's own profile, which only they (and admins) can read.
    if (process.platform !== 'win32') expect((await stat(join(dir, 'secret.key'))).mode & 0o777).toBe(0o600);
    const store = new SecretStore(db, new AesGcmCipher(key));
    const id = await store.set({ label: 'Anthropic', kind: 'api_key', value: 'sk-ant-abcdef1234' });
    expect(id).toBe('anthropic');
    const row = db.$client.prepare('SELECT ciphertext FROM secrets').get() as { ciphertext: string };
    expect(row.ciphertext).not.toContain('sk-ant');
    const [summary] = await store.list(() => ['providers.anthropic']);
    expect(summary).toMatchObject({ id: 'anthropic', masked: '••••1234', usedBy: ['providers.anthropic'] });
    expect(JSON.stringify(summary)).not.toContain('abcdef');
    expect(await store.get('anthropic')).toBe('sk-ant-abcdef1234');
  });

  it('rotates in place and allocates unique ids', async () => {
    const store = new SecretStore(db, new AesGcmCipher(Buffer.alloc(32, 7)));
    await store.set({ label: 'GitHub', kind: 'token', value: 'one1' });
    expect(await store.set({ label: 'GitHub', kind: 'token', value: 'two2' })).toBe('github-2');
    await store.set({ id: 'github', label: 'GitHub', kind: 'token', value: 'three3' });
    expect(await store.get('github')).toBe('three3');
    const rows = await store.list(() => []);
    expect(rows.find((r) => r.id === 'github')?.rotatedAt).not.toBeNull();
  });

  it('never resolves a person’s own secret for settings', async () => {
    const store = new SecretStore(db, new AesGcmCipher(Buffer.alloc(32, 2)));
    await store.set({ id: 'github-user-u1', label: 'GitHub (ada)', kind: 'github', value: 'gho_personal' });
    await store.set({ id: 'cloudflare', label: 'Cloudflare', kind: 'api_key', value: 'cf-token' });
    expect(await store.forSettings('github-user-u1')).toBeUndefined();
    expect(await store.forSettings('cloudflare')).toBe('cf-token');
    expect(await store.get('github-user-u1')).toBe('gho_personal');
  });

  it('rejects tampered ciphertext', async () => {
    const cipher = new AesGcmCipher(Buffer.alloc(32, 1));
    const ct = await cipher.encrypt('hello');
    const tampered = ct.slice(0, -4) + (ct.endsWith('A') ? 'BBBB' : 'AAAA');
    await expect(cipher.decrypt(tampered)).rejects.toThrow();
  });
});
