/**
 * Sends a report to the collector (packages/protocol/src/reports.ts): asks for a challenge, does the proof of work for
 * the body it is about to send, then posts the parts. The work is done in slices so the backend keeps answering
 * everything else while it runs (a hard challenge takes a few seconds).
 */
import { createHash } from 'node:crypto';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { APP, contentHashInput, leadingZeroBits, POW_HEADERS, powInput, REPORT_LIMITS, ReportChallenge, ReportReceipt, type ReportChat, type ReportEnvelope } from '@atelier/protocol';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A refusal or failure, said so the person can act on it. */
export class ReportSendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

const MAX_ATTEMPTS = 2 ** 27;
const SLICE = 4096;

/** A nonce that makes `sha256(powInput(challenge, contentHash, nonce))` start with `bits` zero bits. */
export async function solveChallenge(challenge: string, bits: number, contentHash: string, signal?: AbortSignal): Promise<string> {
  for (let n = 0; n < MAX_ATTEMPTS; n++) {
    if (n % SLICE === 0 && n > 0) {
      signal?.throwIfAborted();
      await yieldNow();
    }
    const nonce = n.toString(36);
    if (leadingZeroBits(createHash('sha256').update(powInput(challenge, contentHash, nonce)).digest()) >= bits) return nonce;
  }
  throw new ReportSendError('The report server asked for more work than this computer could do. Try again later.');
}

export interface Outgoing {
  envelope: ReportEnvelope;
  chat: ReportChat | null;
  screenshots: readonly { name: string; mime: string; bytes: Uint8Array }[];
}

async function answer(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error.length < 400 ? body.error : `The report server answered HTTP ${res.status}.`;
}

export async function submitReport(fetch: Fetch, baseUrl: string, out: Outgoing, signal?: AbortSignal): Promise<ReportReceipt> {
  const encoder = new TextEncoder();
  const report = encoder.encode(JSON.stringify(out.envelope));
  const chat = out.chat ? encoder.encode(JSON.stringify(out.chat)) : null;
  if (report.byteLength > REPORT_LIMITS.reportBytes) throw new ReportSendError('The diagnostics are too large to send. Leave them out, or save the report as a file.');
  if (chat && chat.byteLength > REPORT_LIMITS.chatBytes) throw new ReportSendError('The chat is too large to send. Leave it out, or save the report as a file.');
  const parts: { name: string; type: string; file: string; bytes: Uint8Array }[] = [
    { name: 'report', type: 'application/json', file: 'report.json', bytes: report },
    ...(chat ? [{ name: 'chat', type: 'application/json', file: 'chat.json', bytes: chat }] : []),
    ...out.screenshots.map((s) => ({ name: s.name, type: s.mime, file: `${s.name}.${s.mime.split('/')[1]}`, bytes: s.bytes })),
  ];
  const size = parts.reduce((n, p) => n + p.bytes.byteLength, 0);
  if (size > REPORT_LIMITS.bodyBytes - 64_000) throw new ReportSendError('The report is too large to send. Take out a screenshot or the chat.');
  const contentHash = sha256(contentHashInput(parts.map((p) => ({ name: p.name, sha256: sha256(p.bytes) }))));
  const base = baseUrl.replace(/\/+$/, '');
  const headers = { 'user-agent': `${APP.name}/${APP.version}` };

  let res: Response;
  try {
    res = await fetch(`${base}/v1/challenge`, { method: 'POST', headers, ...(signal ? { signal } : {}) });
  } catch {
    throw new ReportSendError("Couldn't reach the report server. Check the connection, or save the report as a file.");
  }
  if (!res.ok) throw new ReportSendError(await answer(res), res.status);
  const parsed = ReportChallenge.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new ReportSendError('The report server gave an answer Atelier does not understand. Try again later.');
  const { challenge, bits } = parsed.data;
  const nonce = await solveChallenge(challenge, bits, contentHash, signal);

  const form = new FormData();
  for (const p of parts) form.append(p.name, new Blob([p.bytes as Uint8Array<ArrayBuffer>], { type: p.type }), p.file);
  try {
    res = await fetch(`${base}/v1/reports`, { method: 'POST', headers: { ...headers, [POW_HEADERS.challenge]: challenge, [POW_HEADERS.nonce]: nonce }, body: form, ...(signal ? { signal } : {}) });
  } catch {
    throw new ReportSendError("Couldn't reach the report server. Check the connection, or save the report as a file.");
  }
  if (!res.ok) throw new ReportSendError(await answer(res), res.status);
  const receipt = ReportReceipt.safeParse(await res.json().catch(() => null));
  if (!receipt.success) throw new ReportSendError('The report server gave an answer Atelier does not understand.');
  return receipt.data;
}
