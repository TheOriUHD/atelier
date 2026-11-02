/** What the account service tells the admin activity log: every way in, every way in that failed, every new account. */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { AuditLog } from '../audit/audit-log.ts';
import { AccountService, type ClientInfo } from './account-service.ts';

const web: ClientInfo = { clientKind: 'web', ip: '203.0.113.7' };
const owner = { username: 'ada', name: 'Ada', password: 'ada-password-1' };
let db: Db;
let log: AuditLog;
let accounts: AccountService;

beforeEach(() => {
  db = openDatabase(':memory:');
  log = new AuditLog(db, { enabled: () => true, onError: () => {} });
  accounts = new AccountService(db, () => 'open', log);
});
afterEach(() => db.$client.close());

const events = async (kind?: string) => {
  await log.idle();
  return (await log.list(kind ? { kind } : {}, {}, 90)).events.reverse();
};
const refuses = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

describe('sign-ins in the activity log', () => {
  it('records the first account and its sign-in, with the address the server saw', async () => {
    await accounts.setup(owner, web);
    expect((await events()).map((e) => `${e.kind}:${e.target}`)).toEqual(['account.created:ada', 'signin.success:ada']);
    expect((await events('signin'))[0]).toMatchObject({ actor: 'ada', ip: '203.0.113.7', detail: { method: 'setup', client: 'web' } });
  });

  it('records a password sign-in', async () => {
    await accounts.setup(owner, web);
    await accounts.login(owner, { ...web, ip: '198.51.100.2' });
    const [, second] = await events('signin');
    expect(second).toMatchObject({ kind: 'signin.success', actor: 'ada', ip: '198.51.100.2', detail: { method: 'password' } });
  });

  it('records failed sign-ins with the name tried, the reason and the address, and never the password', async () => {
    await accounts.setup(owner, web);
    await refuses(accounts.login({ username: 'ada', password: 'Hunter2-wrong' }, web));
    await refuses(accounts.login({ username: 'mallory', password: 'Hunter2-other' }, { ...web, ip: '192.0.2.99' }));
    const failed = await events('signin.failed');
    expect(failed).toMatchObject([
      { actor: 'ada', ip: '203.0.113.7', detail: { reason: 'wrong password' } },
      { actor: 'mallory', ip: '192.0.2.99', detail: { reason: 'unknown username' } },
    ]);
    expect(JSON.stringify(await events())).not.toMatch(/Hunter2/);
  });

  it('records a disabled or waiting account that knew the right password', async () => {
    const { user: admin } = await accounts.setup(owner, web);
    const { user: bob, temporaryPassword } = await accounts.create({ username: 'bob', name: 'Bob', role: 'user' });
    await accounts.adminUpdate(bob.id, { disabled: true });
    expect(await refuses(accounts.login({ username: 'bob', password: temporaryPassword }, web))).toBe('disabled');
    expect((await events('signin.failed'))[0]).toMatchObject({ actor: 'bob', detail: { reason: 'account disabled' } });
    expect(admin.role).toBe('admin');
  });

  it('writes one blocked entry per window for a run of failures, not one per attempt', async () => {
    await accounts.setup(owner, web);
    for (let i = 0; i < 8; i++) await refuses(accounts.login({ username: 'ada', password: 'wrong-pass' }, web));
    for (let i = 0; i < 20; i++) expect(await refuses(accounts.login({ username: 'ada', password: 'wrong-pass' }, web))).toBe('rate_limited');
    expect((await events('signin.blocked'))).toHaveLength(1);
    expect(await events('signin.failed')).toHaveLength(8);
    expect((await events('signin.blocked'))[0]).toMatchObject({ actor: 'ada', ip: '203.0.113.7' });
  });

  it('records passkey and single sign-on sign-ins by method', async () => {
    const { user } = await accounts.setup(owner, web);
    await accounts.signInAs(user.id, web, 'passkey');
    await accounts.signInAs(user.id, web, 'oidc');
    expect((await events('signin')).slice(1).map((e) => e.detail?.method)).toEqual(['passkey', 'oidc']);
  });

  it('records sign-up, invite codes (wrong and used) and single sign-on accounts', async () => {
    const { user } = await accounts.setup(owner, web);
    await accounts.signup({ username: 'fay', name: 'Fay', password: 'fay-password-1' });
    const { code } = await accounts.createInvite('user', user.id);
    await refuses(accounts.acceptInvite({ invite: 'WRONGWRONGWRONG1', username: 'dee', name: 'Dee', password: 'dee-password-1' }, web));
    await accounts.acceptInvite({ invite: code, username: 'dee', name: 'Dee', password: 'dee-password-1' }, { ...web, ip: '192.0.2.5' });
    await accounts.createForIdentity({ username: 'sso', name: 'Sso', role: 'pending' });
    const all = await events();
    expect(all.filter((e) => e.kind === 'account.created').map((e) => `${e.target}:${e.detail?.via}`)).toEqual(['ada:setup', 'fay:open sign-up', 'dee:invite', 'sso:single sign-on']);
    expect(all.find((e) => e.kind === 'invite.used')).toMatchObject({ actor: 'dee', ip: '192.0.2.5' });
    expect(all.find((e) => e.kind === 'signin.failed')).toMatchObject({ actor: null, summary: expect.stringContaining('invite code') });
    // Neither the code that was tried nor the one that was used is written down.
    expect(JSON.stringify(all)).not.toContain('WRONGWRONG');
    expect(JSON.stringify(all)).not.toContain(code.replace(/-/g, '').slice(0, 8));
  });

  it('does nothing and breaks nothing when no log is attached', async () => {
    const bare = new AccountService(openDatabase(':memory:'), () => 'invite');
    await bare.setup(owner, web);
    expect(await refuses(bare.login({ username: 'ada', password: 'nope-nope' }, web))).toBe('invalid_credentials');
  });

  it('still signs people in when the log cannot be written', async () => {
    await db.run(sql`drop table audit_events`);
    await accounts.setup(owner, web);
    await expect(accounts.login(owner, web)).resolves.toMatchObject({ user: { username: 'ada' } });
    await expect(refuses(accounts.login({ username: 'ada', password: 'wrong-pass' }, web))).resolves.toBe('invalid_credentials');
  });
});
