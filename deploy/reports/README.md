# Report collector

The collector at `reports.atelierhq.dev` takes the issue reports and feature requests people send from Atelier's
reporter (desktop, web and the terminal app). The owner reads them in the admin panel
(`deploy/admin`). The wire format is `packages/protocol/src/reports.ts`; the Worker bundles that file as it is, so the
app and the collector check reports with the same code.

- `src/index.js`: the Worker. `POST /v1/challenge` hands out a signed proof-of-work challenge, `POST /v1/reports` takes
  a report (multipart: `report`, then `chat`, then `shot0`…`shot3`, with the challenge and its nonce in the
  `x-atelier-challenge` and `x-atelier-nonce` headers). `GET /` answers `Atelier report collector`.
- `src/policy.js`: the limits, the proof of work's difficulty, the statuses; the admin Worker reads them too.
- `src/scrub.js`: the second-line secret scrubber.
- The D1 schema is `deploy/admin/migrations` (one database, `atelier-admin`, for the collector, the admin panel and the
  update feed's download counts).

## What it keeps, and for how long

- **The report**, in R2 (`atelier-reports`): `reports/<id>/report.json` (the envelope with its diagnostics),
  `chat.json` when a chat was attached, and the screenshots as `shot0.webp`, `shot1.png`… Every string in the report
  and the chat goes through `src/scrub.js` first: API keys and tokens by their shape (`sk-…`, `ghp_…`, `AKIA…`, JWTs,
  `Bearer …`, PEM private keys), values of secret-looking names (`password=…`, `"api_key": "…"`), and passwords in
  addresses. The app has redacted all of this already; what the collector still finds is replaced and counted in the
  row's `scrubbed`, which points at a hole in the app's redaction.
- **A row in D1** `reports` with what the inbox lists: id, kind, title, description, contact, status, labels, the
  owner's note, version, surface, mode, OS, sizes, the content hash (so a retry finds its row), times.
- Both stay until the owner deletes the report, and at most 365 days: the admin Worker's daily cron deletes older
  reports with their files.
- **Never an address.** The per-address daily quota is keyed by HMAC-SHA256(`CHALLENGE_SECRET`, `<day>|<address>`),
  which can't be turned back into an address; these rows are deleted after two days. Observability is off in
  `wrangler.toml`, so no request logs exist either.
- A count of reports per day (`report_days`, for the daily cap and the proof of work) and the bytes stored
  (`collector_state`).

## Limits

| What | Limit | Answer |
|---|---|---|
| Reports per address and minute | 4 (`REPORT_LIMITER`, approximate, per Cloudflare location) | 429 `{ error, retryAfter }` |
| Challenges per address and minute | 12 (`CHALLENGE_LIMITER`) | 429 |
| The whole body | `REPORT_LIMITS.bodyBytes` (14 MB): refused from `content-length` before reading, and cut off while reading | 413 |
| Each part | report 1 MB, chat 3 MB, each screenshot 2.5 MB | 413 |
| Challenge | signed (HMAC), valid 10 minutes, checked before the body is read | 403 |
| Proof of work | `sha256(powInput(challenge, contentHash, nonce))` starts with the challenge's bits: 18 below 200 reports today, 20 below 800, else 22 | 403 |
| Reports per address and day | 20 | 429 |
| Reports per day, from everyone | 1,500 | 503 |
| Everything stored | 8 GB | 503 "The collector is full." |

The content hash is the SHA-256 of the lines `<part name>:<SHA-256 of its bytes>` in the order the parts came, so the
proof binds the exact bytes sent. Sending the same report again (a retry after a lost answer) returns the first
receipt with 200 and stores nothing; it counts against the rate limit, not the quota. Pictures must be PNG, JPEG or
WebP by their first bytes, of the type and size the report lists; nothing else (SVG least of all) is taken. There are
no CORS headers: the app posts from Node, and a page on another site can't send a report.

Parsing, hashing and checking a large report takes more CPU than the Workers Free plan's 10 ms allow; small reports
fit, a report with a long chat and four screenshots needs the Paid plan (its default of 30 s is plenty).

## Deploy

From a checkout of the whole repository (the Worker bundles `packages/protocol/src/reports.ts`). The database, its
migrations and the bucket are shared with the admin panel; `deploy/admin/README.md` creates them. Then:

```bash
cd deploy/reports
openssl rand -hex 32 | npx wrangler secret put CHALLENGE_SECRET
npx wrangler deploy
curl https://reports.atelierhq.dev/                       # Atelier report collector
curl -X POST https://reports.atelierhq.dev/v1/challenge   # { challenge, bits, expiresAt }
```

- Put the `database_id` that `wrangler d1 create atelier-admin` printed into `wrangler.toml` (and into
  `deploy/admin/wrangler.toml` and `deploy/cloudflare/wrangler.toml`). The zero id there is a placeholder that works for
  local development only.
- `atelierhq.dev` must be a zone in the same account; `wrangler deploy` creates the custom domain from `routes`.
- The rate limiting `namespace_id`s (7301, 7302) must be unused in the account (the co-op relay has 4201, 4202).
- Changing `CHALLENGE_SECRET` invalidates challenges handed out in the last ten minutes, and starts the per-address
  quota afresh.
- Without `CHALLENGE_SECRET` the collector answers 503 to everything but `GET /`.

## Test

```bash
node --test deploy/reports/src/*.test.mjs      # the Worker and the scrubber, with D1 (node:sqlite) and R2 faked
```

The fakes are in `deploy/admin/test/fakes.mjs`. To send real reports through a local collector, see
`deploy/admin/README.md` (Local development): `scripts/seed.mjs` posts its fake reports through it, proof of work and
all.
