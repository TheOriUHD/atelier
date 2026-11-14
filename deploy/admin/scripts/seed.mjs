#!/usr/bin/env node
/**
 * Fills the local admin panel (dev.mjs) with fake data, the way production gets it:
 *
 *   - reports (fixtures.mjs: a Mac with Ollama and a long Code chat, Windows with an RTX 4090 and ComfyUI, a Linux
 *     server used from a browser, a feature request without diagnostics, and more), each checked against the
 *     protocol, then POSTed THROUGH the local collector: challenge, proof of work, multipart parts, screenshots as
 *     small PNGs drawn here. Each comes from its own TEST-NET address (wrangler dev passes cf-connecting-ip through),
 *     as from different people, so the per-address limits don't stop a second run;
 *   - then, straight into the local D1: the reports' received times spread over the past weeks, a few statuses, labels
 *     and notes, and 90 days of download counts, update checks and GitHub release counters (replacing earlier ones).
 *
 *   node deploy/admin/scripts/seed.mjs [--collector http://127.0.0.1:8787] [--reports-only] [--stats-only]
 *
 * Local only: it refuses a collector that isn't on localhost, and runs wrangler with --local.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  contentHashInput,
  leadingZeroBits,
  POW_HEADERS,
  powInput,
  ReportChat,
  ReportEnvelope,
  reportTextProblem,
} from '../../../packages/protocol/src/reports.ts';
import { STATE } from './dev.mjs';
import { FIXTURES } from './fixtures.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const COLLECTOR = value('--collector', 'http://127.0.0.1:8787').replace(/\/+$/, '');
if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(COLLECTOR)) {
  console.error(`refusing ${COLLECTOR}: the seed is for the local collector only`);
  process.exit(2);
}
const ADMIN_DIR = new URL('..', import.meta.url).pathname;
const DAY = 86_400_000;

// ------------------------------------------------------------------ pictures

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A PNG of `width`×`height` from a function giving each pixel's [r, g, b]. */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
/** Something that looks like an Atelier window: sidebar, header, lines of text, and one accent block. */
function screenshot(kind) {
  const dark = kind === 'session' || kind === 'error';
  const [paper, sidebar, ink, line, accent] = (
    dark
      ? ['#151515', '#111111', '#3a3a38', '#262624', kind === 'error' ? '#d03b3b' : '#c6613f']
      : ['#fcfcfb', '#fafaf8', '#c9c8c2', '#ecebe6', kind === 'images' ? '#2a78d6' : '#c6613f']
  ).map(hexRgb);
  const width = 960;
  const height = 600;
  return {
    width,
    height,
    bytes: png(width, height, (x, y) => {
      if (y < 36) return y === 35 ? line : sidebar;
      if (x < 220) {
        if (x === 219) return line;
        const row = Math.floor((y - 52) / 30);
        return row >= 0 && row < 12 && (y - 52) % 30 < 10 && x > 20 && x < 70 + ((row * 37) % 120) ? ink : sidebar;
      }
      if (kind === 'mock')
        return x > 260 && x < 900 && y > 80 && y < 520 && ((y - 80) % 44 < 2 || x === 261 || x === 899) ? ink : paper;
      const block =
        kind === 'images'
          ? x > 300 && x < 620 && y > 120 && y < 440
          : kind === 'upload'
            ? x > 300 && x < 300 + 560 * 0.99 && y > 300 && y < 312
            : kind === 'error'
              ? x > 280 && x < 900 && y > 470 && y < 530
              : false;
      if (block) return accent;
      const row = Math.floor((y - 70) / 26);
      return row >= 0 && row < 18 && (y - 70) % 26 < 9 && x > 280 && x < 300 + ((row * 151) % 560) ? ink : paper;
    }),
  };
}

// ------------------------------------------------------------------ the collector, as the app uses it

const sha = (data) => createHash('sha256').update(data).digest('hex');

function solve(challenge, bits, contentHash) {
  for (let n = 0; ; n++) {
    const nonce = n.toString(36);
    if (
      leadingZeroBits(
        createHash('sha256')
          .update(powInput(challenge, contentHash, nonce))
          .digest(),
      ) >= bits
    )
      return nonce;
  }
}

