/**
 * The desktop app's backend runs on Electron's Node, which is built on BoringSSL, and BoringSSL lacks some of
 * OpenSSL's ciphers (`chacha20-poly1305` among them: a guest's backend once crashed on it). Co-op's crypto has to run
 * on both, so this pins what coop/ may use: which `node:crypto` functions it imports, the algorithm names it passes
 * them (read from the source, and seen while the code runs), and the Web Crypto it calls. Everything allowed here
 * was checked on Electron 44. Adding to a list means checking the new name there first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, HandshakeState, CIPHER } from './noise.ts';
import { fingerprint, makeInvite, pskFromSecret } from './invite.ts';
import { hashToken, newRoomId } from './relay-protocol.ts';

const ALLOWED = {
  imports: ['createCipheriv', 'createDecipheriv', 'createHash', 'createHmac', 'createPrivateKey', 'createPublicKey', 'diffieHellman', 'generateKeyPairSync', 'hkdfSync', 'randomBytes', 'randomUUID', 'KeyObject'],
  ciphers: ['aes-256-gcm'],
  hashes: ['sha256'],
  keyTypes: ['x25519'],
  webCrypto: ['getRandomValues', 'subtle.digest'],
  digests: ['SHA-256'],
};

const seen = vi.hoisted(() => ({ ciphers: new Set<string>(), hashes: new Set<string>(), keyTypes: new Set<string>() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  type Fn = (...args: unknown[]) => unknown;
  /** Notes the algorithm (the first argument) and calls the real function. */
  const named = (fn: unknown, into: Set<string>) => (...args: unknown[]) => {
    into.add(String(args[0]));
    return (fn as Fn)(...args);
  };
  /** Notes the type of the key the real function returns, or is given. */
  const keyed = (fn: unknown, keyOf: (args: unknown[], result: unknown) => unknown) => (...args: unknown[]) => {
    const result = (fn as Fn)(...args);
    seen.keyTypes.add(String((keyOf(args, result) as { asymmetricKeyType?: string } | undefined)?.asymmetricKeyType));
    return result;
  };
  return {
    ...actual,
    createCipheriv: named(actual.createCipheriv, seen.ciphers),
    createDecipheriv: named(actual.createDecipheriv, seen.ciphers),
    createHash: named(actual.createHash, seen.hashes),
    createHmac: named(actual.createHmac, seen.hashes),
    hkdfSync: named(actual.hkdfSync, seen.hashes),
    generateKeyPairSync: named(actual.generateKeyPairSync, seen.keyTypes),
    createPrivateKey: keyed(actual.createPrivateKey, (_, key) => key),
    createPublicKey: keyed(actual.createPublicKey, (_, key) => key),
    diffieHellman: keyed(actual.diffieHellman, ([options]) => (options as { privateKey: unknown }).privateKey),
  };
});

const dir = import.meta.dirname;
const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));

/** Every match of `pattern`'s first group, per file. */
const found = (pattern: RegExp) => sources.flatMap(({ name, text }) => [...text.matchAll(pattern)].map((m) => ({ name, value: m[1]!.trim() })));

describe("co-op's crypto runs on Electron's BoringSSL as well as on OpenSSL", () => {
  it('reads the sources it checks', () => {
    expect(sources.map((s) => s.name)).toEqual(expect.arrayContaining(['noise.ts', 'invite.ts', 'channel.ts', 'relay-protocol.ts', 'relay-node.ts']));
  });

  it('imports only allowed node:crypto functions, and only from node:crypto', () => {
    const imported = found(/import\s*\{([^}]*)\}\s*from\s*'node:crypto'/g).flatMap(({ name, value }) =>
      value
        .split(',')
        .map((part) => part.replace(/^\s*type\s+/, '').trim())
        .filter(Boolean)
        .map((fn) => ({ name, fn })),
    );
    expect(imported.length).toBeGreaterThan(0);
    for (const { name, fn } of imported) expect(ALLOWED.imports, `${name} imports ${fn}`).toContain(fn);
    expect(found(/from\s*'(crypto)'/g), "import from 'node:crypto' instead").toEqual([]);
    expect(found(/require\(\s*'((?:node:)?crypto)'/g)).toEqual([]);
  });

  it('names only allowed algorithms in its calls', () => {
    // Ciphers go through one constant, so a new cipher name can only come in by changing it.
    expect(found(/\bcreate(?:De)?[cC]ipheriv\(\s*([^,]+),/g).map((f) => f.value)).toEqual(['CIPHER', 'CIPHER']);
    expect(ALLOWED.ciphers).toContain(CIPHER);
    const hashes = found(/\b(?:createHash|createHmac|hkdfSync)\(\s*([^,)]+)/g);
    expect(hashes.length).toBeGreaterThan(0);
    for (const { name, value } of hashes) expect(ALLOWED.hashes.map((h) => `'${h}'`), `${name}: ${value}`).toContain(value);
    for (const { name, value } of found(/\bgenerateKeyPairSync\(\s*([^,)]+)/g)) expect(ALLOWED.keyTypes.map((k) => `'${k}'`), `${name}: ${value}`).toContain(value);
  });

  it('calls only allowed Web Crypto, with allowed digests', () => {
    const calls = found(/\bcrypto\.((?:subtle\.)?\w+)\(/g);
    expect(calls.length).toBeGreaterThan(0);
    for (const { name, value } of calls) expect(ALLOWED.webCrypto, `${name}: crypto.${value}`).toContain(value);
    for (const { name, value } of found(/\bsubtle\.digest\(\s*([^,)]+)/g)) expect(ALLOWED.digests.map((d) => `'${d}'`), `${name}: ${value}`).toContain(value);
  });

  it('uses only allowed algorithms while it runs: a handshake, transport messages, an invite and a fingerprint', async () => {
    const psk = pskFromSecret(makeInvite(newRoomId()).secret);
    const guest = new HandshakeState({ initiator: true, staticKey: generateKeyPair(), psk });
    const host = new HandshakeState({ initiator: false, staticKey: generateKeyPair() });
    host.readMessage(guest.writeMessage());
    guest.readMessage(host.writeMessage());
    const done = host.fork(psk);
    done.readMessage(guest.writeMessage(new TextEncoder().encode('{"name":"Ada","version":"1"}')));
    const g = guest.split();
    const h = done.split();
    expect(new TextDecoder().decode(h.receive.decrypt(g.send.encrypt(new TextEncoder().encode('hi'))))).toBe('hi');
    expect(fingerprint(done.handshakeHash)).toEqual(fingerprint(guest.handshakeHash));
    await hashToken('token');

    expect([...seen.ciphers]).toEqual(['aes-256-gcm']);
    for (const hash of seen.hashes) expect(ALLOWED.hashes).toContain(hash);
    expect(seen.hashes.size).toBeGreaterThan(0);
    expect([...seen.keyTypes]).toEqual(['x25519']);
  });
});
