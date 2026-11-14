/**
 * The admin panel's API (README.md): reports from the collector, download counts from the update feed, and the
 * collector's limits, all read from the shared `atelier-admin` database and the reports bucket. Every route here is
 * behind verifyAccess (access.js) and, when it changes something, the CSRF check in index.js.
 *
 * Report content is untrusted: it is handed out as JSON (never as HTML), and pictures only with their stored image type,
 * `nosniff` and a sandboxing content security policy.
 */
import { compareVersions } from '../../cloudflare/src/latest.js';
import {
  BITS_STEPS,
  bitsFor,
  CLOSED_STATUSES,
  dayOf,
  POLICY,
  reportPrefix,
  STATUSES,
  STORED_BYTES,
} from '../../reports/src/policy.js';

export const DAY_MS = 86_400_000;
const ID = /^[IF]-[0-9A-HJKMNP-TV-Z]{6}$/;
const FILE = /^shot[0-3]\.(?:webp|jpg|png)$/;
const IMAGE_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);
/** D1 takes at most 100 bound values per statement. */
const CHUNK = 90;

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
export const fail = (status, error) => json({ error }, status);

const chunks = (list, size = CHUNK) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
const marks = (n) => new Array(n).fill('?').join(', ');
const all = async (env, sql, ...params) =>
  (
    await env.DB.prepare(sql)
      .bind(...params)
      .all()
  ).results;
const first = (env, sql, ...params) =>
  env.DB.prepare(sql)
    .bind(...params)
    .first();