async function send(fixture) {
  const shots = (fixture.shots ?? []).map((s) => ({ name: s.name, ...screenshot(s.kind) }));
  const envelope = {
    ...fixture.envelope,
    attachments: {
      chat: Boolean(fixture.chat),
      screenshots: shots.map((s) => ({
        name: s.name,
        mime: 'image/png',
        width: s.width,
        height: s.height,
        bytes: s.bytes.byteLength,
      })),
    },
  };
  for (const field of ['title', 'description']) {
    const problem = reportTextProblem(field, envelope[field]);
    if (problem) throw new Error(`${envelope.title}: the ${field} wouldn't be sent: ${problem}`);
  }
  const checked = ReportEnvelope.safeParse(envelope);
  if (!checked.success)
    throw new Error(
      `${envelope.title}: not a valid report: ${checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  if (fixture.chat) {
    const chat = ReportChat.safeParse(fixture.chat);
    if (!chat.success)
      throw new Error(
        `${envelope.title}: not a valid chat: ${chat.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
  }
  const enc = new TextEncoder();
  const parts = [
    { name: 'report', type: 'application/json', file: 'report.json', bytes: enc.encode(JSON.stringify(envelope)) },
    ...(fixture.chat
      ? [{ name: 'chat', type: 'application/json', file: 'chat.json', bytes: enc.encode(JSON.stringify(fixture.chat)) }]
      : []),
    ...shots.map((s) => ({ name: s.name, type: 'image/png', file: `${s.name}.png`, bytes: s.bytes })),
  ];
  const contentHash = sha(contentHashInput(parts.map((p) => ({ name: p.name, sha256: sha(p.bytes) }))));
  // A TEST-NET-2 address per report and run: different people, as far as the limits can tell.
  const ip = `198.51.100.${randomInt(1, 255)}`;
  const headers = { 'user-agent': `Atelier/${envelope.app.version}`, 'cf-connecting-ip': ip };
  const ch = await (await fetch(`${COLLECTOR}/v1/challenge`, { method: 'POST', headers })).json();
  if (!ch.challenge) throw new Error(`no challenge: ${JSON.stringify(ch)}`);
  const started = Date.now();
  const nonce = solve(ch.challenge, ch.bits, contentHash);
  const form = new FormData();
  for (const p of parts) form.append(p.name, new Blob([p.bytes], { type: p.type }), p.file);
  const res = await fetch(`${COLLECTOR}/v1/reports`, {
    method: 'POST',
    headers: { ...headers, [POW_HEADERS.challenge]: ch.challenge, [POW_HEADERS.nonce]: nonce },
    body: form,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${envelope.title}: the collector answered ${res.status}: ${body.error}`);
  console.log(`${res.status} ${body.id}  ${envelope.title}  (${ch.bits} bits in ${Date.now() - started} ms)`);
  return body;
}

// ------------------------------------------------------------------ the local database

const q = (v) =>
  v === null || v === undefined
    ? 'NULL'
    : typeof v === 'number'
      ? String(Math.round(v))
      : `'${String(v).replace(/'/g, "''")}'`;
function sqlFile(statements) {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-seed-'));
  const file = join(dir, 'seed.sql');
  writeFileSync(file, statements.join('\n'));
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}
function execute(statements) {
  const { file, done } = sqlFile(statements);
  try {
    const r = spawnSync(
      'npx',
      ['--yes', 'wrangler@4', 'd1', 'execute', 'atelier-admin', '--local', '--persist-to', STATE, '--file', file],
      { cwd: ADMIN_DIR, encoding: 'utf8', env: { ...process.env, npm_config_prefer_offline: 'true', CI: '1' } },
    );
    if (r.status !== 0) throw new Error(`wrangler d1 execute failed:\n${r.stdout}\n${r.stderr}`);
  } finally {
    done();
  }
}
/** Rows as multi-row INSERTs of at most 200 rows. */
function inserts(table, columns, rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 200)
    out.push(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${rows
        .slice(i, i + 200)
        .map((r) => `(${r.map(q).join(', ')})`)
        .join(', ')};`,
    );
  return out;
}

// ------------------------------------------------------------------ download counts

/** A small seeded random generator, so every run draws the same curves. */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const RELEASES = [
  { version: '0.6.0', daysAgo: 95 },
  { version: '0.7.0', daysAgo: 62 },
  { version: '0.7.1', daysAgo: 53 },
  { version: '0.8.0', daysAgo: 31 },
  { version: '0.8.1', daysAgo: 15 },
  { version: '0.8.2', daysAgo: 4 },
];
const BETA = { version: '0.9.0-beta.1', daysAgo: 2 };
const PLATFORMS = [
  {
    platform: 'mac-arm64',
    share: 0.36,
    file: (v) => `Atelier-${v}-arm64.dmg`,
    update: (v) => `Atelier-${v}-arm64-mac.zip`,
  },
  { platform: 'mac-x64', share: 0.05, file: (v) => `Atelier-${v}.dmg`, update: (v) => `Atelier-${v}-mac.zip` },
  {
    platform: 'windows-x64',
    share: 0.27,
    file: (v) => `Atelier-Setup-${v}-x64.exe`,
    update: (v) => `Atelier-Setup-${v}-x64.exe`,
  },
  {
    platform: 'windows-arm64',
    share: 0.03,
    file: (v) => `Atelier-Setup-${v}-arm64.exe`,
    update: (v) => `Atelier-Setup-${v}-arm64.exe`,
  },
  {
    platform: 'linux-x64',
    share: 0.08,
    file: (v) => `Atelier-${v}-amd64.deb`,
    update: (v) => `Atelier-${v}-amd64.deb`,
  },
  { platform: 'linux-x64', share: 0.07, file: (v) => `Atelier-${v}.AppImage`, update: (v) => `Atelier-${v}.AppImage` },
  {
    platform: 'linux-arm64',
    share: 0.02,
    file: (v) => `Atelier-${v}-arm64.AppImage`,
    update: (v) => `Atelier-${v}-arm64.AppImage`,
  },
  { platform: 'cli-mac-arm64', share: 0.05, file: (v) => `atelier-cli-${v}-darwin-arm64.tar.gz`, update: null },
  { platform: 'cli-linux-x64', share: 0.05, file: (v) => `atelier-cli-${v}-linux-x64.tar.gz`, update: null },
  { platform: 'cli-windows-x64', share: 0.02, file: (v) => `atelier-cli-${v}-windows-x64.zip`, update: null },
];
const COUNTRIES = [
  ['US', 24],
  ['DE', 20],
  ['GB', 7],
  ['FR', 6],
  ['IN', 6],
  ['JP', 5],
  ['NL', 4],
  ['BR', 4],
  ['CA', 3],
  ['PL', 3],
  ['SE', 2],
  ['CH', 2],
  ['ES', 2],
  ['KR', 2],
  ['AU', 2],
  ['AT', 1],
  ['XX', 1],
];
const COUNTRY_TOTAL = COUNTRIES.reduce((n, [, w]) => n + w, 0);

function stats() {
  const rand = random(20261114);
  const pick = () => {
    let r = rand() * COUNTRY_TOTAL;
    for (const [c, w] of COUNTRIES) if ((r -= w) < 0) return c;
    return 'XX';
  };
  const downloads = new Map();
  const add = (day, channel, file, version, platform, kind, n) => {
    for (let i = 0; i < n; i++) {
      const key = [day, channel, file, version, platform, kind, pick()].join('|');
      downloads.set(key, (downloads.get(key) ?? 0) + 1);
    }
  };
  const checks = new Map();
  const ghDaily = new Map();
  const now = Date.now();
  let installed = 180;
  for (let back = 89; back >= 0; back--) {
    const t = now - back * DAY;
    const day = dayOf(t);
    const current = [...RELEASES].reverse().find((r) => r.daysAgo >= back) ?? RELEASES[0];
    const weekday = new Date(t).getUTCDay();
    const base = (34 + (89 - back) * 0.9) * (weekday === 0 || weekday === 6 ? 0.7 : 1) * (0.8 + rand() * 0.4);
    const released = RELEASES.find((r) => r.daysAgo === back);
    const people = Math.round(base * (released ? 1.6 : 1));
    for (const p of PLATFORMS)
      add(
        day,
        'stable',
        p.file(current.version),
        current.version,
        p.platform,
        'download',
        Math.round(people * p.share * (0.7 + rand() * 0.6)),
      );
    if (back <= BETA.daysAgo)
      add(
        day,
        'beta',
        `Atelier-${BETA.version}-arm64.dmg`,
        BETA.version,
        'mac-arm64',
        'download',
        2 + Math.round(rand() * 3),
      );
    // An installed base that grows with the downloads, updating over the days after each release.
    installed += people * 0.55;
    for (const r of RELEASES) {
      const since = r.daysAgo - back;
      const share = [0.5, 0.22, 0.1, 0.05, 0.03][since];
      if (share === undefined) continue;
      for (const p of PLATFORMS.filter((x) => x.update))
        add(
          day,
          'stable',
          p.update(r.version),
          r.version,
          p.platform,
          'update',
          Math.round(installed * share * p.share),
        );
    }
    add(day, '', 'install', '', 'server', 'install-script', Math.round(2 + rand() * 4));
    add(day, '', 'cli', '', 'cli-unix', 'install-script', Math.round(3 + rand() * 6));
    add(day, '', 'cli.ps1', '', 'cli-windows', 'install-script', Math.round(rand() * 2));
    add(
      day,
      '',
      'atelier-setup-linux-amd64',
      current.version,
      'server-linux-x64',
      'server-setup',
      Math.round(1 + rand() * 3),
    );
    add(
      day,
      '',
      'atelier-setup-linux-arm64',
      current.version,
      'server-linux-arm64',
      'server-setup',
      Math.round(rand() * 1.5),
    );
    // Update checks: every five minutes while an app runs, about six hours a day; the version is never known.
    const running = installed * (weekday === 0 || weekday === 6 ? 0.45 : 0.75);
    for (const [platform, share] of [
      ['mac', 0.5],
      ['windows', 0.33],
      ['linux-x64', 0.13],
      ['linux-arm64', 0.02],
      ['cli', 0.02],
    ]) {
      checks.set(`${day}|stable|${platform}|unknown`, Math.round(running * share * 72 * (0.9 + rand() * 0.2)));
      if (back <= BETA.daysAgo && platform === 'mac')
        checks.set(`${day}|beta|mac|unknown`, Math.round(4 * 72 * (0.8 + rand() * 0.4)));
    }
    ghDaily.set(day, people);
  }
  // GitHub's counters, read daily for the last 30 days: each release's assets grow with the website's old links.
  const github = [];
  const assets = (v) => [
    `Atelier-${v}-arm64.dmg`,
    `Atelier-${v}.dmg`,
    `Atelier-Setup-${v}-x64.exe`,
    `Atelier-Setup-${v}-arm64.exe`,
    `Atelier-${v}-amd64.deb`,
    `Atelier-${v}.AppImage`,
    `Atelier-${v}-arm64-mac.zip`,
    `atelier-setup-linux-amd64`,
  ];
  const weights = [0.42, 0.06, 0.24, 0.03, 0.09, 0.08, 0.05, 0.03];
  const totals = new Map();
  for (let back = 89; back >= 0; back--) {
    const day = dayOf(now - back * DAY);
    for (const r of [...RELEASES, BETA]) {
      if (r.daysAgo < back) continue;
      const age = r.daysAgo - back;
      const daily = (ghDaily.get(day) ?? 30) * 0.4 * Math.exp(-age / 12) + 0.5;
      assets(r.version).forEach((a, i) => {
        const key = `v${r.version}|${a}`;
        totals.set(key, (totals.get(key) ?? 0) + daily * weights[i]);
        if (back < 30) github.push([day, `v${r.version}`, a, Math.round(totals.get(key))]);
      });
    }
  }
  return {
    downloads: [...downloads].map(([k, count]) => [...k.split('|'), count]),
    checks: [...checks].map(([k, count]) => [...k.split('|'), count]),
    github,
  };
}

// ------------------------------------------------------------------ run

if (!flag('--stats-only')) {
  const statements = [];
  for (const f of FIXTURES) {
    const receipt = await send(f);
    const at = Date.now() - (f.receivedAgo ?? 0);
    statements.push(
      `UPDATE reports SET received_at = ${at}, updated_at = ${at}${f.status ? `, status = ${q(f.status)}` : ''}${f.labels ? `, labels = ${q(JSON.stringify(f.labels))}` : ''}${f.note ? `, note = ${q(f.note)}` : ''}${f.seen ? `, seen_at = ${at + 3_600_000}` : ''} WHERE id = ${q(receipt.id)};`,
    );
  }
  execute(statements);
  console.log(`${FIXTURES.length} reports, backdated`);
}
if (!flag('--reports-only')) {
  const s = stats();
  execute([
    'DELETE FROM downloads;',
    'DELETE FROM update_checks;',
    'DELETE FROM github_snapshots;',
    ...inserts(
      'downloads',
      ['day', 'channel', 'file', 'version', 'platform', 'kind', 'country', 'count'],
      s.downloads.map((r) => [...r.slice(0, 7), Number(r[7])]),
    ),
    ...inserts(
      'update_checks',
      ['day', 'channel', 'platform', 'version', 'count'],
      s.checks.map((r) => [...r.slice(0, 4), Number(r[4])]),
    ),
    ...inserts('github_snapshots', ['day', 'tag', 'asset', 'downloads'], s.github),
  ]);
  console.log(
    `${s.downloads.length} download rows, ${s.checks.length} update-check rows, ${s.github.length} GitHub readings`,
  );
}
