/**
 * Signing in a terminal through the browser (ARCHITECTURE §25), in the manner of OAuth's device flow (RFC 8628): the
 * terminal asks for a request and shows its code with the server's `#/link` page; a person signed in there (by password,
 * passkey or an identity provider) sees what asks, compares the code and approves or denies it; the terminal's next poll
 * gets a sign-in of its own for that account, once.
 *
 * Requests live in memory for 10 minutes: a server restart ends them, and the terminal asks again. Only the poll token's
 * sha256 is kept. Codes are 40 bits and lookups of wrong codes count against the person and the address, so guessing one
 * within its 10 minutes is out of reach. What the page can't prevent is someone sending you a code of theirs to approve,
 * so it names the computer and address that asked and says to approve only a terminal you just started.
 */
import { randomBytes } from 'node:crypto';
import { formatInviteCode, INVITE_CODE_ALPHABET, normalizeTerminalCode, TERMINAL_CODE_LENGTH, type TerminalSignInPoll, type TerminalSignInRequest, type UserSummary } from '@atelier/protocol';
import type { AuditLog } from '../audit/audit-log.ts';
import { hashToken, newToken } from './passwords.ts';
import { AccountError, type AccountService, type ClientInfo } from './account-service.ts';

export const TERMINAL_REQUEST_TTL_MS = 10 * 60_000;
export const TERMINAL_POLL_SECONDS = 2;
/** Open requests one address may have at once, and new ones it may make in 15 minutes. */
const OPEN_PER_ADDRESS = 5;
const STARTS_PER_WINDOW = 20;
/** Wrong codes one person (or one address) may look up in 15 minutes before lookups are refused. */
const WRONG_CODES = 8;
const WINDOW_MS = 15 * 60_000;

interface Request {
  code: string;
  pollHash: string;
  deviceName: string;
  platform: string;
  ip: string;
  userAgent: string;
  createdAt: number;
  expiresAt: number;
  decision: { approved: true; userId: string } | { approved: false } | null;
}

/** 8 symbols from 40 random bits, five bits each, so every symbol is equally likely. */
export function newTerminalCode(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let code = '';
  for (let i = TERMINAL_CODE_LENGTH - 1; i >= 0; i--) code += INVITE_CODE_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return code;
}

export class TerminalSignIns {
  private requests = new Map<string, Request>();
  private starts = new Map<string, number[]>();
  private wrong = new Map<string, number[]>();

  constructor(
    private accounts: AccountService,
    private audit: AuditLog | null = null,
    private now: () => number = Date.now,
  ) {}

  /** A new request from a terminal. `origin` is the server's public address, for the link to show. */
  start(input: { deviceName: string; platform: string }, client: ClientInfo, origin: string): { code: string; pollToken: string; verifyUrl: string; verifyUrlComplete: string; expiresAt: number; interval: number } {
    this.prune();
    const ip = client.ip ?? '';
    const now = this.now();
    const recent = (this.starts.get(ip) ?? []).filter((t) => t > now - WINDOW_MS);
    const open = [...this.requests.values()].filter((r) => r.ip === ip && r.decision === null).length;
    if (recent.length >= STARTS_PER_WINDOW || open >= OPEN_PER_ADDRESS) throw new AccountError('rate_limited', 'Too many sign-in requests from this address. Try again in a few minutes.');
    this.starts.set(ip, [...recent, now]);
    let code = newTerminalCode();
    while (this.requests.has(code)) code = newTerminalCode();
    const pollToken = newToken();
    this.requests.set(code, {
      code,
      pollHash: hashToken(pollToken),
      deviceName: input.deviceName.slice(0, 120),
      platform: input.platform.slice(0, 40),
      ip,
      userAgent: (client.userAgent ?? '').slice(0, 300),
      createdAt: now,
      expiresAt: now + TERMINAL_REQUEST_TTL_MS,
      decision: null,
    });
    const base = origin.replace(/\/$/, '');
    const shown = formatInviteCode(code);
    return { code: shown, pollToken, verifyUrl: `${base}/#/link`, verifyUrlComplete: `${base}/#/link?code=${shown}`, expiresAt: now + TERMINAL_REQUEST_TTL_MS, interval: TERMINAL_POLL_SECONDS };
  }

  /** The terminal asks how its request stands; an approved one becomes a sign-in, handed out this once. */
  async poll(pollToken: string, client: ClientInfo): Promise<TerminalSignInPoll> {
    this.prune();
    const hash = hashToken(pollToken);
    const request = [...this.requests.values()].find((r) => r.pollHash === hash);
    if (!request) return { state: 'expired' };
    if (request.decision === null) return { state: 'pending' };
    this.requests.delete(request.code);
    if (!request.decision.approved) return { state: 'denied' };
    const signedIn = await this.accounts.signInAs(request.decision.userId, { ...client, clientKind: 'cli' }, 'terminal');
    return { state: 'approved', ...signedIn };
  }

  /** What the /link page shows for a code the person typed or followed. */
  describe(input: string, who: Pick<UserSummary, 'id'>, client: Pick<ClientInfo, 'ip'>): TerminalSignInRequest {
    const request = this.find(input, who, client);
    return { code: formatInviteCode(request.code), deviceName: request.deviceName, platform: request.platform, ip: request.ip, createdAt: request.createdAt, expiresAt: request.expiresAt };
  }

  /** The person approves the request (it signs the terminal in as them) or denies it. */
  decide(input: string, approve: boolean, who: Pick<UserSummary, 'id' | 'username'>, client: Pick<ClientInfo, 'ip'>): void {
    const request = this.find(input, who, client);
    if (request.decision !== null) throw new AccountError('expired', 'This sign-in request was already answered.');
    request.decision = approve ? { approved: true, userId: who.id } : { approved: false };
    this.audit?.record(
      { actorId: who.id, actor: who.username, ip: client.ip ?? null },
      approve
        ? { kind: 'signin.terminal_approved', target: request.deviceName, summary: `${who.username} signed in a terminal on ${request.deviceName}`, detail: { from: request.ip, platform: request.platform } }
        : { kind: 'signin.terminal_denied', target: request.deviceName, summary: `${who.username} denied a terminal sign-in from ${request.deviceName}`, detail: { from: request.ip, platform: request.platform } },
    );
  }

  private find(input: string, who: Pick<UserSummary, 'id'>, client: Pick<ClientInfo, 'ip'>): Request {
    this.prune();
    const now = this.now();
    const keys = [`user:${who.id}`, `ip:${client.ip ?? ''}`];
    if (keys.some((k) => (this.wrong.get(k) ?? []).filter((t) => t > now - WINDOW_MS).length >= WRONG_CODES)) throw new AccountError('rate_limited', 'Too many wrong codes. Try again in a few minutes.');
    const code = normalizeTerminalCode(input);
    const request = code ? this.requests.get(code) : undefined;
    if (!request) {
      for (const k of keys) this.wrong.set(k, [...(this.wrong.get(k) ?? []).filter((t) => t > now - WINDOW_MS), now]);
      throw new AccountError('not_found', 'No terminal is waiting with this code. It may have expired: start the sign-in in the terminal again.');
    }
    return request;
  }

  private prune(): void {
    const now = this.now();
    for (const [code, r] of this.requests) if (r.expiresAt <= now) this.requests.delete(code);
    for (const map of [this.starts, this.wrong]) for (const [k, list] of map) if (!list.some((t) => t > now - WINDOW_MS)) map.delete(k);
  }
}
