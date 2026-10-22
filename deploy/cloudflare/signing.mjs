/** Signs update packages (docs/updates.md). The format is the one the app checks: apps/desktop/src/update-signature.ts. */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_KEY = join(homedir(), '.atelier-release', 'update-signing.key');

export function signedMessage(file, sha512) {
  return Buffer.from(`atelier-update:v1\n${file}\n${sha512}`, 'utf8');
}

/** The file's sha512 as base64: what electron-builder writes into latest.yml. */
export function sha512Of(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

/** The signing key: the text in ATELIER_UPDATE_KEY_PEM (CI), else the file ATELIER_UPDATE_KEY or the default one. */
export function loadKey(path = process.env.ATELIER_UPDATE_KEY ?? DEFAULT_KEY) {
  const pem = process.env.ATELIER_UPDATE_KEY_PEM;
  return createPrivateKey(pem ? pem.replace(/\\n/g, '\n') : readFileSync(path, 'utf8'));
}

/** The base64 signature of one package. */
export function signPackage(key, name, sha512) {
  return sign(null, signedMessage(name, sha512), key).toString('base64');
}
