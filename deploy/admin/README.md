# Admin panel

The owner's panel at `admin.atelierhq.dev`: the inboxes for issue reports and feature requests that the collector
(`deploy/reports`) keeps, and the download counts the update feed (`deploy/cloudflare`) records. The page is the SPA in
`apps/admin`, served as Workers static assets; this Worker answers `/api/*` and runs a daily cron.

- `src/index.js`: routing, the Access check, the CSRF check. `src/access.js`: the Access JWT. `src/api.js`: the API.
  `src/cron.js`: the daily jobs.
- `migrations/`: the schema of the `atelier-admin` database, which the collector and the update feed write to as
  well. This folder owns it; the other two `wrangler.toml` files point their `migrations_dir` here.
- `scripts/dev.mjs`, `scripts/seed.mjs`, `scripts/fixtures.mjs`: local development (below).
- `test/fakes.mjs`: D1 over `node:sqlite` (with these migrations), R2 as a Map, a rate limiter; used by all three
  Workers' tests.

## Who gets in

Two locks, both required:

1. **Cloudflare Access** in front of the whole host. Zero Trust › Access › Applications › Add › Self-hosted:
   domain `admin.atelierhq.dev` (no path, so it covers `/api/*` too), one Allow policy with an **Emails** include of the
   owner's address only, a session of a day or so. Copy the application's **Audience (AUD) tag**; the team domain is
   `<team>.cloudflareaccess.com` (shown in Zero Trust › Settings).
2. **This Worker checks again** on every `/api` request and fails closed: the `Cf-Access-Jwt-Assertion` header must be
   an RS256 JWT signed by one of the team's keys (`https://<TEAM_DOMAIN>/cdn-cgi/access/certs`, cached for ten
   minutes and fetched again when a token names a key it doesn't know), with `aud` containing `ACCESS_AUD`, `iss` the
   team domain, within `nbf`…`exp` (a minute of leeway), and an `email` in `ADMIN_EMAILS`. Any missing setting refuses
   every API request with 403. A service token (no email) is refused.

Requests that change something (PATCH, DELETE, POST) must also carry `x-atelier-admin: 1` and a JSON content type,
which a form or link on another site can't send without a CORS preflight that this Worker never answers.

The page and its scripts are served without the Worker (`run_worker_first` covers `/api/*` only): they hold no data,
and Access guards them. `apps/admin/public/_headers` gives them a strict content security policy (no inline scripts,
no other origins), since everything the panel shows comes from people's reports. Pictures are served by the API with
their stored image type, `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.

`DEV_NO_ACCESS = "1"` skips the check only when the request's host is `localhost` or `127.0.0.1`, which a request to
the custom domain never is. Never set it on the deployed Worker anyway.

## What it keeps

- The reports (see `deploy/reports/README.md`): the owner can change their status, labels and a private note, mark
  them read, and delete them with their files. Reports older than 365 days are deleted by the cron.
- `github_snapshots`: once a day, every asset's `download_count` from the public GitHub releases of `GITHUB_REPO`, so
  the panel can show per-day growth next to the feed's own counts.
- `downloads` and `update_checks`: written by the update feed (`deploy/cloudflare/README.md`), per day, without
  addresses.

Statuses: issues are new, triaged, in-progress, fixed, wont-fix, duplicate; feature requests are new, planned,
in-progress, done, declined, duplicate.

## The daily cron (03:17 UTC)

1. Reads every release's assets from `https://api.github.com/repos/<GITHUB_REPO>/releases` (paginated) into
   `github_snapshots`. Optional secret `GITHUB_TOKEN` (a fine-grained token with read access to public repositories):
   without it GitHub allows 60 requests an hour per address, which Workers share.
2. Deletes reports older than 365 days, files first.
3. Deletes quota rows older than two days.
4. Recounts the bytes the reports take (`collector_state.stored_bytes`), in case a deletion was cut short.

Each step runs on its own; one failing doesn't stop the others.

## API

All JSON, all behind the checks above.

