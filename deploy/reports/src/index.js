/**
 * Atelier's report collector (README.md): takes issue reports and feature requests from the app and keeps them for the
 * admin panel (deploy/admin). The wire format is packages/protocol/src/reports.ts, bundled from there (wrangler handles
 * TypeScript; `node --test` strips the types), the same file the app sends with.
 *
 *   POST /v1/challenge   a signed challenge for the proof of work
 *   POST /v1/reports     a report: multipart parts `report`, then `chat`, then `shot0`…`shot3`, with the challenge and
 *                        its nonce in headers
 *
 * Against floods, in the order they cost the caller nothing to the order they cost it work: the rate limiting bindings
 * per address, the body's size, the challenge's signature and age (before the body is read), the proof of work over the
 * parts, then the per-address daily quota, the daily cap and the storage cap. Addresses are never stored: the quota is
 * keyed by an HMAC of the day and the address.
 *
 * The app posts from Node, not from a page, so there are no CORS headers: a browser can't send a report from a site.
 */
import {
  contentHashInput,
  leadingZeroBits,
  POW_HEADERS,
  powInput,
  REPORT_LIMITS,
  ReportChat,
  ReportEnvelope,
  reportTextProblem,
} from '../../../packages/protocol/src/reports.ts';
import { bitsFor, dayOf, POLICY, reportPrefix, secondsToMidnight, SHOT_EXTENSIONS, STORED_BYTES } from './policy.js';
import { scrubJson, TooDeep } from './scrub.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);
/** A refusal that says when to try again, as JSON and as `Retry-After`. */
const later = (status, error, retryAfter) => json({ error, retryAfter }, status, { 'retry-after': String(retryAfter) });

const MB = (bytes) => `${(bytes / 1_000_000).toLocaleString('en', { maximumFractionDigits: 1 })} MB`;

// ------------------------------------------------------------------ crypto

const encoder = new TextEncoder();
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (data) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data));
export const sha256hex = async (data) => hex(await sha256(data));

/** The HMAC key, imported once per isolate (and again if the secret changes). */
let hmacKey = { secret: null, key: null };
async function hmac(secret, text) {
  if (hmacKey.secret !== secret)
    hmacKey = {
      secret,
      key: await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ]),
    };
  return hex(await crypto.subtle.sign('HMAC', hmacKey.key, encoder.encode(text)));
}

/** Equal strings, compared in time that doesn't depend on where they differ. */
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ------------------------------------------------------------------ the challenge

const CHALLENGE = /^(\d{1,16})\.(\d{1,2})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;

/** `<expiresAt>.<bits>.<16 random bytes, hex>.<HMAC-SHA256(CHALLENGE_SECRET, the first three fields), hex>`. */
export async function makeChallenge(secret, bits, now = Date.now()) {
  const expiresAt = now + POLICY.challengeTtlMs;
  const head = `${expiresAt}.${bits}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  return { challenge: `${head}.${await hmac(secret, head)}`, bits, expiresAt };
}

/** The challenge's bits when it is one this collector signed and it hasn't expired, else a reason. */
async function checkChallenge(secret, challenge, now) {
  const m = CHALLENGE.exec(challenge ?? '');
  if (!m) return { error: 'Get a challenge first (POST /v1/challenge), then send the report with it.' };
  if (!same(await hmac(secret, `${m[1]}.${m[2]}.${m[3]}`), m[4]))
    return { error: "That challenge isn't one this collector made. Get a new one and try again." };
  if (Number(m[1]) < now) return { error: 'The challenge expired. Get a new one and try again.' };
  return { bits: Number(m[2]) };
}

// ------------------------------------------------------------------ the body

/** The body, read up to `cap` bytes; null when it is longer. */
async function readCapped(request, cap) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const PART_CAPS = { report: REPORT_LIMITS.reportBytes, chat: REPORT_LIMITS.chatBytes };
const SHOT = /^shot[0-3]$/;
const capOf = (name) => PART_CAPS[name] ?? REPORT_LIMITS.screenshotBytes;

/**
 * The parts in the order they came, `{ name, type, bytes }`, or `{ status, error }`. The body is parsed by the runtime's
 * multipart parser; each part's bytes are exactly what was sent (the proof of work hashes them).
 */
async function partsOf(body, contentType) {
  let form;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return { status: 400, error: "The report isn't a readable multipart form." };
  }
  const parts = [];
  for (const [name, value] of form.entries()) {
    if (name !== 'report' && name !== 'chat' && !SHOT.test(name))
      return {
        status: 400,
        error: `The report has a part this collector doesn't take ("${String(name).slice(0, 40)}").`,
      };
    if (parts.some((p) => p.name === name)) return { status: 400, error: `The report has the part "${name}" twice.` };
    const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(await value.arrayBuffer());
    parts.push({ name, type: typeof value === 'string' ? '' : value.type.split(';')[0].trim().toLowerCase(), bytes });
  }
  if (parts[0]?.name !== 'report') return { status: 400, error: 'The report part must come first.' };
  const chatAt = parts.findIndex((p) => p.name === 'chat');
  if (chatAt > 1) return { status: 400, error: 'The chat part must come right after the report part.' };
  for (const p of parts) {
    if (p.bytes.byteLength > capOf(p.name)) {
      const what =
        p.name === 'report'
          ? 'The report part (with its diagnostics)'
          : p.name === 'chat'
            ? 'The chat'
            : `Screenshot ${p.name}`;
      return { status: 413, error: `${what} is too big: at most ${MB(capOf(p.name))}.` };
    }
  }
  return { parts };
}

