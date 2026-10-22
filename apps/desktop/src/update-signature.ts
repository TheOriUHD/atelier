/**
 * Update signatures: each package in a release has a sidecar `<file>.sig`, an Ed25519 signature made with the key that
 * stays on the publisher's machine (deploy/cloudflare/publish.mjs) over the package's name and sha512 as the update
 * file states them. The app checks it against the public key it ships (`APP.updatePublicKey`) before it downloads
 * anything, so a feed (or the account behind it) that is compromised cannot hand out an update of its own.
 */
import { createPublicKey, verify } from 'node:crypto';

/** The DER prefix of an Ed25519 public key (SubjectPublicKeyInfo); the 32 raw key bytes follow it. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** What is signed: the package's file name and its sha512 (base64, as in latest.yml). */
export function signedMessage(file: string, sha512: string): Buffer {
  return Buffer.from(`atelier-update:v1\n${file}\n${sha512}`, 'utf8');
}

/** Whether `signature` (base64) is `publicKey`'s (raw 32 bytes, base64) signature of that file and hash. Never throws. */
export function isSigned(publicKey: string, file: string, sha512: string, signature: string): boolean {
  try {
    const raw = Buffer.from(publicKey, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    return verify(null, signedMessage(file, sha512), key, Buffer.from(signature.trim(), 'base64'));
  } catch {
    return false;
  }
}
