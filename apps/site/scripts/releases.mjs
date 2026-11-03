#!/usr/bin/env node
/**
 * Writes apps/site/public/releases.json, the file list the download page shows (name, size, address of each build).
 * Run it after publishing a release and before deploying the site:
 *
 *   node apps/site/scripts/releases.mjs [tag]     (no tag: the newest release)
 *
 * It reads the release with the GitHub CLI, so it works while the repository is private too. Each build links to the
 * update feed's copy (deploy/cloudflare/publish.mjs puts it there) when that copy exists at the same size, since
 * GitHub's links need access to the repository; until it is mirrored, the GitHub link. The macOS disk images are not
 * on the feed any more and always link to the release. Run it again after publishing.
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, onFeed } from './kinds.mjs';

const repo = 'TheOriUHD/atelier';
const gh = (...args) => JSON.parse(execFileSync('gh', [...args, '--repo', repo], { encoding: 'utf8' }));

const tag = process.argv[2] ?? gh('release', 'list', '--limit', '1', '--json', 'tagName')[0]?.tagName;
if (!tag) throw new Error('no release found');
const release = gh('release', 'view', tag, '--json', 'tagName,publishedAt,url,isPrerelease,assets');

const feed = `https://updates.atelierhq.dev/${release.isPrerelease ? 'beta' : 'stable'}`;
/** The feed's copy, if it is there and the same file (a release can be replaced, e.g. by signed Mac builds). */
async function mirrored(asset) {
  const url = `${feed}/${encodeURIComponent(asset.name)}`;
  const res = await fetch(url, { method: 'HEAD' }).catch(() => null);
  return res?.ok && Number(res.headers.get('content-length')) === asset.size ? url : null;
}

// A release may leave a platform out (built elsewhere later): that platform keeps the newest earlier release's build.
const earlier = gh('release', 'list', '--limit', '20', '--json', 'tagName,isPrerelease')
  .filter((r) => r.tagName !== release.tagName && r.isPrerelease === release.isPrerelease)
  .map((r) => r.tagName);
const assets = {};
const older = [];
for (const [kind, pattern] of Object.entries(KINDS)) {
  let asset = release.assets.find((a) => pattern.test(a.name));
  for (let i = 0; !asset && i < earlier.length; i++) {
    asset = gh('release', 'view', earlier[i], '--json', 'assets').assets.find((a) => pattern.test(a.name));
    if (asset) older.push(`${kind} from ${earlier[i]}`);
  }
  if (!asset) throw new Error(`no ${kind} in ${tag} or an earlier release`);
  assets[kind] = { name: asset.name, size: asset.size, url: (onFeed(kind) ? await mirrored(asset) : null) ?? asset.url };
}
if (older.length) console.warn(`not in ${tag}, kept from earlier releases: ${older.join(', ')}`);
const missing = Object.entries(assets).filter(([kind, a]) => onFeed(kind) && !a.url.startsWith(feed)).map(([, a]) => a);
if (missing.length) console.warn(`not mirrored yet (GitHub links): ${missing.map((a) => a.name).join(', ')}`);

const out = {
  version: release.tagName.replace(/^v/, ''),
  tag: release.tagName,
  prerelease: release.isPrerelease,
  publishedAt: release.publishedAt,
  releaseUrl: release.url,
  assets,
};
const file = join(dirname(fileURLToPath(import.meta.url)), '../public/releases.json');
await writeFile(file, JSON.stringify(out, null, 2) + '\n');
console.log(`${tag}: ${Object.keys(assets).length} builds -> ${file}`);
