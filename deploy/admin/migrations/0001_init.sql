-- The `atelier-admin` database, shared by three Workers (deploy/admin/README.md):
--   deploy/reports     writes reports, report_quota, report_days and collector_state;
--   deploy/cloudflare  writes downloads and update_checks (the update feed's counts);
--   deploy/admin       reads everything, edits reports, writes github_snapshots and cleans up (its daily cron).
-- Apply with `npx wrangler d1 migrations apply atelier-admin --remote` from deploy/admin. Never edit a migration that
-- has been applied: add the next file.

-- One row per report or feature request. The report itself (diagnostics, chat, screenshots) is in R2 under
-- reports/<id>/; these columns are what the inbox lists, filters and searches by. No address is stored, ever.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,                       -- REPORT_ID: 'I-' or 'F-' and six Crockford base-32 characters
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'feature')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  contact TEXT,                              -- whatever the person typed to be answered, or NULL
  status TEXT NOT NULL DEFAULT 'new',
  labels TEXT NOT NULL DEFAULT '[]',         -- a JSON array of strings
  note TEXT NOT NULL DEFAULT '',             -- the owner's private note
  app_version TEXT NOT NULL,
  surface TEXT NOT NULL,                     -- desktop, web, cli
  mode TEXT NOT NULL,                        -- desktop-local, desktop-server, web, cli
  os TEXT,                                   -- the platform: darwin, win32, linux
  os_name TEXT,                              -- "macOS 26.1"
  arch TEXT,
  has_diagnostics INTEGER NOT NULL DEFAULT 0,
  has_chat INTEGER NOT NULL DEFAULT 0,
  screenshots INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL,                    -- what it takes in R2
  content_hash TEXT NOT NULL UNIQUE,         -- of the parts as received: a retry of the same report finds its row
  scrubbed INTEGER NOT NULL DEFAULT 0,       -- how many secrets the collector's own scrubber replaced
  received_at INTEGER NOT NULL,              -- ms since the epoch
  updated_at INTEGER NOT NULL,
  seen_at INTEGER                            -- when the owner first opened it; NULL is unread
);
CREATE INDEX reports_inbox ON reports (kind, received_at DESC, id DESC);
CREATE INDEX reports_status ON reports (kind, status, received_at DESC);
CREATE INDEX reports_version ON reports (kind, app_version);
CREATE INDEX reports_received ON reports (received_at);

-- Reports kept per address and day. `key` is HMAC-SHA256(CHALLENGE_SECRET, "<day>|<address>"): the same address on the
-- same day finds its row, and nothing here can be turned back into an address. Rows older than two days are deleted.
CREATE TABLE report_quota (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL,                         -- YYYY-MM-DD, UTC
  count INTEGER NOT NULL
);
CREATE INDEX report_quota_day ON report_quota (day);

-- Reports kept per day, deleted ones included: the global daily cap and the proof of work's difficulty follow it.
CREATE TABLE report_days (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

-- Running totals the collector reads on every report instead of summing the table: `stored_bytes`. The admin Worker
-- lowers it when it deletes reports and recounts it from `reports` every day.
CREATE TABLE collector_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO collector_state (key, value) VALUES ('stored_bytes', 0);

-- Downloads from the update feed (updates.atelierhq.dev), counted per day. Nothing about who: no address, no id, no
-- user agent; the country is Cloudflare's guess from the address, which isn't kept.
--   kind: download (a person), update (the app itself), update-blockmap, install-script, server-setup
CREATE TABLE downloads (
  day TEXT NOT NULL,
  channel TEXT NOT NULL,                     -- stable, beta, or '' for the install scripts and setup binaries
  file TEXT NOT NULL,
  version TEXT NOT NULL,                     -- from the file name ('' when it has none)
  platform TEXT NOT NULL,                    -- mac-arm64, windows-x64, linux-x64, cli-linux-arm64, server-linux-x64, ...
  kind TEXT NOT NULL,
  country TEXT NOT NULL,                     -- ISO 3166 alpha-2, XX when unknown
  count INTEGER NOT NULL,
  PRIMARY KEY (day, channel, file, kind, country)
);
CREATE INDEX downloads_kind_day ON downloads (kind, day);

-- Apps asking for an update file (latest*.yml, atelier-cli.json): every five minutes while they run, so this is
-- "running copies" weighted by how long they run, by the version they say they are.
CREATE TABLE update_checks (
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  platform TEXT NOT NULL,                    -- windows, mac, linux-x64, linux-arm64, cli
  version TEXT NOT NULL,                     -- 'unknown' when the request didn't say
  count INTEGER NOT NULL,
  PRIMARY KEY (day, channel, platform, version)
);

-- The GitHub release assets' download counters (TheOriUHD/atelier), read once a day: a day's figure minus the day
-- before's is that day's downloads from GitHub.
CREATE TABLE github_snapshots (
  day TEXT NOT NULL,
  tag TEXT NOT NULL,
  asset TEXT NOT NULL,
  downloads INTEGER NOT NULL,
  PRIMARY KEY (day, tag, asset)
);
