/**
 * Download counts for the admin panel (deploy/admin), kept in D1 `STATS` (the `atelier-admin` database): per day, which
 * file, version and platform, what kind of fetch, and the country Cloudflare guesses. No address, id or user agent is
 * stored. Counting never changes or delays an answer: it runs after the response, in `waitUntil`, inside try/catch,
 * and does nothing without the binding.
 *
 *   downloads       a package (exe, dmg, the dmg's redirect to GitHub, zip, AppImage, deb, rpm, tar.gz), its blockmap,
 *                   an install script or a server setup binary: GET only, and only from byte 0 (a resumed download is
 *                   not a new one)
 *   update_checks   an update file (latest*.yml, atelier-cli.json). Apps ask every five minutes while they run, so these
 *                   are added up in memory and written at most every 20 seconds or 25 checks
 *
 * What the app sends (apps/docs/src/content/docs/privacy.md): electron-updater asks for the update files and the Windows
 * and Linux packages with `User-Agent: electron-builder` and no version, so a check's version is always 'unknown'. On
 * macOS the app downloads the update zip itself, with Electron's own user agent; the website offers only the disk images,
 * so a mac zip is an update whoever asks.
 */
/** The UTC day, `YYYY-MM-DD` (as deploy/reports/src/policy.js has it; this Worker bundles only its own folder). */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A version, with an optional prerelease part that is never an architecture or `mac` (0.3.0-beta.1, not 0.3.0-arm64). */
const V = String.raw`(\d+\.\d+\.\d+(?:-(?!arm64|amd64|x64|x86_64|aarch64|mac\b)[0-9A-Za-z.]+)?)`;
const arch = (a) => (a === 'arm64' || a === 'aarch64' ? 'arm64' : 'x64');

const PACKAGES = [
  [new RegExp(`^Atelier-Setup-${V}(?:-(x64|arm64))?\\.exe$`), (m) => (m[2] ? `windows-${m[2]}` : 'windows')],
  [new RegExp(`^Atelier-${V}(?:-(arm64))?\\.dmg$`), (m) => `mac-${arch(m[2])}`],
  [new RegExp(`^Atelier-${V}(?:-(arm64))?-mac\\.zip$`), (m) => `mac-${arch(m[2])}`],
  [new RegExp(`^Atelier-${V}(?:-(arm64|x86_64|aarch64))?\\.AppImage$`), (m) => `linux-${arch(m[2])}`],
  [new RegExp(`^Atelier-${V}[-_.](amd64|arm64|x64)\\.deb$`), (m) => `linux-${arch(m[2])}`],
  [new RegExp(`^Atelier-${V}[-_.](x86_64|aarch64|x64|arm64)\\.rpm$`), (m) => `linux-${arch(m[2])}`],
  // The terminal app (apps/cli/src/update/update.ts `packageName`).
  [
    new RegExp(`^atelier-cli-${V}-(darwin|linux|windows)-(x64|arm64)\\.(?:tar\\.gz|zip)$`),
    (m) => `cli-${m[2] === 'darwin' ? 'mac' : m[2]}-${m[3]}`,
  ],
];

/** `{ version, platform }` of a package's file name, or null for anything else. */
export function packageOf(name) {
  for (const [pattern, platform] of PACKAGES) {
    const m = pattern.exec(name);
    if (m) return { version: m[1], platform: platform(m) };
  }
  return null;
}

/** The platform an update file is for. */
export const UPDATE_FILES = {
  'latest.yml': 'windows',
  'latest-mac.yml': 'mac',
  'latest-linux.yml': 'linux-x64',
  'latest-linux-arm64.yml': 'linux-arm64',
  'atelier-cli.json': 'cli',
};

/** A GET from the first byte: no Range, or one that starts at 0. A resumed or partial download isn't counted again. */
export function fromStart(request) {
  if (request.method !== 'GET') return false;
  const range = request.headers.get('range');
  if (!range) return true;
  const m = /^\s*bytes\s*=\s*(\d+)\s*-/i.exec(range);
  return Boolean(m) && Number(m[1]) === 0;
}

const countryOf = (request) => {
  const c = request.cf?.country;
  return typeof c === 'string' && /^[A-Z0-9]{2}$/.test(c) ? c : 'XX';
};

/**
 * What a request was, for counting: a `downloads` row, an update check, or null. `target` is the route index.js found:
 * `{ channel, file }` for a channel's file, `{ script }` for an install script, `{ setup, version, file }` for a server
 * setup binary. The response must be one the request got what it asked for with (200, a 206 from byte 0, or the disk
 * image's redirect).
 */