| Route | |
|---|---|
| `GET /api/me` | who is signed in |
| `GET /api/overview?days=30` | downloads today/7/30 days and per day by platform, versions, the latest version's share, update checks, reports per day, the collector's state |
| `GET /api/downloads?days=90` | per day × platform × kind, by version, by country, top files, update checks, GitHub totals and daily growth |
| `GET /api/reports?kind=issue\|feature&status=&q=&version=&os=&limit=&before=` | an inbox page (status `open`, `unseen` or one status; `q` searches title, description and id), with facets and the next cursor |
| `GET /api/reports/:id` | `{ row, report, files, statuses }` |
| `GET /api/reports/:id/chat` | the attached chat |
| `GET /api/reports/:id/files/:name` | a screenshot (`shot0.webp`…), images only |
| `PATCH /api/reports/:id` | `{ status?, labels?, note?, seen? }` |
| `DELETE /api/reports/:id` | the report and its files |
| `POST /api/reports/bulk` | `{ ids, action: 'status' \| 'delete', status? }` (a status changes only the reports whose kind has it) |
| `GET /api/limits` | today's count, the current bits, stored bytes and the caps |

## Deploy

From a checkout of the whole repository. The first time, everything for the collector and the feed's counts too:

```bash
cd deploy/admin
npx wrangler d1 create atelier-admin --location weur
#   put the database_id it prints into deploy/admin/wrangler.toml, deploy/reports/wrangler.toml and
#   deploy/cloudflare/wrangler.toml (the zero ids there are placeholders for local development)
npx wrangler d1 migrations apply atelier-admin --remote
npx wrangler r2 bucket create atelier-reports --location weur

# The collector (deploy/reports/README.md)
cd ../reports
openssl rand -hex 32 | npx wrangler secret put CHALLENGE_SECRET
npx wrangler deploy

# Access first (above), then the panel
cd ../admin
npx wrangler secret put TEAM_DOMAIN        # <team>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD         # the application's AUD tag
npx wrangler secret put ADMIN_EMAILS       # the owner's address (comma-separated for more)
npx wrangler secret put GITHUB_TOKEN       # optional
pnpm --filter @atelier/admin build
npx wrangler deploy

# The update feed, now with its STATS binding (deploy/cloudflare/README.md)
cd ../cloudflare && npx wrangler deploy
```

`TEAM_DOMAIN`, `ACCESS_AUD` and `ADMIN_EMAILS` are secrets rather than `[vars]` so the public repository doesn't name
the owner or their Access team, and so a deploy doesn't reset them. Check it: `https://admin.atelierhq.dev` asks for
the Access sign-in, and `curl https://admin.atelierhq.dev/api/me` without one is turned away by Access.

Later schema changes: add `migrations/0002_….sql`, run `npx wrangler d1 migrations apply atelier-admin --remote`
before deploying the Workers that use it, and never edit an applied migration.

## Local development

Everything runs locally with `wrangler dev --local`; nothing touches Cloudflare.

```bash
node deploy/admin/scripts/dev.mjs      # builds the SPA, migrates a local D1, runs both Workers:
                                       #   collector http://127.0.0.1:8787, admin http://localhost:8788
node deploy/admin/scripts/seed.mjs     # another terminal: fake reports and 90 days of counts
pnpm --filter @atelier/admin dev       # optional: the SPA with hot reload on http://localhost:5181 (API proxied to 8788)
```

- Both Workers share one local D1 and R2 in `deploy/admin/.wrangler/dev-state` (delete it to start over). The admin
  runs with `DEV_NO_ACCESS=1`; the collector with a fixed development `CHALLENGE_SECRET`.
- `seed.mjs` checks each fake report against the protocol and posts it through the collector the way the app does
  (challenge, proof of work, multipart with PNG screenshots it draws), each from its own TEST-NET address so the
  limits don't stop a second run. Then it backdates them, gives a few a status, labels and a note, and replaces the
  download, update-check and GitHub rows with generated ones. It refuses a collector that isn't on localhost.
- The fixtures: a Mac (M4 Pro, Ollama with qwen3 loaded) with a long Code chat (tool calls, a sub-agent, messages
  12–840 left out), Windows with an RTX 4090 and ComfyUI, a Linux server used from a browser, feature requests with
  and without diagnostics, a terminal-app report with a proxy password the collector scrubs.
- `.claude/launch.json` has `admin` (dev.mjs) and `admin-vite` for the built-in browser preview.

## Test

```bash
node --test deploy/admin/src/*.test.mjs     # the Access check (local RS256 keys and JWKS), CSRF, the API, the cron
npx vitest run --project @atelier/admin     # the SPA's markdown sanitizer, zips, formatting
pnpm --filter @atelier/admin typecheck && pnpm --filter @atelier/admin build
```
