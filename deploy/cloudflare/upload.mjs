/**
 * How deploy/cloudflare/publish.mjs fills the bucket, without wrangler or the network in it: which files go, in which
 * order, how many at a time, which are already there, and what a failed put does. Tests: deploy/ship/upload.test.ts.
 */

export const isFeedFile = (n) => /^latest.*\.ya?ml$/.test(n);
export const isPackage = (n) => /\.(exe|dmg|zip|deb|AppImage)$/.test(n);
export const isDiskImage = (n) => /\.dmg$/.test(n);
const isBlockmap = (n) => /\.blockmap$/.test(n);

/**
 * What goes to the bucket, as `{ first, last }`: `first` is the packages and their block maps, which may go in any
 * order and side by side, and `last` the update files, which go only when everything in `first` is there, so an app
 * never reads a file that points at a package that isn't.
 *
 * A macOS disk image (`.dmg`) is only for a first install and for the app's "Download" button on a Mac that can't
 * replace itself: the update itself is the zip. It stays on the GitHub release and the Worker sends anyone who asks the
 * feed for one there (deploy/cloudflare/src/index.js), so it is not uploaded unless `diskImages` is set. Its signature
 * still is, because the app asks for that before it downloads the image.
 */
export function planUploads(names, { diskImages = false } = {}) {
  const keep = (n) => isFeedFile(n) || isPackage(n) || isBlockmap(n);
  const wanted = names.filter(keep);
  const first = [];
  for (const name of wanted) {
    if (isFeedFile(name)) continue;
    // A disk image's block map is for differential downloads, which the app has off, and of no use without the image.
    if (isBlockmap(name) && isDiskImage(name.replace(/\.blockmap$/, '')) && !diskImages) continue;
    first.push({ name, kind: isPackage(name) ? 'package' : 'blockmap', send: isPackage(name) && isDiskImage(name) ? diskImages : true });
  }
  return { first, last: wanted.filter(isFeedFile).map((name) => ({ name, kind: 'feed', send: true })) };
}

/**
 * Runs `worker` over `items`, `limit` at a time, starting the biggest first (so the last file to start isn't the
 * longest). After the first failure nothing new starts; those already running finish, then the first error is thrown.
 */
export async function pool(items, limit, worker) {
  const queue = [...items];
  const errors = [];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (errors.length === 0 && queue.length) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (e) {
        errors.push(e);
      }
    }
  });
  await Promise.all(runners);
  if (errors.length) throw errors[0];
}

/** Calls `fn` up to `attempts` times, waiting `wait(n)` seconds after the nth failure. Cloudflare's API answers a big upload now and then with a 401 or a 502 that the next try doesn't get. */
export async function retrying(label, fn, { attempts = 4, wait = (n) => 15 * n, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), log = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts) throw e;
      log(`${label} failed (try ${attempt} of ${attempts}), again in ${wait(attempt)} s`);
      await sleep(wait(attempt));
    }
  }
}

/**
 * Puts the plan into the bucket. Injected: `put(key, path)` (a rejected promise is a failure), `isUploaded(item)`
 * (is this package there already, whole?) and `log`. Returns how many files were put and how many skipped.
 *
 * A package's signature goes after the package. That order is what makes a skip safe: the signature is made over the
 * package's name and sha512 (Ed25519 is deterministic), so a bucket whose signature equals today's has had a package
 * with today's hash put before it, and a put that did not finish leaves no signature behind.
 */
export async function runUploads({ plan, jobs = 3, put, isUploaded = async () => false, log = () => {}, retry = {} }) {
  const stats = { put: 0, skipped: 0 };
  const send = (key, path) => retrying(key, () => put(key, path), { ...retry, log });
  const one = async (item) => {
    if (item.kind === 'package') {
      const there = item.send && (await isUploaded(item).catch(() => false));
      if (there) {
        stats.skipped += 2;
        return log(`${item.name} is there already`);
      }
      if (item.send) {
        await send(item.name, item.path);
        stats.put++;
      }
      await send(`${item.name}.sig`, item.sigPath);
      stats.put++;
    } else {
      await send(item.name, item.path);
      stats.put++;
    }
  };
  const bySize = (a, b) => (b.size ?? 0) - (a.size ?? 0);
  await pool([...plan.first].sort(bySize), jobs, one);
  await pool(plan.last, jobs, one);
  return stats;
}
