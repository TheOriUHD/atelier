#!/usr/bin/env node
/**
 * Puts a release into the bucket (docs/updates.md):
 *   node deploy/cloudflare/publish.mjs <folder with the installers and latest*.yml> [stable|beta] [flags]
 * The packages go first (each with a `<name>.sig`, made with the update-signing key: ATELIER_UPDATE_KEY, by default
 * ~/.atelier-release/update-signing.key) and the update files last, so an app never reads a file that points at a
 * package that is not there yet, or one that is not signed. Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) and the
 * bucket from wrangler.toml.
 *
 * Flags:
 *   --packages-only   leave the update files out: the packages are in the bucket but nothing points at them yet. The
 *                     release command does this while the last build is still running, so less is left to send later.
 *   --disk-images     also upload the macOS .dmg files (the default leaves them to the GitHub release; see upload.mjs)
 *   --jobs <n>        files sent at the same time (default 3, or ATELIER_PUBLISH_JOBS)
 * A package that is in the bucket already (same size, same signature) is not sent again, so running it again after a
 * failure, or after --packages-only, only sends what is missing.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_KEY, loadKey, sha512Of, signPackage } from './signing.mjs';
import { isFeedFile, planUploads, runUploads } from './upload.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--jobs');
const [dir, channel = 'stable'] = positional;
if (!dir || !['stable', 'beta'].includes(channel)) {
  console.error('usage: node deploy/cloudflare/publish.mjs <folder> [stable|beta] [--packages-only] [--disk-images] [--jobs n]');
  process.exit(2);
}
const BUCKET = process.env.ATELIER_RELEASES_BUCKET ?? 'atelier-releases';
const JOBS = Number(valueOf('--jobs') ?? process.env.ATELIER_PUBLISH_JOBS ?? 3);
/** Where the bucket is served, to ask what is there already; only for the project's own bucket. */
const FEED = process.env.ATELIER_RELEASE_FEED ?? (BUCKET === 'atelier-releases' ? 'https://updates.atelierhq.dev' : null);
const names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
if (!names.some(isFeedFile)) {
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

const cwd = new URL('.', import.meta.url).pathname;
/** Runs wrangler without blocking; its output is kept and shown only when it fails, so parallel puts don't tangle the log. */
function wrangler(args) {
  return new Promise((resolve, reject) => {
    // The newest 4.x, from npm's cache when it is there: a registry round trip per file is time not spent sending.
    const child = spawn('npx', ['--yes', 'wrangler@4', ...args], { cwd, env: { ...process.env, npm_config_prefer_offline: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args.slice(0, 3).join(' ')} failed (${code})\n${out.trim().split('\n').slice(-12).join('\n')}`))));
  });
}

/**
 * wrangler logs in with an OAuth token that it renews by itself when a command starts. Several commands starting at once
 * would each renew it, and the ones that lose the race are refused with a 401 ("Authentication error"). One command
 * first, alone, renews it for all of them; it also proves that the login can reach the bucket before anything is sent.
 */
async function checkLogin() {
  try {
    await wrangler(['r2', 'bucket', 'info', BUCKET]);
  } catch (e) {
    console.error(`wrangler can't reach the bucket "${BUCKET}": ${e.message}\nLog in again with: npx wrangler login`);
    process.exit(1);
  }
}

/** Whether the bucket already has this package, whole: its size and its signature, read through the public feed. */
async function isUploaded(item) {
  if (!FEED) return false;
  const url = `${FEED}/${channel}/${encodeURIComponent(item.name)}`;
  // A query string the Worker ignores, so that no cache answers for the object.
  const fresh = `?check=${Date.now()}`;
  const head = await fetch(url + fresh, { method: 'HEAD' });
  if (!head.ok || Number(head.headers.get('content-length')) !== item.size) return false;
  const sig = await fetch(`${url}.sig${fresh}`);
  return sig.ok && (await sig.text()).trim() === item.signature;
}

const work = mkdtempSync(join(tmpdir(), 'atelier-sig-'));
try {
  const plan = planUploads(names, { diskImages: flag('--disk-images') });
  if (flag('--packages-only')) plan.last = [];
  for (const item of [...plan.first, ...plan.last]) {
    item.path = join(dir, item.name);
    item.size = statSync(item.path).size;
    if (item.kind === 'package') {
      item.signature = signPackage(key, item.name, sha512Of(item.path));
      item.sigPath = join(work, `${item.name}.sig`);
      writeFileSync(item.sigPath, item.signature + '\n');
    }
  }
  console.log(`${plan.first.length + plan.last.length} files to ${channel}, ${JOBS} at a time${flag('--packages-only') ? ' (packages only)' : ''}`);
  await checkLogin();
  const started = Date.now();
  const stats = await runUploads({
    plan,
    jobs: JOBS,
    isUploaded,
    log: (message) => console.log(message),
    put: async (file, path) => {
      const begun = Date.now();
      await wrangler(['r2', 'object', 'put', `${BUCKET}/${channel}/${file}`, '--file', path, '--remote']);
      console.log(`put ${channel}/${file} (${((Date.now() - begun) / 1000).toFixed(0)} s)`);
    },
  });
  console.log(`published ${stats.put} files to ${channel}${stats.skipped ? `, ${stats.skipped} were there already` : ''} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