export function classify(request, response, target) {
  if (!target || !fromStart(request)) return null;
  const ok =
    response.status === 200 || response.status === 206 || (response.status === 302 && /\.dmg$/.test(target.file ?? ''));
  if (!ok) return null;
  const ua = request.headers.get('user-agent') ?? '';
  const country = countryOf(request);
  if (target.script)
    return {
      table: 'downloads',
      channel: '',
      file: target.file,
      version: '',
      platform: target.script,
      kind: 'install-script',
      country,
    };
  if (target.setup) {
    const m = /^atelier-setup-(linux|darwin)-(amd64|arm64)$/.exec(target.file);
    return m
      ? {
          table: 'downloads',
          channel: '',
          file: target.file,
          version: target.version,
          platform: `server-${m[1] === 'darwin' ? 'mac' : 'linux'}-${arch(m[2])}`,
          kind: 'server-setup',
          country,
        }
      : null;
  }
  const { channel, file } = target;
  if (UPDATE_FILES[file])
    return response.status === 200
      ? { table: 'update_checks', channel, platform: UPDATE_FILES[file], version: 'unknown' }
      : null;
  const blockmap = file.endsWith('.blockmap');
  const pkg = packageOf(blockmap ? file.slice(0, -'.blockmap'.length) : file);
  if (!pkg) return null;
  const update = /\belectron-builder\b/i.test(ua) || /-mac\.zip$/.test(file);
  return {
    table: 'downloads',
    channel,
    file,
    version: pkg.version,
    platform: pkg.platform,
    kind: blockmap ? 'update-blockmap' : update ? 'update' : 'download',
    country,
  };
}

const UPSERT_DOWNLOAD =
  'INSERT INTO downloads (day, channel, file, version, platform, kind, country, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, channel, file, kind, country) DO UPDATE SET count = count + excluded.count';
const UPSERT_CHECK =
  'INSERT INTO update_checks (day, channel, platform, version, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, channel, platform, version) DO UPDATE SET count = count + excluded.count';

/** At most this many distinct update-check rows wait in memory (a failing database must not grow it without end). */
const MAX_PENDING_KEYS = 500;

/**
 * A counter with its own buffer of update checks (one per isolate in the Worker; tests make their own). `now` and
 * `sleep` are the clock, so tests need not wait 20 seconds.
 */
export function createCounter({
  flushEvery = 25,
  flushAfterMs = 20_000,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  /** `day|channel|platform|version` → count. */
  let pending = new Map();
  let pendingCount = 0;
  let firstAt = 0;
  let timer = null;

  async function flush(db) {
    if (!pendingCount) return;
    const rows = pending;
    pending = new Map();
    pendingCount = 0;
    firstAt = 0;
    try {
      await db.batch([...rows].map(([key, count]) => db.prepare(UPSERT_CHECK).bind(...key.split('|'), count)));
    } catch {
      // D1 batches are all or nothing: put them back for the next flush, unless too much is waiting already.
      for (const [key, count] of rows) {
        if (!pending.has(key) && pending.size >= MAX_PENDING_KEYS) continue;
        pending.set(key, (pending.get(key) ?? 0) + count);
        pendingCount += count;
        firstAt ||= now();
      }
    }
  }

  /** Counts what `request` was, after `response` went out. Never throws, never waits. */
  function record(request, response, env, ctx, target) {
    try {
      const db = env?.STATS;
      if (!db) return;
      const row = classify(request, response, target);
      if (!row) return;
      const later = (promise) => {
        const safe = Promise.resolve(promise).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(safe);
      };
      const day = dayOf(now());
      if (row.table === 'downloads') {
        later(
          db
            .prepare(UPSERT_DOWNLOAD)
            .bind(day, row.channel, row.file, row.version, row.platform, row.kind, row.country, 1)
            .run(),
        );
        return;
      }
      const key = [day, row.channel, row.platform, row.version].join('|');
      if (!pending.has(key) && pending.size >= MAX_PENDING_KEYS) return;
      pending.set(key, (pending.get(key) ?? 0) + 1);
      pendingCount++;
      firstAt ||= now();
      if (pendingCount >= flushEvery || now() - firstAt >= flushAfterMs) later(flush(db));
      else if (!timer) {
        // A quiet isolate still writes within 20 seconds: waitUntil keeps it running that long after the response.
        timer = sleep(Math.max(0, flushAfterMs - (now() - firstAt))).then(() => {
          timer = null;
          return flush(db);
        });
        later(timer);
      }
    } catch {
      // Counting is never a reason for a request to fail.
    }
  }

  return { record, flush, pending: () => new Map(pending) };
}
