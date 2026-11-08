import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isSigned, newer, packageName, platformKey } from './update.ts';

describe('updates', () => {
  it('compares versions, betas before their release', () => {
    expect(newer('0.6.0', '0.5.2')).toBe(true);
    expect(newer('0.5.10', '0.5.9')).toBe(true);
    expect(newer('0.5.2', '0.5.2')).toBe(false);
    expect(newer('0.6.0', '0.6.0-beta.2')).toBe(true);
    expect(newer('0.6.0-beta.3', '0.6.0-beta.2')).toBe(true);
    expect(newer('v1.0.0', '0.9.9')).toBe(true);
  });

  it('names packages per platform', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('win32', 'x64')).toBe('windows-x64');
    expect(packageName('0.6.0', 'linux-x64')).toBe('atelier-cli-0.6.0-linux-x64.tar.gz');
    expect(packageName('0.6.0', 'windows-arm64')).toBe('atelier-cli-0.6.0-windows-arm64.zip');
  });

  it('takes only a package signed with the release key, for that name and hash', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const signature = sign(null, Buffer.from('atelier-update:v1\natelier-cli-0.6.0-darwin-arm64.tar.gz\nabc=='), privateKey).toString('base64');
    expect(isSigned('atelier-cli-0.6.0-darwin-arm64.tar.gz', 'abc==', signature, raw)).toBe(true);
    expect(isSigned('atelier-cli-0.6.0-darwin-arm64.tar.gz', 'abd==', signature, raw)).toBe(false);
    expect(isSigned('other.tar.gz', 'abc==', signature, raw)).toBe(false);
    expect(isSigned('atelier-cli-0.6.0-darwin-arm64.tar.gz', 'abc==', signature)).toBe(false);
  });
});
