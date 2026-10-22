#!/usr/bin/env node
/**
 * Writes `<package>.sig` beside every package (.exe, .dmg, .zip, .deb, .AppImage) in a folder, in the format the desktop
 * app checks (apps/desktop/src/update-signature.ts), with the update-signing key: ATELIER_UPDATE_KEY (a file), by default
 * ~/.atelier-release/update-signing.key, or ATELIER_UPDATE_KEY_PEM (the key's text, for CI).
 *
 *   node deploy/cloudflare/sign-release.mjs <folder>
 *
 * Atelier servers that mirror a GitHub release as their desktop update feed (ATELIER_UPDATES_REPO) hand out only packages
 * with a signature beside them, so the release needs the `.sig` files as assets (the release workflow attaches them when
 * the UPDATE_SIGNING_KEY secret is set; see docs/updates.md). A package replaced afterwards (a locally signed Mac build)
 * needs its signature made again. publish.mjs signs by itself when it uploads to the Cloudflare feed.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_KEY, loadKey, sha512Of, signPackage } from './signing.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node deploy/cloudflare/sign-release.mjs <folder with the packages>');
  process.exit(2);
}
let key;
try {
  key = loadKey();
} catch (e) {
  console.error(`no update-signing key (${process.env.ATELIER_UPDATE_KEY ?? DEFAULT_KEY}): ${e.message}`);
  process.exit(1);
}
const packages = readdirSync(dir).filter((n) => /\.(exe|dmg|zip|deb|AppImage)$/.test(n) && statSync(join(dir, n)).isFile());
if (!packages.length) {
  console.error(`no packages in ${dir}`);
  process.exit(1);
}
for (const name of packages) {
  writeFileSync(join(dir, `${name}.sig`), signPackage(key, name, sha512Of(join(dir, name))) + '\n');
  console.log(`signed ${name}`);
}
