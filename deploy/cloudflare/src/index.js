/**
 * Atelier's update feed and download page (docs/updates.md). Desktop apps read `/<channel>/latest*.yml` and the
 * packages beside it (electron-updater's generic provider, which asks for byte ranges); people open `/` to download.
 * The bucket holds `stable/` and `beta/`, put there by deploy/cloudflare/publish.mjs.
 */
import { announcedFiles, diskImageUrl, latestPackages } from './latest.js';

const CHANNELS = new Set(['stable', 'beta']);
const SETUP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,40}$/;
const SETUP_FILE = /^atelier-setup-(linux|darwin)-(amd64|arm64)$/;

/** The repository whose release a missing macOS disk image is sent to (wrangler.toml, `GITHUB_REPO`). */
const REPO = 'TheOriUHD/atelier';
/** The update files of a channel: what an app is told to download. */
const UPDATE_FILES = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'];

const text = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });

/** A file from the bucket, with ranges: updates download in pieces and resume. */
async function file(request, env, key, cache) {
  const object = await env.RELEASES.get(key, { range: request.headers });
  if (!object) {
    // A disk image is only on the GitHub release (publish.mjs leaves it out of the bucket): the app and older apps ask for it here.
    const release = diskImageUrl(key, env.GITHUB_REPO ?? REPO);
    return release ? new Response(null, { status: 302, headers: { location: release, 'cache-control': 'public, max-age=300' } }) : text('Not found', 404);
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  // The update files change with each release; the packages never do.
  headers.set('cache-control', cache ?? (/\.ya?ml$/.test(key) ? 'public, max-age=60' : 'public, max-age=31536000, immutable'));
  const range = object.range;
  if (request.headers.has('range') && range && 'offset' in range) {
    const start = range.offset ?? 0;
    const length = range.length ?? object.size - start;
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

/** What the download page offers: the packages the channel's update files announce, so nothing is shown before it is complete. */
async function packages(env, channel) {
  const files = await Promise.all(UPDATE_FILES.map(async (name) => (await env.RELEASES.get(`${channel}/${name}`))?.text() ?? ''));
  return latestPackages(announcedFiles(files));
}

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function page(env) {
  const stable = await packages(env, 'stable');
  const beta = await packages(env, 'beta');
  const rows = (channel, list) =>
    list.length
      ? list.map((p) => `<li><a href="/${channel}/${encodeURIComponent(p.name)}">${escape(p.label)}</a> <span>${escape(p.note)} · ${escape(p.version)}</span></li>`).join('')
      : '<li><span>Nothing published yet.</span></li>';
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atelier (beta)</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.25rem;color:#1f1e1d}h1{font-size:1.6rem;margin:0}.beta{background:#fff7e0;border:1px solid #e6c34a;border-radius:10px;padding:.75rem 1rem;margin:1.25rem 0}ul{list-style:none;padding:0}li{padding:.5rem 0;border-top:1px solid #e5e2dc}li span{color:#6b6862;font-size:.9rem}a{color:#c6613f;font-weight:600}</style>
<h1>Atelier</h1><p>A self-hosted AI workspace: Chat, Cowork and Code on the model you choose.</p>
<div class="beta"><strong>Atelier is in beta.</strong> Please be aware it is unfinished: things will be missing, change or break. The macOS builds are signed and notarized; the Windows installer is not signed yet, so Windows warns before opening it.</div>
<h2>Download</h2><ul>${rows('stable', stable)}</ul>
<h2>Beta channel</h2><ul>${rows('beta', beta)}</ul>
<p><span>Installed copies update themselves from here.</span></p><p lang="de"><a href="https://atelierhq.dev/impressum/">Impressum</a> · <a href="https://atelierhq.dev/datenschutz/">Datenschutz</a></p></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } },
  );
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405, { allow: 'GET, HEAD' });
    const [first, ...rest] = new URL(request.url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (!first) return page(env);
    if (CHANNELS.has(first) && rest.length === 1 && !rest[0].includes('..')) return file(request, env, `${first}/${rest[0]}`);
    // The server installer (deploy/ship/install.sh.tmpl): `curl -fsSL https://updates.atelierhq.dev/install | sudo sh`.
    if (first === 'install' && rest.length === 0) {
      const res = await file(request, env, 'setup/install.sh', 'public, max-age=60');
      if (res.status === 200 || res.status === 206) res.headers.set('content-type', 'text/x-shellscript; charset=utf-8');
      return res;
    }
    // Its binaries, one folder per version.
    if (first === 'setup' && rest.length === 2 && SETUP_VERSION.test(rest[0]) && SETUP_FILE.test(rest[1])) return file(request, env, `setup/${rest[0]}/${rest[1]}`);
    return text('Not found', 404);
  },
};