function intParam(url, name, fallback, min, max) {
  const n = Number.parseInt(url.searchParams.get(name) ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** The newest version among `versions`: the newest release, or the newest prerelease when there is no release. */
export function newestVersion(versions) {
  const valid = versions
    .filter((v) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(v))
    .sort((a, b) => compareVersions(b, a));
  return valid.find((v) => !v.includes('-')) ?? valid[0] ?? null;
}

// ------------------------------------------------------------------ reports

/** A D1 row as the panel sees it. `full` adds the long and private fields. */
function rowOut(r, full = false) {
  let labels = [];
  try {
    labels = JSON.parse(r.labels);
  } catch {
    // An unreadable value is no labels.
  }
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    labels: Array.isArray(labels) ? labels.filter((l) => typeof l === 'string') : [],
    version: r.app_version,
    surface: r.surface,
    mode: r.mode,
    os: r.os,
    osName: r.os_name,
    arch: r.arch,
    hasDiagnostics: Boolean(r.has_diagnostics),
    hasChat: Boolean(r.has_chat),
    screenshots: r.screenshots,
    hasContact: Boolean(r.contact),
    bytes: r.bytes,
    scrubbed: r.scrubbed,
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
    seenAt: r.seen_at,
    ...(full ? { description: r.description, contact: r.contact, note: r.note } : {}),
  };
}

/** The WHERE clause of the inbox's filters, as `{ sql, params }`. */
function filters(url, kind) {
  const where = ['kind = ?'];
  const params = [kind];
  const status = url.searchParams.get('status') ?? '';
  if (status === 'open') {
    where.push(`status NOT IN (${marks(CLOSED_STATUSES.length)})`);
    params.push(...CLOSED_STATUSES);
  } else if (status === 'unseen') where.push('seen_at IS NULL');
  else if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const version = url.searchParams.get('version') ?? '';
  if (version) {
    where.push('app_version = ?');
    params.push(version);
  }
  const os = url.searchParams.get('os') ?? '';
  if (os) {
    where.push('os IS ?');
    params.push(os === 'none' ? null : os);
  }
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  return { sql: where.join(' AND '), params };
}

const LIST_COLUMNS =
  'id, kind, title, status, labels, app_version, surface, mode, os, os_name, arch, has_diagnostics, has_chat, screenshots, bytes, scrubbed, received_at, updated_at, seen_at, contact';

async function listReports(env, url) {
  const kind = url.searchParams.get('kind');
  if (kind !== 'issue' && kind !== 'feature') return fail(400, 'Say kind=issue or kind=feature.');
  const limit = intParam(url, 'limit', 100, 1, 500);
  const { sql, params } = filters(url, kind);
  // The cursor is the last row's `<receivedAt>_<id>`: the next page starts after it.
  let page = sql;
  const pageParams = [...params];
  const before = /^(\d{1,16})(?:_([IF]-[0-9A-Z]{6}))?$/.exec(url.searchParams.get('before') ?? '');
  if (before) {
    page += ' AND (received_at < ? OR (received_at = ? AND id < ?))';
    pageParams.push(Number(before[1]), Number(before[1]), before[2] ?? '');
  }
  const [rows, total, versions, systems, statuses] = await Promise.all([
    all(
      env,
      `SELECT ${LIST_COLUMNS} FROM reports WHERE ${page} ORDER BY received_at DESC, id DESC LIMIT ?`,
      ...pageParams,
      limit + 1,
    ),
    first(env, `SELECT COUNT(*) AS n FROM reports WHERE ${sql}`, ...params),
    all(env, 'SELECT app_version AS value, COUNT(*) AS count FROM reports WHERE kind = ? GROUP BY app_version', kind),
    all(env, 'SELECT os AS value, COUNT(*) AS count FROM reports WHERE kind = ? GROUP BY os ORDER BY count DESC', kind),
    all(
      env,
      'SELECT status AS value, COUNT(*) AS count, SUM(seen_at IS NULL) AS unseen FROM reports WHERE kind = ? GROUP BY status',
      kind,
    ),
  ]);
  const more = rows.length > limit;
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return json({
    rows: shown.map((r) => rowOut(r)),
    next: more && last ? `${last.received_at}_${last.id}` : null,
    total: total?.n ?? 0,
    statuses: STATUSES[kind],
    closed: CLOSED_STATUSES,
    facets: {
      versions: versions.sort((a, b) => compareVersions(String(b.value), String(a.value))),
      os: systems.map((s) => ({ value: s.value ?? 'none', count: s.count })),
      statuses: Object.fromEntries(statuses.map((s) => [s.value, s.count])),
      unseen: statuses.reduce((n, s) => n + (s.unseen ?? 0), 0),
    },
  });
}

async function reportRow(env, id) {
  return first(env, 'SELECT * FROM reports WHERE id = ?', id);
}

async function getReport(env, id) {
  const row = await reportRow(env, id);
  if (!row) return fail(404, 'No such report.');
  const [object, listed] = await Promise.all([
    env.REPORTS.get(`${reportPrefix(id)}report.json`),
    env.REPORTS.list({ prefix: reportPrefix(id) }),
  ]);
  let report = null;
  try {
    report = object ? await object.json() : null;
  } catch {
    // A file that doesn't parse shows as missing.
  }
  const files = listed.objects
    .map((o) => ({ name: o.key.slice(reportPrefix(id).length), size: o.size }))
    .filter((f) => FILE.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return json({ row: rowOut(row, true), report, files, statuses: STATUSES[row.kind] });
}

async function getChat(env, id) {
  const object = await env.REPORTS.get(`${reportPrefix(id)}chat.json`);
  if (!object) return fail(404, 'This report has no chat.');
  return new Response(object.body, { headers });
}

async function getFile(env, id, name) {
  if (!FILE.test(name)) return fail(404, 'No such file.');
  const object = await env.REPORTS.get(`${reportPrefix(id)}${name}`);
  const type = object?.httpMetadata?.contentType;
  if (!object || !IMAGE_TYPES.has(type)) return fail(404, 'No such file.');
  return new Response(object.body, {
    headers: {
      'content-type': type,
      'content-length': String(object.size),
      'content-disposition': `inline; filename="${id}-${name}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=3600',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

/** The labels a person typed: trimmed, at most 20 of at most 40 characters each, no repeats. */
function cleanLabels(value) {
  if (!Array.isArray(value) || value.length > 20 || value.some((l) => typeof l !== 'string')) return null;
  const out = [];
  for (const raw of value) {
    const label = raw.trim().replace(/\s+/g, ' ');
    if (!label || label.length > 40) return null;
    if (!out.some((l) => l.toLowerCase() === label.toLowerCase())) out.push(label);
  }
  return out;
}

async function readJson(request, max = 100_000) {
  const text = await request.text();
  if (text.length > max) return { error: 'That request is too big.' };
  try {
    const value = JSON.parse(text || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 'Send a JSON object.' };
  } catch {
    return { error: "That request isn't valid JSON." };
  }
}

async function patchReport(request, env, id) {
  const row = await reportRow(env, id);
  if (!row) return fail(404, 'No such report.');
  const body = await readJson(request);
  if (body.error) return fail(400, body.error);
  const { status, labels, note, seen } = body.value;
  const set = [];
  const params = [];
  const now = Date.now();
  if (status !== undefined) {
    if (!STATUSES[row.kind].includes(status))
      return fail(
        400,
        `A ${row.kind === 'issue' ? 'issue' : 'feature request'} can't be "${String(status).slice(0, 40)}".`,
      );
    set.push('status = ?');
    params.push(status);
  }
  if (labels !== undefined) {
    const clean = cleanLabels(labels);
    if (!clean) return fail(400, 'Labels are up to 20 words or short phrases, of at most 40 characters.');
    set.push('labels = ?');
    params.push(JSON.stringify(clean));
  }
  if (note !== undefined) {
    if (typeof note !== 'string' || note.length > 20_000)
      return fail(400, 'The note is text of at most 20,000 characters.');
    set.push('note = ?');
    params.push(note);
  }
  // Opening a report marks it seen; that alone isn't an edit.
  if (set.length) {
    set.push('updated_at = ?');
    params.push(now);
  }
  if (seen !== undefined) {
    if (typeof seen !== 'boolean') return fail(400, '`seen` is true or false.');
    set.push(seen ? 'seen_at = COALESCE(seen_at, ?)' : 'seen_at = NULL');
    if (seen) params.push(now);
  }
  if (!set.length) return fail(400, 'Nothing to change: send status, labels, note or seen.');
  await env.DB.prepare(`UPDATE reports SET ${set.join(', ')} WHERE id = ?`)
    .bind(...params, id)
    .run();
  return json({ row: rowOut(await reportRow(env, id), true) });
}

/** Deletes reports with their files; the bytes they took come off the collector's total. Returns how many there were. */
export async function deleteReports(env, ids) {
  let deleted = 0;
  for (const part of chunks(ids)) {
    const found = await all(env, `SELECT id, bytes FROM reports WHERE id IN (${marks(part.length)})`, ...part);
    if (!found.length) continue;
    // The files first: a row left behind can be deleted again, a file without its row would never be seen.
    const keys = [];
    for (const { id } of found) {
      let cursor;
      do {
        const listed = await env.REPORTS.list({ prefix: reportPrefix(id), ...(cursor ? { cursor } : {}) });
        keys.push(...listed.objects.map((o) => o.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
    for (const batch of chunks(keys, 1000)) await env.REPORTS.delete(batch);
    const bytes = found.reduce((n, r) => n + r.bytes, 0);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM reports WHERE id IN (${marks(found.length)})`).bind(...found.map((r) => r.id)),
      env.DB.prepare('UPDATE collector_state SET value = MAX(0, value - ?) WHERE key = ?').bind(bytes, STORED_BYTES),
    ]);
    deleted += found.length;
  }
  return deleted;
}

async function deleteReport(env, id) {
  return (await deleteReports(env, [id]))
    ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    : fail(404, 'No such report.');
}

async function bulk(request, env) {
  const body = await readJson(request, 200_000);
  if (body.error) return fail(400, body.error);
  const { ids, action, status } = body.value;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 1000 ||
    !ids.every((id) => typeof id === 'string' && ID.test(id))
  )
    return fail(400, 'Send `ids`: up to 1,000 report ids.');
  const unique = [...new Set(ids)];
  if (action === 'delete') return json({ deleted: await deleteReports(env, unique) });
  if (action !== 'status') return fail(400, '`action` is "status" or "delete".');
  // A status may be one only issues have, or only feature requests: it changes the reports it fits.
  const kinds = Object.keys(STATUSES).filter((k) => STATUSES[k].includes(status));
  if (!kinds.length) return fail(400, `There is no status "${String(status).slice(0, 40)}".`);
  let updated = 0;
  const now = Date.now();
  for (const part of chunks(unique, CHUNK - 4)) {
    const res = await env.DB.prepare(
      `UPDATE reports SET status = ?, updated_at = ? WHERE id IN (${marks(part.length)}) AND kind IN (${marks(kinds.length)})`,
    )
      .bind(status, now, ...part, ...kinds)
      .run();
    updated += res.meta?.changes ?? 0;
  }
  return json({ updated });
}

// ------------------------------------------------------------------ the collector

export async function limits(env, now = Date.now()) {
  const day = dayOf(now);
  const [today, stored, addresses, kinds] = await Promise.all([
    first(env, 'SELECT count FROM report_days WHERE day = ?', day),
    first(env, 'SELECT value FROM collector_state WHERE key = ?', STORED_BYTES),
    first(env, 'SELECT COUNT(*) AS n, MAX(count) AS busiest FROM report_quota WHERE day = ?', day),
    all(
      env,
      'SELECT kind, COUNT(*) AS count FROM reports WHERE received_at >= ? GROUP BY kind',
      Date.parse(`${day}T00:00:00Z`),
    ),
  ]);
  const count = today?.count ?? 0;
  return {
    day,
    today: count,
    todayByKind: Object.fromEntries(kinds.map((k) => [k.kind, k.count])),
    perDay: POLICY.perDay,
    bits: bitsFor(count),
    bitsSteps: BITS_STEPS.map((s) => ({ below: Number.isFinite(s.below) ? s.below : null, bits: s.bits })),
    storedBytes: stored?.value ?? 0,
    storageBytes: POLICY.storageBytes,
    perAddressPerDay: POLICY.perAddressPerDay,
    addressesToday: addresses?.n ?? 0,
    busiestAddressToday: addresses?.busiest ?? 0,
    rate: POLICY.rate,
    retentionDays: POLICY.retentionDays,
  };
}

// ------------------------------------------------------------------ downloads

/** Days `from`…`today` for a window of `days` days ending today. */
function windowOf(days, now = Date.now()) {
  return { today: dayOf(now), from: dayOf(now - (days - 1) * DAY_MS) };
}

async function overview(env, url) {
  const days = intParam(url, 'days', 30, 1, 365);
  const now = Date.now();
  const { today, from } = windowOf(days, now);
  const d7 = dayOf(now - 6 * DAY_MS);
  const d14 = dayOf(now - 13 * DAY_MS);
  const d30 = dayOf(now - 29 * DAY_MS);
  const earliest = [from, d30, d14].sort()[0];
  const [daily, kinds, versions, checks, reportDays, reportCounts, collector] = await Promise.all([
    all(
      env,
      "SELECT day, platform, SUM(count) AS count FROM downloads WHERE kind = 'download' AND day >= ? GROUP BY day, platform ORDER BY day",
      earliest,
    ),
    all(
      env,
      'SELECT kind, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS d7, SUM(count) AS d30 FROM downloads WHERE day >= ? GROUP BY kind',
      d7,
      d30,
    ),
    all(
      env,
      "SELECT version, SUM(CASE WHEN kind = 'download' THEN count ELSE 0 END) AS downloads, SUM(CASE WHEN kind = 'update' THEN count ELSE 0 END) AS updates, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS d7, MIN(day) AS firstDay FROM downloads WHERE kind IN ('download', 'update') AND version != '' AND day >= ? GROUP BY version",
      d7,
      d30,
    ),
    all(
      env,
      'SELECT day, platform, SUM(count) AS count FROM update_checks WHERE day >= ? GROUP BY day, platform ORDER BY day',
      from,
    ),
    all(
      env,
      "SELECT strftime('%Y-%m-%d', received_at / 1000, 'unixepoch') AS day, kind, COUNT(*) AS count FROM reports WHERE received_at >= ? GROUP BY day, kind ORDER BY day",
      Date.parse(`${from}T00:00:00Z`),
    ),
    all(
      env,
      "SELECT kind, SUM(status = 'new') AS new, SUM(seen_at IS NULL) AS unseen, COUNT(*) AS total FROM reports GROUP BY kind",
    ),
    limits(env, now),
  ]);
  const sum = (rows, test) => rows.filter(test).reduce((n, r) => n + r.count, 0);
  const latest = newestVersion(versions.map((v) => v.version));
  const latestRow = versions.find((v) => v.version === latest);
  const fetched7 = versions.reduce((n, v) => n + v.d7, 0);
  const byKind = Object.fromEntries(kinds.map((k) => [k.kind, { d7: k.d7, d30: k.d30 }]));
  const reports = Object.fromEntries(['issue', 'feature'].map((k) => [k, { new: 0, unseen: 0, total: 0 }]));
  for (const r of reportCounts) reports[r.kind] = { new: r.new ?? 0, unseen: r.unseen ?? 0, total: r.total ?? 0 };
  return json({
    days,
    from,
    today,
    downloads: {
      today: sum(daily, (r) => r.day === today),
      d7: sum(daily, (r) => r.day >= d7),
      prev7: sum(daily, (r) => r.day >= d14 && r.day < d7),
      d30: sum(daily, (r) => r.day >= d30),
      daily: daily.filter((r) => r.day >= from),
      kinds: byKind,
    },
    versions: versions.sort((a, b) => compareVersions(b.version, a.version)).slice(0, 12),
    latest: latest
      ? {
          version: latest,
          since: latestRow.firstDay,
          downloads: latestRow.downloads,
          updates: latestRow.updates,
          share7: fetched7 ? latestRow.d7 / fetched7 : null,
        }
      : null,
    checks: { daily: checks, today: sum(checks, (r) => r.day === today) },
    reports: { ...reports, daily: reportDays },
    collector,
  });
}

async function downloads(env, url) {
  const days = intParam(url, 'days', 90, 1, 730);
  const now = Date.now();
  const { today, from } = windowOf(days, now);
  const before = dayOf(Date.parse(`${from}T00:00:00Z`) - DAY_MS);
  const [daily, versions, countries, files, checks, github, latestDay] = await Promise.all([
    all(
      env,
      'SELECT day, platform, kind, SUM(count) AS count FROM downloads WHERE day >= ? GROUP BY day, platform, kind ORDER BY day',
      from,
    ),
    all(
      env,
      "SELECT version, kind, SUM(count) AS count FROM downloads WHERE day >= ? AND version != '' GROUP BY version, kind",
      from,
    ),
    all(
      env,
      "SELECT country, SUM(count) AS count FROM downloads WHERE kind = 'download' AND day >= ? GROUP BY country ORDER BY count DESC",
      from,
    ),
    all(
      env,
      'SELECT file, kind, SUM(count) AS count FROM downloads WHERE day >= ? GROUP BY file, kind ORDER BY count DESC LIMIT 40',
      from,
    ),
    all(
      env,
      'SELECT day, channel, platform, version, SUM(count) AS count FROM update_checks WHERE day >= ? GROUP BY day, channel, platform, version ORDER BY day',
      from,
    ),
    all(
      env,
      'SELECT day, SUM(downloads) AS total FROM github_snapshots WHERE day >= ? GROUP BY day ORDER BY day',
      before,
    ),
    first(env, 'SELECT MAX(day) AS day FROM github_snapshots'),
  ]);
  // GitHub's counters only grow: a day's downloads are its total minus the day before's (when both were read).
  const ghDaily = [];
  for (let i = 0; i < github.length; i++) {
    const prev = github[i - 1];
    const gap = prev ? (Date.parse(`${github[i].day}T00:00:00Z`) - Date.parse(`${prev.day}T00:00:00Z`)) / DAY_MS : null;
    if (github[i].day >= from)
      ghDaily.push({
        day: github[i].day,
        total: github[i].total,
        delta: gap === 1 ? Math.max(0, github[i].total - prev.total) : null,
      });
  }
  let tags = [];
  if (latestDay?.day) {
    const firstInWindow = github.find((g) => g.day >= from)?.day ?? latestDay.day;
    const [now_, then] = await Promise.all([
      all(
        env,
        'SELECT tag, SUM(downloads) AS downloads, COUNT(*) AS assets FROM github_snapshots WHERE day = ? GROUP BY tag',
        latestDay.day,
      ),
      all(
        env,
        'SELECT tag, SUM(downloads) AS downloads FROM github_snapshots WHERE day = ? GROUP BY tag',
        firstInWindow,
      ),
    ]);
    const thenBy = new Map(then.map((t) => [t.tag, t.downloads]));
    tags = now_
      .map((t) => ({ ...t, delta: Math.max(0, t.downloads - (thenBy.get(t.tag) ?? 0)) }))
      .sort((a, b) => compareVersions(b.tag.replace(/^v/, ''), a.tag.replace(/^v/, '')));
  }
  return json({
    days,
    from,
    today,
    daily,
    versions: versions.sort((a, b) => compareVersions(b.version, a.version)),
    countries,
    files,
    checks,
    github: { day: latestDay?.day ?? null, total: tags.reduce((n, t) => n + t.downloads, 0), daily: ghDaily, tags },
  });
}

// ------------------------------------------------------------------ routing

export async function handle(request, env, url, who) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const get = method === 'GET' || method === 'HEAD';
  if (path === '/api/me' && get) return json({ email: who.email, dev: Boolean(who.dev) });
  if (path === '/api/overview' && get) return overview(env, url);
  if (path === '/api/downloads' && get) return downloads(env, url);
  if (path === '/api/limits' && get) return json(await limits(env));
  if (path === '/api/reports' && get) return listReports(env, url);
  if (path === '/api/reports/bulk' && method === 'POST') return bulk(request, env);
  const m = /^\/api\/reports\/([^/]+)(?:\/(chat|files)(?:\/([^/]+))?)?$/.exec(path);
  if (m) {
    const [, id, sub, name] = m;
    if (!ID.test(id)) return fail(404, 'No such report.');
    if (!sub && get) return getReport(env, id);
    if (!sub && method === 'PATCH') return patchReport(request, env, id);
    if (!sub && method === 'DELETE') return deleteReport(env, id);
    if (sub === 'chat' && !name && get) return getChat(env, id);
    if (sub === 'files' && name && get) return getFile(env, id, name);
    return fail(405, 'Method not allowed.');
  }
  return fail(404, 'Not found.');
}
