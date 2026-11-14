/**
 * The admin Worker's daily jobs (wrangler.toml `crons`), each on its own so one that fails doesn't stop the others:
 *
 *   github   reads the download counters of every asset of every GitHub release into `github_snapshots`
 *   reports  deletes reports older than POLICY.retentionDays, with their files
 *   quota    deletes the per-address quota rows older than POLICY.quotaDays
 *   bytes    recounts what the reports take, in case a deletion was cut short
 */
import { dayOf, POLICY, STORED_BYTES } from '../../reports/src/policy.js';
import { DAY_MS, deleteReports } from './api.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function snapshotGithub(env, now = Date.now()) {
  const repo = env.GITHUB_REPO || 'TheOriUHD/atelier';
  if (!REPO.test(repo)) throw new Error('GITHUB_REPO is not owner/name');
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'atelier-admin',
    'x-github-api-version': '2022-11-28',
    // Optional: without a token GitHub allows 60 requests an hour per address, which Workers share.
    ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };
  const day = dayOf(now);
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const releases = await res.json();
    if (!Array.isArray(releases)) throw new Error('GitHub sent something other than a list');
    for (const release of releases) {
      for (const asset of release.assets ?? []) {
        if (
          typeof release.tag_name === 'string' &&
          typeof asset.name === 'string' &&
          Number.isFinite(asset.download_count)
        )
          rows.push([day, release.tag_name, asset.name, asset.download_count]);
      }
    }
    if (releases.length < 100) break;
  }
  const insert = env.DB.prepare(
    'INSERT INTO github_snapshots (day, tag, asset, downloads) VALUES (?, ?, ?, ?) ON CONFLICT (day, tag, asset) DO UPDATE SET downloads = excluded.downloads',
  );
  for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50).map((r) => insert.bind(...r)));
  return { assets: rows.length };
}

export async function deleteOldReports(env, now = Date.now()) {
  const before = now - POLICY.retentionDays * DAY_MS;
  let deleted = 0;
  // A few hundred a day at most; a backlog is worked off over the next days.
  for (let round = 0; round < 10; round++) {
    const { results } = await env.DB.prepare(
      'SELECT id FROM reports WHERE received_at < ? ORDER BY received_at LIMIT 200',
    )
      .bind(before)
      .all();
    if (!results.length) break;
    deleted += await deleteReports(
      env,
      results.map((r) => r.id),
    );
  }
  return { deleted };
}

export async function deleteOldQuota(env, now = Date.now()) {
  const res = await env.DB.prepare('DELETE FROM report_quota WHERE day < ?')
    .bind(dayOf(now - POLICY.quotaDays * DAY_MS))
    .run();
  return { deleted: res.meta?.changes ?? 0 };
}

export async function recountBytes(env) {
  await env.DB.prepare('UPDATE collector_state SET value = (SELECT COALESCE(SUM(bytes), 0) FROM reports) WHERE key = ?')
    .bind(STORED_BYTES)
    .run();
  return { ok: true };
}

/** Runs every job; returns what each did, or its error. */
export async function daily(env, now = Date.now()) {
  const out = {};
  for (const [name, job] of Object.entries({
    github: snapshotGithub,
    reports: deleteOldReports,
    quota: deleteOldQuota,
    bytes: recountBytes,
  })) {
    try {
      out[name] = await job(env, now);
    } catch (error) {
      out[name] = { error: String(error?.message ?? error) };
    }
  }
  return out;
}
