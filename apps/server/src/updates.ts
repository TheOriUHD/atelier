/**
 * The desktop apps' update feed: electron-updater's generic provider reads `/updates/<channel>/<file>`, and
 * this mirrors the files from the GitHub Releases of the (private) repository the apps are built in. `stable`
 * is the newest published release that isn't a prerelease, `beta` the newest including prereleases. Only
 * signed-in people get files, and only files that are assets of that release.
 */
import { Hono, type Context } from 'hono';
import { APP } from '@atelier/protocol';

export interface UpdateFeedOptions {
  /** `owner/repo` (ATELIER_UPDATES_REPO). The feed is off without it and a token. */
  repo: string | undefined;
  /** A GitHub token that can read that repository's releases (ATELIER_UPDATES_TOKEN). */
  token: string | undefined;
  /** The server's own sign-in check: a session cookie or a bearer token. */
  authenticated(c: Context): Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Release {
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string; url: string }[];
}

const CHANNELS = new Set(['stable', 'beta']);
const CACHE_MS = 5 * 60_000;

/** The newest release on a channel. ISO timestamps sort as strings; drafts have none and never count. */
function newest(releases: Release[], channel: string): Release | undefined {
  return releases
    .filter((r) => !r.draft && r.published_at && (channel === 'beta' || !r.prerelease))
    .sort((a, b) => b.published_at!.localeCompare(a.published_at!))[0];
}

export function updateFeed({ repo, token, authenticated, fetch: request = fetch, now = Date.now }: UpdateFeedOptions): Hono {
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`ATELIER_UPDATES_REPO must be owner/repo, not "${repo}".`);
  const feed = new Hono();
  const github = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': APP.name };
  let cache: { at: number; releases: Promise<Release[]> } | null = null;

  const releases = (): Promise<Release[]> => {
    if (cache && now() - cache.at < CACHE_MS) return cache.releases;
    const list = request(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers: { ...github, Accept: 'application/vnd.github+json' } }).then(
      async (r) => {
        if (!r.ok) throw new Error(`GitHub answered ${r.status} for the releases of ${repo}.`);
        return (await r.json()) as Release[];
      },
    );
    const entry = { at: now(), releases: list };
    cache = entry;
    // A failed lookup isn't kept: the next request asks again.
    list.catch(() => cache === entry && (cache = null));
    return list;
  };

  feed.get('/:channel/:file', async (c) => {
    if (!(await authenticated(c))) return c.json({ code: 'unauthenticated', message: 'Sign in to get updates.' }, 401);
    if (!repo || !token) {
      return c.json({ code: 'not_configured', message: 'This server has no update feed: set ATELIER_UPDATES_REPO and ATELIER_UPDATES_TOKEN to serve one.' }, 404);
    }
    const { channel, file } = c.req.param();
    if (!CHANNELS.has(channel)) return c.json({ code: 'not_found', message: `There is no "${channel}" update channel.` }, 404);
    try {
      const asset = newest(await releases(), channel)?.assets.find((a) => a.name === file);
      if (!asset) return c.json({ code: 'not_found', message: `The newest ${channel} release has no file named "${file}".` }, 404);
      // GitHub answers with a redirect to a signed storage URL; the token is only for GitHub's API.
      const answer = await request(asset.url, { headers: { ...github, Accept: 'application/octet-stream' }, redirect: 'manual' });
      const location = answer.headers.get('location');
      const redirected = answer.status >= 300 && answer.status < 400;
      if (redirected && !location?.startsWith('https://')) throw new Error(`GitHub sent ${asset.name} to an unexpected address.`);
      const download = redirected ? await request(location!) : answer;
      if (!download.ok || !download.body) throw new Error(`GitHub answered ${download.status} for ${asset.name}.`);
      const length = download.headers.get('content-length');
      return new Response(download.body, { headers: { 'Content-Type': 'application/octet-stream', ...(length ? { 'Content-Length': length } : {}) } });
    } catch (e) {
      return c.json({ code: 'upstream', message: e instanceof Error ? e.message : String(e) }, 502);
    }
  });
  return feed;
}