/** The picture type a file's first bytes say it is: PNG, JPEG or WebP (nothing else, SVG least of all). */
export function imageTypeOf(bytes) {
  const at = (i, ...values) => values.every((v, j) => bytes[i + j] === v);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function parseJson(bytes) {
  try {
    return { value: JSON.parse(decoder.decode(bytes)) };
  } catch {
    return { error: true };
  }
}

/** The first problem zod found, as a path: "diagnostics.client.os.platform". */
const where = (error) => error.issues[0]?.path.join('.') || 'the top level';

/** The report and chat, checked against the protocol and against the parts that came; or `{ error }`. */
function validate(parts) {
  const report = parseJson(parts[0].bytes);
  if (report.error) return { error: "The report part isn't valid JSON." };
  const envelope = ReportEnvelope.safeParse(report.value);
  if (!envelope.success)
    return {
      error: `The report isn't in a form this collector understands (at ${where(envelope.error)}). Update Atelier and try again.`,
    };
  const e = envelope.data;
  const problem = reportTextProblem('title', e.title) ?? reportTextProblem('description', e.description);
  if (problem) return { error: problem };

  const chatPart = parts.find((p) => p.name === 'chat');
  if (e.attachments.chat !== Boolean(chatPart))
    return {
      error: e.attachments.chat
        ? 'The report says a chat is attached, but there is none.'
        : "A chat came that the report doesn't list.",
    };
  let chat = null;
  if (chatPart) {
    const parsed = parseJson(chatPart.bytes);
    if (parsed.error) return { error: "The chat part isn't valid JSON." };
    const checked = ReportChat.safeParse(parsed.value);
    if (!checked.success)
      return {
        error: `The chat isn't in a form this collector understands (at ${where(checked.error)}). Update Atelier and try again.`,
      };
    chat = checked.data;
  }

  const shots = parts.filter((p) => SHOT.test(p.name));
  for (const info of e.attachments.screenshots) {
    if (e.attachments.screenshots.filter((s) => s.name === info.name).length > 1)
      return { error: `The report lists ${info.name} twice.` };
    const part = shots.find((p) => p.name === info.name);
    if (!part) return { error: `Screenshot ${info.name} is missing.` };
    const actual = imageTypeOf(part.bytes);
    if (!actual) return { error: `Screenshot ${info.name} isn't a WebP, JPEG or PNG picture.` };
    if (actual !== info.mime || (part.type && part.type !== info.mime) || part.bytes.byteLength !== info.bytes)
      return { error: `Screenshot ${info.name} isn't the picture the report describes.` };
  }
  for (const part of shots)
    if (!e.attachments.screenshots.some((s) => s.name === part.name))
      return { error: `A screenshot came that the report doesn't list (${part.name}).` };
  return { envelope: e, chat, shots };
}

// ------------------------------------------------------------------ storing

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** "I-7F3K2Q": REPORT_ID in the protocol. 256 is a multiple of 32, so `byte % 32` is even. */
export const newReportId = (kind) =>
  `${kind === 'feature' ? 'F' : 'I'}-${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => CROCKFORD[b % 32]).join('')}`;

async function freshId(env, kind) {
  for (let i = 0; i < 8; i++) {
    const id = newReportId(kind);
    if (!(await env.DB.prepare('SELECT 1 FROM reports WHERE id = ?').bind(id).first())) return id;
  }
  throw new Error('no free report id');
}

async function existing(env, contentHash) {
  const row = await env.DB.prepare('SELECT id, received_at FROM reports WHERE content_hash = ?')
    .bind(contentHash)
    .first();
  return row ? { id: row.id, receivedAt: row.received_at } : null;
}

/** Takes one of today's reports for this address, or says there are none left; atomic, so parallel posts can't share one. */
async function takeQuota(env, key, day) {
  const row = await env.DB.prepare(
    'INSERT INTO report_quota (key, day, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count',
  )
    .bind(key, day, POLICY.perAddressPerDay)
    .first();
  return Boolean(row);
}
const giveQuotaBack = (env, key) =>
  env.DB.prepare('UPDATE report_quota SET count = count - 1 WHERE key = ? AND count > 0').bind(key).run();

/** The system the report is about, for the inbox's columns: the person's computer first, else the backend's. */
function systemOf(envelope) {
  const os = envelope.diagnostics?.client?.os ?? envelope.diagnostics?.backend?.os;
  return { os: os?.platform ?? null, osName: os?.name ?? null, arch: os?.arch ?? null };
}

async function store(env, { envelope, report, scrubbedChat, shots, contentHash, quotaKey, now }) {
  const id = await freshId(env, envelope.kind);
  const files = [
    { key: 'report.json', bytes: encoder.encode(JSON.stringify(report.value)), type: 'application/json' },
    ...(scrubbedChat
      ? [{ key: 'chat.json', bytes: encoder.encode(JSON.stringify(scrubbedChat.value)), type: 'application/json' }]
      : []),
    ...envelope.attachments.screenshots.map((info) => ({
      key: `${info.name}.${SHOT_EXTENSIONS[info.mime]}`,
      bytes: shots.find((p) => p.name === info.name).bytes,
      type: info.mime,
    })),
  ];
  const bytes = files.reduce((n, f) => n + f.bytes.byteLength, 0);
  const prefix = reportPrefix(id);
  const removeFiles = () => env.REPORTS.delete(files.map((f) => prefix + f.key)).catch(() => {});
  try {
    // The files first: a row never points at files that aren't there.
    await Promise.all(
      files.map((f) => env.REPORTS.put(prefix + f.key, f.bytes, { httpMetadata: { contentType: f.type } })),
    );
  } catch {
    await removeFiles();
    throw new Error('storing the files failed');
  }
  const r = report.value;
  const { os, osName, arch } = systemOf(r);
  const day = dayOf(now);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reports (id, kind, title, description, contact, status, labels, note, app_version, surface, mode, os, os_name, arch,
           has_diagnostics, has_chat, screenshots, bytes, content_hash, scrubbed, received_at, updated_at, seen_at)
         VALUES (?, ?, ?, ?, ?, 'new', '[]', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).bind(
        id,
        r.kind,
        r.title,
        r.description,
        r.contact?.trim() ? r.contact.trim() : null,
        r.app.version,
        r.app.surface,
        r.app.mode,
        os,
        osName,
        arch,
        r.diagnostics ? 1 : 0,
        scrubbedChat ? 1 : 0,
        r.attachments.screenshots.length,
        bytes,
        contentHash,
        report.count + (scrubbedChat?.count ?? 0),
        now,
        now,
      ),
      env.DB.prepare(
        'INSERT INTO report_days (day, count) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET count = count + 1',
      ).bind(day),
      env.DB.prepare(
        'INSERT INTO collector_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = value + excluded.value',
      ).bind(STORED_BYTES, bytes),
    ]);
  } catch (error) {
    await removeFiles();
    // The same report, sent twice at once: the other one is kept.
    const kept = await existing(env, contentHash);
    if (kept) {
      await giveQuotaBack(env, quotaKey);
      return { receipt: kept, status: 200 };
    }
    throw error;
  }
  return { receipt: { id, receivedAt: now }, status: 201 };
}

