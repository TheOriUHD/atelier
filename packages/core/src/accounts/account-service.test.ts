import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeInviteCode, type SignupPolicy } from '@atelier/protocol';
import { ProjectRepo } from '../projects/project-repo.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { authSessions, invites } from '../store/schema.ts';
import { AccountService, newInviteCode, usernameFrom, type ClientInfo } from './account-service.ts';
import { hashToken, newToken } from './passwords.ts';

const web: ClientInfo = { clientKind: 'web', ip: '10.0.0.1' };
const owner = { username: 'ada', name: 'Ada', password: 'ada-password-1' };
let db: Db;
let policy: SignupPolicy;
let accounts: AccountService;

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

beforeEach(() => {
  db = openDatabase(':memory:');
  policy = 'invite';
  accounts = new AccountService(db, () => policy);
});
afterEach(() => db.$client.close());

describe('AccountService', () => {
  it('hands data from before accounts to the first admin, and sets up only once', async () => {
    const chat = await new SessionRepo(db).create({ mode: 'chat' });
    const project = await new ProjectRepo(db).create({ name: 'Old', description: '' });
    expect(await accounts.setupRequired()).toBe(true);
    const { user, token } = await accounts.setup(owner, web);
    expect(user.role).toBe('admin');
    expect((await new SessionRepo(db).getRow(chat.id))!.userId).toBe(user.id);
    expect(await new ProjectRepo(db).list(user.id)).toEqual([expect.objectContaining({ id: project.id })]);
    expect((await accounts.authenticate(token))?.user.id).toBe(user.id);
    expect(await code(accounts.setup({ ...owner, username: 'eve' }, web))).toBe('setup_done');
  });

  it('throttles repeated failed logins per username and address', async () => {
    await accounts.setup(owner, web);
    for (let i = 0; i < 8; i++) expect(await code(accounts.login({ username: 'ada', password: 'wrong' }, web))).toBe('invalid_credentials');
    expect(await code(accounts.login({ username: 'ada', password: owner.password }, web))).toBe('rate_limited');
    expect(await code(accounts.login({ username: 'ada', password: owner.password }, { ...web, ip: '10.0.0.2' }))).toBe('ok');
  });

  it('refuses expired, logged-out and disabled sign-ins', async () => {
    const admin = await accounts.setup(owner, web);
    const { user: bob, temporaryPassword } = await accounts.create({ username: 'bob', name: 'Bob', role: 'user' });
    const { token } = await accounts.login({ username: 'bob', password: temporaryPassword }, web);
    const session = await accounts.authenticate(token);
    expect(session?.user.mustChangePassword).toBe(true);

    await db.update(authSessions).set({ expiresAt: Date.now() - 1 }).where(eq(authSessions.id, session!.sessionId));
    expect(await accounts.authenticate(token)).toBeNull();

    const again = await accounts.login({ username: 'bob', password: temporaryPassword }, web);
    await accounts.adminUpdate(bob.id, { disabled: true });
    expect(await accounts.authenticate(again.token)).toBeNull();
    expect(await code(accounts.login({ username: 'bob', password: temporaryPassword }, web))).toBe('disabled');

    await accounts.logout((await accounts.authenticate(admin.token))!.sessionId);
    expect(await accounts.authenticate(admin.token)).toBeNull();
  });

  it('never leaves the server without an admin', async () => {
    const { user } = await accounts.setup(owner, web);
    expect(await code(accounts.adminUpdate(user.id, { role: 'user' }))).toBe('last_admin');
    expect(await code(accounts.adminUpdate(user.id, { disabled: true }))).toBe('last_admin');
    expect(await code(accounts.remove(user.id))).toBe('last_admin');
    const { user: second } = await accounts.create({ username: 'cy', name: 'Cy', role: 'admin' });
    expect(await code(accounts.adminUpdate(user.id, { role: 'user' }))).toBe('ok');
    expect(await code(accounts.remove(second.id))).toBe('last_admin');
  });

  it('accepts an invite once and only while sign-up rules allow new accounts', async () => {
    const { user } = await accounts.setup(owner, web);
    const { code: invite } = await accounts.createInvite('user', user.id);
    await accounts.acceptInvite({ invite, username: 'dee', name: 'Dee', password: 'dee-password-1' }, web);
    expect(await code(accounts.acceptInvite({ invite, username: 'eve', name: 'Eve', password: 'eve-password-1' }, web))).toBe('invalid_invite');
    expect(await code(accounts.signup({ username: 'fay', name: 'Fay', password: 'fay-password-1' }))).toBe('signup_closed');
    policy = 'open';
    await accounts.signup({ username: 'fay', name: 'Fay', password: 'fay-password-1' });
    expect(await code(accounts.login({ username: 'fay', password: 'fay-password-1' }, web))).toBe('pending');
  });

  it('creates invite codes of four groups and stores only their hash and last group', async () => {
    const { user } = await accounts.setup(owner, web);
    const { invite, code: created } = await accounts.createInvite('admin', user.id);
    expect(created).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(invite).toMatchObject({ role: 'admin', hint: created.slice(-4), usedAt: null });
    expect(invite.expiresAt - invite.createdAt).toBe(7 * 24 * 3600_000);
    const row = (await db.select().from(invites).all())[0]!;
    expect(row.tokenHash).toBe(hashToken(created.replace(/-/g, '')));
    expect(JSON.stringify(row)).not.toContain(created.replace(/-/g, '').slice(0, 12));
    expect(await accounts.listInvites()).toEqual([invite]);
  });

  it('reads invite codes typed in lowercase, without dashes, with spaces, and with O, I or L for 0 and 1', () => {
    expect(normalizeInviteCode('a1b2-c3d4-e5f6-g7h8')).toBe('A1B2C3D4E5F6G7H8');
    expect(normalizeInviteCode(' A1B2 C3D4  E5F6 G7H8 ')).toBe('A1B2C3D4E5F6G7H8');
    expect(normalizeInviteCode('ab0o-cd1i-eflL-gh00')).toBe('AB00CD11EF11GH00');
    expect(normalizeInviteCode('A1B2-C3D4-E5F6-G7H')).toBeNull();
    expect(normalizeInviteCode('A1B2-C3D4-E5F6-G7HU')).toBeNull();
    for (let i = 0; i < 200; i++) expect(newInviteCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
  });

  it('accepts a code however it is typed, once, until it expires or is revoked', async () => {
    const { user } = await accounts.setup(owner, web);
    const { code: first } = await accounts.createInvite('user', user.id);
    const typed = ` ${first.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `;
    await accounts.checkInvite(typed, web);
    const { user: dee } = await accounts.acceptInvite({ invite: typed, username: 'dee', name: 'Dee', password: 'dee-password-1' }, web);
    expect(dee.role).toBe('user');
    expect(await code(accounts.checkInvite(first, web))).toBe('invalid_invite');

    const { invite: late, code: expired } = await accounts.createInvite('user', user.id);
    await db.update(invites).set({ expiresAt: Date.now() - 1 }).where(eq(invites.id, late.id));
    expect(await code(accounts.acceptInvite({ invite: expired, username: 'eve', name: 'Eve', password: 'eve-password-1' }, web))).toBe('invalid_invite');

    const { invite: revoked, code: third } = await accounts.createInvite('user', user.id);
    await accounts.revokeInvite(revoked.id);
    expect(await code(accounts.checkInvite(third, web))).toBe('invalid_invite');
    expect((await accounts.listInvites()).map((i) => i.id)).not.toContain(revoked.id);
  });

  it('keeps accepting invite links made before codes', async () => {
    const { user } = await accounts.setup(owner, web);
    const token = newToken();
    const now = Date.now();
    await db.insert(invites).values({ id: 'old', tokenHash: hashToken(token), codeHint: null, role: 'user', createdBy: user.id, createdAt: now, expiresAt: now + 3600_000, usedAt: null, usedBy: null });
    expect(await accounts.listInvites()).toEqual([expect.objectContaining({ id: 'old', hint: null })]);
    await accounts.acceptInvite({ invite: token, username: 'gus', name: 'Gus', password: 'gus-password-1' }, web);
    expect(await code(accounts.checkInvite(token, web))).toBe('invalid_invite');
  });

  it('throttles wrong invite codes per address', async () => {
    const { user } = await accounts.setup(owner, web);
    const { code: invite } = await accounts.createInvite('user', user.id);
    for (let i = 0; i < 8; i++) expect(await code(accounts.checkInvite(newInviteCode(), web))).toBe('invalid_invite');
    expect(await code(accounts.checkInvite(invite, web))).toBe('rate_limited');
    expect(await code(accounts.acceptInvite({ invite, username: 'hal', name: 'Hal', password: 'hal-password-1' }, web))).toBe('rate_limited');
    expect(await code(accounts.checkInvite(invite, { ...web, ip: '10.0.0.2' }))).toBe('ok');
  });
});

describe('usernameFrom', () => {
  it('derives a valid username from a display name', () => {
    expect(usernameFrom('Ada Lovelace')).toBe('ada.lovelace');
    expect(usernameFrom('  Zoë  O’Brien ')).toBe('zoe.o.brien');
    expect(usernameFrom('李')).toBe('me');
    expect(usernameFrom('x'.repeat(40))).toHaveLength(32);
  });
});
