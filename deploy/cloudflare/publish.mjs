#!/usr/bin/env node
/**
 * Puts a release into the bucket (docs/updates.md):
 *   node deploy/cloudflare/publish.mjs <folder with the installers and latest*.yml> [stable|beta]
 * The packages go first (each with a `<name>.sig`, made with the update-signing key: ATELIER_UPDATE_KEY, by default
 * ~/.atelier-release/update-signing.key) and the update files last, so an app never reads a file that points at a
 * package that is not there yet, or one that is not signed. Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) and the
 * bucket from wrangler.toml.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_KEY, loadKey, sha512Of, signPackage } from './signing.mjs';

const [dir, channel = 'stable'] = process.argv.slice(2);
if (!dir || !['stable', 'beta'].includes(channel)) {
  console.error('usage: node deploy/cloudflare/publish.mjs <folder> [stable|beta]');
  process.exit(2);
}
const BUCKET = process.env.ATELIER_RELEASES_BUCKET ?? 'atelier-releases';
const names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
const isFeed = (n) => /^latest.*\.ya?ml$/.test(n);
const isPackage = (n) => /\.(exe|dmg|zip|deb|AppImage)$/.test(n);
const wanted = (n) => isFeed(n) || isPackage(n) || /\.blockmap$/.test(n);
const files = [...names.filter((n) => wanted(n) && !isFeed(n)), ...names.filter(isFeed)];
if (!files.some(isFeed)) {
  console.error(`no latest*.yml in ${dir}: nothing to point the apps at`);
  process.exit(1);
}
// A Linux feed lists every package its build made: one run builds the AppImage and the .deb together, or a copy
// installed from the other kind finds nothing to update to.
for (const name of names.filter((n) => /^latest-linux.*\.ya?ml$/.test(n))) {
  const text = readFileSync(join(dir, name), 'utf8');
  if (!/\.AppImage\b/.test(text) || !/\.deb\b/.test(text)) console.warn(`warning: ${name} does not list both the .AppImage and the .deb: build all Linux targets in one run`);
}

let key;
try {
  key = loadKey();
} catch (e) {
  console.error(`no update-signing key (${process.env.ATELIER_UPDATE_KEY ?? DEFAULT_KEY}): ${e.message}`);
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), 'atelier-sig-'));
const wrangler = (file, path) =>
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${channel}/${file}`, '--file', path, '--remote'], { stdio: 'inherit', cwd: new URL('.', import.meta.url).pathname });
try {
  let count = 0;
  for (const name of files) {
    console.log(`put ${channel}/${name}`);
    wrangler(name, join(dir, name));
    count++;
    if (isPackage(name)) {
      const sig = join(work, `${name}.sig`);
      writeFileSync(sig, signPackage(key, name, sha512Of(join(dir, name))) + '\n');
      console.log(`put ${channel}/${name}.sig`);
      wrangler(`${name}.sig`, sig);
      count++;
    }
  }
  console.log(`published ${count} files to ${channel}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