// ------------------------------------------------------------------ the routes

async function allowed(limiter, key) {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

async function reportsToday(env, now) {
  const row = await env.DB.prepare('SELECT count FROM report_days WHERE day = ?').bind(dayOf(now)).first();
  return row?.count ?? 0;
}

async function challenge(request, env, ip) {
  if (!(await allowed(env.CHALLENGE_LIMITER, ip)))
    return later(429, 'Too many challenges from this address; wait a minute.', POLICY.rate.challenges.period);
  const now = Date.now();
  // Without the count, the hardest: a database that doesn't answer is no reason to make reports cheaper.
  const today = await reportsToday(env, now).catch(() => Infinity);
  return json(await makeChallenge(env.CHALLENGE_SECRET, bitsFor(today), now));
}

async function receive(request, env, ip) {
  const secret = env.CHALLENGE_SECRET;
  if (!(await allowed(env.REPORT_LIMITER, ip)))
    return later(429, 'Too many reports from this address; wait a minute.', POLICY.rate.reports.period);
  const length = Number(request.headers.get('content-length'));
  if (length > REPORT_LIMITS.bodyBytes)
    return fail(413, `The report is too big: at most ${MB(REPORT_LIMITS.bodyBytes)} in all.`);
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType))
    return fail(400, 'Send the report as multipart/form-data.');
  const now = Date.now();
  // The challenge is checked before the body is read: a request without a valid one costs nothing more.
  const checked = await checkChallenge(secret, request.headers.get(POW_HEADERS.challenge), now);
  if (checked.error) return fail(403, checked.error);
  const nonce = request.headers.get(POW_HEADERS.nonce) ?? '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(nonce))
    return fail(403, 'The report has no proof of work. Get a challenge and try again.');

  const body = await readCapped(request, REPORT_LIMITS.bodyBytes);
  if (!body) return fail(413, `The report is too big: at most ${MB(REPORT_LIMITS.bodyBytes)} in all.`);
  const read = await partsOf(body, contentType);
  if (read.error) return fail(read.status, read.error);
  const { parts } = read;

  const hashed = await Promise.all(parts.map(async (p) => ({ name: p.name, sha256: await sha256hex(p.bytes) })));
  const contentHash = await sha256hex(contentHashInput(hashed));
  const proof = await sha256(powInput(request.headers.get(POW_HEADERS.challenge), contentHash, nonce));
  if (leadingZeroBits(proof) < checked.bits)
    return fail(403, "The proof of work doesn't match the report. Get a new challenge and try again.");

  // A retry of a report that was kept (the answer got lost): the same receipt, nothing stored twice.
  const kept = await existing(env, contentHash);
  if (kept) return json(kept, 200);

  const valid = validate(parts);
  if (valid.error) return fail(400, valid.error);
  // The second line behind the app's redaction: every string of the report and the chat.
  let report, scrubbedChat;
  try {
    report = scrubJson(valid.envelope);
    scrubbedChat = valid.chat ? scrubJson(valid.chat) : null;
  } catch (error) {
    if (error instanceof TooDeep) return fail(400, error.message);
    throw error;
  }

  if ((await reportsToday(env, now)) >= POLICY.perDay)
    return later(
      503,
      'The collector has taken all the reports it can today. Try again tomorrow.',
      secondsToMidnight(now),
    );
  const stored = await env.DB.prepare('SELECT value FROM collector_state WHERE key = ?').bind(STORED_BYTES).first();
  if ((stored?.value ?? 0) + body.byteLength > POLICY.storageBytes) return fail(503, 'The collector is full.');
  const day = dayOf(now);
  const quotaKey = await hmac(secret, `${day}|${ip}`);
  if (!(await takeQuota(env, quotaKey, day)))
    return later(
      429,
      `This address has sent ${POLICY.perAddressPerDay} reports today. Try again tomorrow.`,
      secondsToMidnight(now),
    );

  try {
    const { receipt, status } = await store(env, {
      envelope: valid.envelope,
      report,
      scrubbedChat,
      shots: valid.shots,
      contentHash,
      quotaKey,
      now,
    });
    return json(receipt, status);
  } catch {
    await giveQuotaBack(env, quotaKey).catch(() => {});
    return fail(500, "The collector couldn't keep the report. Try again later.");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD'))
      return new Response('Atelier report collector\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const route = url.pathname === '/v1/challenge' ? challenge : url.pathname === '/v1/reports' ? receive : null;
    if (!route) return fail(404, 'Not found.');
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    // Without its secret the collector can't sign challenges nor key quotas: it takes nothing.
    if (!env.CHALLENGE_SECRET || !env.DB || !env.REPORTS) return fail(503, "The collector isn't set up yet.");
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    try {
      return await route(request, env, ip);
    } catch {
      return fail(500, "The collector couldn't take the report. Try again later.");
    }
  },
};
