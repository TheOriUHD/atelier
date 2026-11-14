# Update feed

The Worker at `updates.atelierhq.dev` in front of the `atelier-releases` bucket: the desktop apps' update files and
packages, the install scripts, the server setup binaries, and a plain download page. How releases get there, signing
and the release order are in [docs/updates.md](../../docs/updates.md).

- `src/index.js`: the routes. `src/latest.js`: file-name logic (no Worker APIs). `src/stats.js`: the download counts.
- `publish.mjs`, `upload.mjs`, `signing.mjs`, `sign-release.mjs`: putting a release into the bucket.

## Download counts

For the admin panel (`deploy/admin`), the Worker counts what it served into D1 `STATS`, the `atelier-admin`
database. It stores no address, id or user agent: per day, only

- **`downloads`**: channel, file, the version and platform read from the file name, the kind, the country Cloudflare
  guesses (`request.cf.country`, `XX` when unknown), and a count. Counted: packages (exe, dmg, the redirect of a missing
  dmg to its GitHub release, zip, AppImage, deb, rpm, the terminal app's tar.gz and zip), blockmaps, the install
  scripts (`/install`, `/cli`, `/cli.ps1`) and the server setup binaries. Only a GET, and only one from the first byte
  (no `Range`, or a range that starts at 0): resuming a download doesn't count it again, and the release scripts'
  HEAD requests don't count at all. Kinds:
  - `update`: the app updating itself. electron-updater asks with `User-Agent: electron-builder`; the macOS app
    downloads its update zip through its own network stack (with Electron's user agent), and since the website offers
    only disk images, a `-mac.zip` counts as an update whoever asks;
  - `download`: anything else (a person, curl from the install script);
  - `update-blockmap`, `install-script`, `server-setup`.
- **`update_checks`**: requests for `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` and
  the terminal app's `atelier-cli.json`, by channel and platform. The request carries no version
  (apps/docs/src/content/docs/privacy.md), so `version` is always `unknown`; the column is there for a later app that
  says it. Apps check every five minutes while they run, so these are added up in memory per isolate and written in
  one batch after 25 checks or 20 seconds (a quiet isolate is kept alive for that by `waitUntil`).

Counting never changes or delays an answer: it runs after the response is ready, through `ctx.waitUntil`, inside
try/catch, and without the `STATS` binding nothing is counted. Counts that can't be written are kept for the next
write, up to 500 distinct rows. The macOS disk image links on the website go through the feed
(`apps/site/scripts/releases.mjs`), which redirects them to the GitHub release and counts them on the way.

## Deploy

```bash
cd deploy/cloudflare
npx wrangler deploy
```

Before the first deploy with counting, the `atelier-admin` database must exist with its migrations applied, and its
`database_id` must replace the zero placeholder under `[[d1_databases]]` in `wrangler.toml` (`deploy/admin/README.md`).
**The release command redeploys this Worker whenever `src/` or `wrangler.toml` changed since the last release**, so
put the real id in before the next release, or that release's deploy step fails.

## Test

```bash
node --test deploy/cloudflare/src/*.test.mjs    # routes, file names, and the counting (D1 faked with node:sqlite)
npx vitest run deploy/ship/site.test.ts         # the website's download list, the disk images' feed links included
```
