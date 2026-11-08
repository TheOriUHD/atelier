import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeTerminalCode } from '@atelier/protocol';
import { openDatabase, type Db } from '../store/db.ts';
import { authSessions } from '../store/schema.ts';
import { AccountService, type ClientInfo } from './account-service.ts';
import { hashToken } from './passwords.ts';
import { newTerminalCode, TERMINAL_REQUEST_TTL_MS, TerminalSignIns } from './terminal-sign-in.ts';

const web: ClientInfo = { clientKind: 'web', ip: '10.0.0.1' };
const terminal: ClientInfo = { clientKind: 'desktop', ip: '10.0.0.7', userAgent: 'Atelier CLI (darwin)' };
const origin = 'https://atelier.example.com';
let db: Db;
let accounts: AccountService;
let now: number;
let signIns: TerminalSignIns;
let recorded: { kind: string; summary: string }[];

const code = (p: Promise<unknown> | (() => unknown)) =>
  (typeof p === 'function' ? Promise.resolve().then(p) : p).then(
    () => 'ok',
    (e: { code?: string }) => e.code ?? String(e),
  );

beforeEach(() => {
  db = openDatabase(':memory:');
  accounts = new AccountService(db, () => 'invite');
  now = 1_000_000;
  recorded = [];
  const audit = { record: (_who: unknown, d: { kind: string; summary: string }) => void recorded.push(d) };
  signIns = new TerminalSignIns(accounts, audit as never, () => now);
});
afterEach(() => db.$client.close());

describe('TerminalSignIns', () => {
  it('signs the terminal in as the person who approved, once, as a terminal', async () => {
    const { user } = await accounts.setup({ username: 'ada', name: 'Ada', password: 'ada-password-1' }, web);
    const start = signIns.start({ deviceName: 'Ada’s MacBook · terminal', platform: 'macOS' }, terminal, `${origin}/`);
    expect(start.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(start.verifyUrl).toBe(`${origin}/#/link`);
    expect(start.verifyUrlComplete).toBe(`${origin}/#/link?code=${start.code}`);
    expect(await signIns.poll(start.pollToken, terminal)).toEqual({ state: 'pending' });

    const seen = signIns.describe(start.code.toLowerCase().replace('-', ' '), user, web);
    expect(seen).toMatchObject({ code: start.code, deviceName: 'Ada’s MacBook · terminal', platform: 'macOS', ip: '10.0.0.7' });
    signIns.decide(start.code, true, user, web);
    expect(recorded.map((r) => r.kind)).toEqual(['signin.terminal_approved']);

    const done = await signIns.poll(start.pollToken, terminal);
    expect(done).toMatchObject({ state: 'approved', user: { id: user.id } });
    if (done.state !== 'approved') throw new Error('not approved');
    expect((await accounts.authenticate(done.token))?.user.id).toBe(user.id);
    const row = await db.select().from(authSessions).where(eq(authSessions.tokenHash, hashToken(done.token))).get();
    expect(row?.clientKind).toBe('cli');
    // Handed out once: the next poll finds nothing.
    expect(await signIns.poll(start.pollToken, terminal)).toEqual({ state: 'expired' });
  });

  it('says when a request was denied, and an answered one can’t be answered again', async () => {
    const { user } = await accounts.setup({ username: 'ada', name: 'Ada', password: 'ada-password-1' }, web);
    const start = signIns.start({ deviceName: 'box', platform: 'Linux' }, terminal, origin);
    signIns.decide(start.code, false, user, web);
    expect(await code(() => signIns.decide(start.code, true, user, web))).toBe('expired');
    expect(recorded.map((r) => r.kind)).toEqual(['signin.terminal_denied']);
    expect(await signIns.poll(start.pollToken, terminal)).toEqual({ state: 'denied' });
    expect(await signIns.poll(start.pollToken, terminal)).toEqual({ state: 'expired' });
  });

  it('ends requests after 10 minutes', async () => {
    const { user } = await accounts.setup({ username: 'ada', name: 'Ada', password: 'ada-password-1' }, web);
    const start = signIns.start({ deviceName: 'box', platform: 'Linux' }, terminal, origin);
    now += TERMINAL_REQUEST_TTL_MS;
    expect(await code(() => signIns.describe(start.code, user, web))).toBe('not_found');
    expect(await signIns.poll(start.pollToken, terminal)).toEqual({ state: 'expired' });
  });

  it('refuses lookups after too many wrong codes, per person and per address', async () => {
    const { user } = await accounts.setup({ username: 'ada', name: 'Ada', password: 'ada-password-1' }, web);
    const start = signIns.start({ deviceName: 'box', platform: 'Linux' }, terminal, origin);
    for (let i = 0; i < 8; i++) expect(await code(() => signIns.describe('AAAA-AAAA', user, web))).toBe('not_found');
    expect(await code(() => signIns.describe(start.code, user, web))).toBe('rate_limited');
    now += 15 * 60_000 + 1;
    const again = signIns.start({ deviceName: 'box', platform: 'Linux' }, terminal, origin);
    expect(await code(() => signIns.describe(again.code, user, web))).toBe('ok');
  });

  it('limits how many requests one address may have open', async () => {
    for (let i = 0; i < 5; i++) signIns.start({ deviceName: `box ${i}`, platform: 'Linux' }, terminal, origin);
    expect(await code(() => signIns.start({ deviceName: 'one more', platform: 'Linux' }, terminal, origin))).toBe('rate_limited');
    expect(await code(() => signIns.start({ deviceName: 'elsewhere', platform: 'Linux' }, { ...terminal, ip: '10.0.0.8' }, origin))).toBe('ok');
  });

  it('won’t sign a terminal in as an account that was disabled after approving', async () => {
    const { user } = await accounts.setup({ username: 'ada', name: 'Ada', password: 'ada-password-1' }, web);
    void user;
    const { user: bob } = await accounts.create({ username: 'bob', name: 'Bob', role: 'user' });
    const start = signIns.start({ deviceName: 'box', platform: 'Linux' }, terminal, origin);
    signIns.decide(start.code, true, bob, web);
    await accounts.adminUpdate(bob.id, { disabled: true });
    expect(await code(signIns.poll(start.pollToken, terminal))).toBe('disabled');
  });

  it('makes codes that read back as themselves', () => {
    for (let i = 0; i < 50; i++) {
      const c = newTerminalCode();
      expect(normalizeTerminalCode(c)).toBe(c);
    }
    expect(normalizeTerminalCode('k7qf-3mzd')).toBe('K7QF3MZD');
    expect(normalizeTerminalCode('K7QF-3MZ')).toBeNull();
  });
});
