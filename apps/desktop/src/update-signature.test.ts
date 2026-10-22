import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error The publisher's script is plain JavaScript beside the Worker.
import { loadKey, sha512Of, signPackage } from '../../../deploy/cloudflare/signing.mjs';
import { isSigned } from './update-signature.ts';

describe('update signatures', () => {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const dir = mkdtempSync(join(tmpdir(), 'atelier-sig-'));
  const keyFile = join(dir, 'key.pem');
  writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(join(dir, 'Atelier-Setup-0.2.0.exe'), 'package bytes');

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('are made by the publisher’s script and checked by the app with the same key', () => {
    const sha = sha512Of(join(dir, 'Atelier-Setup-0.2.0.exe'));
    const signature = signPackage(loadKey(keyFile), 'Atelier-Setup-0.2.0.exe', sha);
    expect(isSigned(publicKey, 'Atelier-Setup-0.2.0.exe', sha, signature)).toBe(true);
    expect(isSigned(publicKey, 'Atelier-Setup-0.2.0.exe', sha, `${signature}\n`)).toBe(true);
  });

  it('do not cover another file, another hash, another key or garbage', () => {
    const signature = signPackage(loadKey(keyFile), 'Atelier-Setup-0.2.0.exe', 'abc');
    expect(isSigned(publicKey, 'Atelier-Setup-0.3.0.exe', 'abc', signature)).toBe(false);
    expect(isSigned(publicKey, 'Atelier-Setup-0.2.0.exe', 'abd', signature)).toBe(false);
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    expect(isSigned(other, 'Atelier-Setup-0.2.0.exe', 'abc', signature)).toBe(false);
    expect(isSigned(publicKey, 'Atelier-Setup-0.2.0.exe', 'abc', 'not a signature')).toBe(false);
    expect(isSigned('short', 'x', 'y', signature)).toBe(false);
  });
});
