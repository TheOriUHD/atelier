/**
 * Accounts, sign-in sessions and invites (ARCHITECTURE §21). Tokens are random 256-bit bearer strings;
 * only their sha256 is stored, as for invite codes. Sessions slide: each use extends them to 30 days from now.
 */
import { and, desc, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  formatInviteCode,
  INVITE_CODE_ALPHABET,
  normalizeInviteCode,
  type AuthSessionSummary,
  type ClientKind,
  type InviteSummary,
  type SafeguardsOverride,
  type SignupPolicy,
  type UserRole,
  type UserSummary,
} from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { authSessions, files, invites, projects, sessions, usageEvents, users } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import { hashPassword, hashToken, newToken, temporaryPassword, verifyPassword } from './passwords.ts';

const SESSION_TTL_MS = 30 * 24 * 3600_000;
const INVITE_TTL_MS = 7 * 24 * 3600_000;
/** Don't write `last_seen_at` on every request. */
const TOUCH_INTERVAL_MS = 60_000;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60_000;

type UserRow = typeof users.$inferSelect;
type InviteRow = typeof invites.$inferSelect;

export class AccountError extends Error {
  constructor(
    readonly code:
      | 'invalid_credentials'
      | 'pending'
      | 'disabled'
      | 'exists'
      | 'setup_done'
      | 'invalid_invite'
      | 'signup_closed'
      | 'rate_limited'
      | 'last_admin'
      | 'not_found'
      | 'no_account'
      | 'identity_taken'
      | 'last_sign_in'
      | 'expired'
      | 'denied'
      | 'oidc_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface ClientInfo {
  clientKind: ClientKind;
  userAgent?: string;
  ip?: string;
  deviceId?: string;
}

export interface Authenticated {
  user: UserSummary;
  sessionId: string;
}

export function toUserSummary(r: UserRow): UserSummary {
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    role: r.role,
    avatar: r.avatarBlob,
    mustChangePassword: r.mustChangePassword,
    hasPassword: r.passwordHash !== '',
    disabled: r.disabledAt !== null,
    safeguards: r.safeguards,
    createdAt: r.createdAt,
    lastActiveAt: r.lastActiveAt,
  };
}

export class AccountService {
  private failures = new Map<string, number[]>();
  private touched = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly signupPolicy: () => SignupPolicy,
  ) {}

  async setupRequired(): Promise<boolean> {
    return !(await this.db.select({ id: users.id }).from(users).limit(1).get());
  }

  /** Creates the first account as admin and hands it every row created before accounts existed. */
  async setup(input: { username: string; name: string; password: string }, client: ClientInfo): Promise<{ token: string; user: UserSummary }> {
    if (!(await this.setupRequired())) throw new AccountError('setup_done', 'This server already has an admin. Sign in instead.');
    const user = await this.insertUser({ ...input, role: 'admin', mustChangePassword: false });
    for (const table of [sessions, projects, files, usageEvents]) await this.db.update(table).set({ userId: user.id }).where(isNull(table.userId));
    return { token: await this.startSession(user.id, client), user: toUserSummary(user) };
  }

  /**
   * "Run on this computer": the first account from a name alone. The username is derived from it and the password is
   * random and never shown, so nobody signs in with one; the owner signs in through `signInOwner` instead.
   */
  async setupLocal(name: string, client: ClientInfo): Promise<{ token: string; user: UserSummary }> {
    return this.setup({ username: usernameFrom(name), name, password: newToken() }, client);
  }

  /** "Run on this computer": signs in the first admin, who owns this installation, without a password. */
  async signInOwner(client: ClientInfo): Promise<{ token: string; user: UserSummary }> {
    const row = await this.db.select().from(users).where(and(eq(users.role, 'admin'), isNull(users.disabledAt))).orderBy(users.createdAt).limit(1).get();
    if (!row) throw new AccountError('not_found', 'This computer has no account yet. Set up Atelier first.');
    return { token: await this.startSession(row.id, client), user: toUserSummary(row) };
  }

  async login(input: { username: string; password: string }, client: ClientInfo): Promise<{ token: string; user: UserSummary }> {
    const key = `${input.username}|${client.ip ?? ''}`;
    if (this.recentFailures(key) >= MAX_FAILURES) throw new AccountError('rate_limited', 'Too many attempts. Try again in a few minutes.');
    const row = await this.db.select().from(users).where(eq(users.username, input.username)).get();
    // Verify against a dummy hash for unknown users so timing doesn't reveal which usernames exist.
    const ok = (await verifyPassword(input.password, row?.passwordHash || DUMMY_HASH)) && !!row?.passwordHash;
    if (!row || !ok) {
      this.failures.set(key, [...this.recentFailuresList(key), Date.now()]);
      throw new AccountError('invalid_credentials', 'Wrong username or password.');
    }
    this.failures.delete(key);
    this.assertActive(row);
    return { token: await this.startSession(row.id, client), user: toUserSummary(row) };
  }

  /** Signs in someone who proved who they are another way (a passkey, an identity provider); the account must still be active. */
  async signInAs(userId: string, client: ClientInfo): Promise<{ token: string; user: UserSummary }> {
    const row = await this.row(userId);
    this.assertActive(row);
    return { token: await this.startSession(row.id, client), user: toUserSummary(row) };
  }

  /**
   * An account for someone an identity provider vouches for. It has no password until they set one in Settings ›
   * Account. A username that is taken gets a number: being called the same at the provider doesn't make it the same person.
   */
  async createForIdentity(input: { username: string; name: string; role: 'user' | 'pending' }): Promise<UserSummary> {
    let username = input.username;
    for (let n = 2; await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get(); n++) username = `${input.username.slice(0, 28)}${n}`;
    return toUserSummary(await this.insertUser({ ...input, username, password: null, mustChangePassword: false }));
  }

  async signup(input: { username: string; name: string; password: string }): Promise<void> {
    if (this.signupPolicy() !== 'open') throw new AccountError('signup_closed', 'Sign-up is by invitation. Ask an admin for an invite code.');
    await this.insertUser({ ...input, role: 'pending', mustChangePassword: false });
  }

  /** Throws unless the invite code (or an older link's token) is open; it stays open. */
  async checkInvite(invite: string, client: Pick<ClientInfo, 'ip'>): Promise<void> {
    await this.openInvite(invite, client);
  }

  async acceptInvite(input: { invite: string; username: string; name: string; password: string }, client: ClientInfo): Promise<{ token: string; user: UserSummary }> {
    const invite = await this.openInvite(input.invite, client);
    const user = await this.insertUser({ username: input.username, name: input.name, password: input.password, role: invite.role, mustChangePassword: false });
    await this.db.update(invites).set({ usedAt: Date.now(), usedBy: user.id }).where(eq(invites.id, invite.id));
    return { token: await this.startSession(user.id, client), user: toUserSummary(user) };
  }

  /** The user behind a token, or null when it is unknown, expired, or the account can't sign in. */
  async authenticate(token: string): Promise<Authenticated | null> {
    const now = Date.now();
    const row = await this.db
      .select({ session: authSessions, user: users })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(eq(authSessions.tokenHash, hashToken(token)))
      .get();
    if (!row || row.session.expiresAt < now || row.user.disabledAt || row.user.role === 'pending') return null;
    if (now - (this.touched.get(row.session.id) ?? 0) > TOUCH_INTERVAL_MS) {
      this.touched.set(row.session.id, now);
      await this.db.update(authSessions).set({ lastSeenAt: now, expiresAt: now + SESSION_TTL_MS }).where(eq(authSessions.id, row.session.id));
      await this.db.update(users).set({ lastActiveAt: now }).where(eq(users.id, row.user.id));
    }
    return { user: toUserSummary(row.user), sessionId: row.session.id };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.delete(authSessions).where(eq(authSessions.id, sessionId));
  }

  async listSessions(userId: string, currentSessionId: string | null): Promise<AuthSessionSummary[]> {
    const rows = await this.db.select().from(authSessions).where(and(eq(authSessions.userId, userId), sql`${authSessions.expiresAt} > ${Date.now()}`)).orderBy(desc(authSessions.lastSeenAt)).all();
    return rows.map((r) => ({ id: r.id, clientKind: r.clientKind, userAgent: r.userAgent, ip: r.ip, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: r.id === currentSessionId }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.db.delete(authSessions).where(and(eq(authSessions.userId, userId), eq(authSessions.id, sessionId)));
  }

  /** Signs out every session of the user, optionally keeping one (the caller's after a password change). */
  async revokeAll(userId: string, keep?: string): Promise<void> {
    await this.db.delete(authSessions).where(keep ? and(eq(authSessions.userId, userId), ne(authSessions.id, keep)) : eq(authSessions.userId, userId));
  }

  async get(userId: string): Promise<UserSummary> {
    return toUserSummary(await this.row(userId));
  }

  async update(userId: string, patch: { name?: string; avatar?: string | null }): Promise<UserSummary> {
    await this.db
      .update(users)
      .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.avatar !== undefined ? { avatarBlob: patch.avatar } : {}), updatedAt: Date.now() })
      .where(eq(users.id, userId));
    return this.get(userId);
  }

  async changePassword(userId: string, current: string, next: string, keepSession: string | null): Promise<void> {
    const row = await this.row(userId);
    // An account without a password has none to prove: being signed in is all it has, as for adding a passkey.
    if (row.passwordHash && !(await verifyPassword(current, row.passwordHash))) throw new AccountError('invalid_credentials', 'The current password is wrong.');
    await this.db.update(users).set({ passwordHash: await hashPassword(next), mustChangePassword: false, updatedAt: Date.now() }).where(eq(users.id, userId));
    await this.revokeAll(userId, keepSession ?? undefined);
  }

  // ------------------------------------------------------------------ admin

  async list(): Promise<UserSummary[]> {
    return (await this.db.select().from(users).orderBy(users.createdAt).all()).map(toUserSummary);
  }

  async create(input: { username: string; name: string; role: Exclude<UserRole, 'pending'> }): Promise<{ user: UserSummary; temporaryPassword: string }> {
    const password = temporaryPassword();
    const user = await this.insertUser({ ...input, password, mustChangePassword: true });
    return { user: toUserSummary(user), temporaryPassword: password };
  }

  async adminUpdate(id: string, patch: { name?: string; role?: UserRole; disabled?: boolean; safeguards?: SafeguardsOverride }): Promise<UserSummary> {
    const row = await this.row(id);
    const losesAdmin = row.role === 'admin' && ((patch.role !== undefined && patch.role !== 'admin') || patch.disabled === true);
    if (losesAdmin) await this.assertOtherAdmin(id);
    await this.db
      .update(users)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.disabled !== undefined ? { disabledAt: patch.disabled ? Date.now() : null } : {}),
        ...(patch.safeguards !== undefined ? { safeguards: patch.safeguards } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(users.id, id));
    if (patch.disabled || patch.role === 'pending') await this.revokeAll(id);
    return this.get(id);
  }

  async resetPassword(id: string): Promise<string> {
    await this.row(id);
    const password = temporaryPassword();
    await this.db.update(users).set({ passwordHash: await hashPassword(password), mustChangePassword: true, updatedAt: Date.now() }).where(eq(users.id, id));
    await this.revokeAll(id);
    return password;
  }

  /** Deletes the account and everything it owns (chats, projects, files). */
  async remove(id: string): Promise<void> {
    const row = await this.row(id);
    if (row.role === 'admin') await this.assertOtherAdmin(id);
    await this.db.delete(users).where(eq(users.id, id));
  }

  async listInvites(): Promise<InviteSummary[]> {
    const rows = await this.db.select().from(invites).orderBy(desc(invites.createdAt)).all();
    return rows.map(toInviteSummary);
  }

  /** A single-use code for one account with this role, open for 7 days. It is returned only here. */
  async createInvite(role: 'admin' | 'user', createdBy: string): Promise<{ invite: InviteSummary; code: string }> {
    const code = newInviteCode();
    const now = Date.now();
    const row: InviteRow = { id: newId(), tokenHash: hashToken(code), codeHint: code.slice(-4), role, createdBy, createdAt: now, expiresAt: now + INVITE_TTL_MS, usedAt: null, usedBy: null };
    await this.db.insert(invites).values(row);
    return { invite: toInviteSummary(row), code: formatInviteCode(code) };
  }

  async revokeInvite(id: string): Promise<void> {
    await this.db.delete(invites).where(eq(invites.id, id));
  }

  /** Drops expired sign-in sessions and invites. */
  async prune(): Promise<void> {
    const now = Date.now();
    await this.db.delete(authSessions).where(lt(authSessions.expiresAt, now));
    await this.db.delete(invites).where(and(isNull(invites.usedAt), lt(invites.expiresAt, now)));
  }

  // ------------------------------------------------------------------ internals

  private async insertUser(input: { username: string; name: string; password: string | null; role: UserRole; mustChangePassword: boolean }): Promise<UserRow> {
    if (await this.db.select({ id: users.id }).from(users).where(eq(users.username, input.username)).get()) {
      throw new AccountError('exists', `The username “${input.username}” is taken.`);
    }
    const now = Date.now();
    const row: UserRow = {
      id: newId(),
      username: input.username,
      name: input.name,
      role: input.role,
      passwordHash: input.password === null ? '' : await hashPassword(input.password),
      mustChangePassword: input.mustChangePassword,
      safeguards: 'inherit',
      avatarBlob: null,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: null,
      disabledAt: null,
    };
    await this.db.insert(users).values(row);
    return row;
  }

  private async startSession(userId: string, client: ClientInfo): Promise<string> {
    const token = newToken();
    const now = Date.now();
    await this.db.insert(authSessions).values({
      id: newId(),
      tokenHash: hashToken(token),
      userId,
      clientKind: client.clientKind,
      deviceId: client.deviceId ?? null,
      userAgent: (client.userAgent ?? '').slice(0, 300),
      ip: client.ip ?? '',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    await this.db.update(users).set({ lastActiveAt: now }).where(eq(users.id, userId));
    return token;
  }

  private assertActive(row: UserRow): void {
    if (row.disabledAt) throw new AccountError('disabled', 'This account is disabled. Ask an admin to re-enable it.');
    if (row.role === 'pending') throw new AccountError('pending', 'Your account is waiting for an admin to approve it.');
  }

  private async assertOtherAdmin(id: string): Promise<void> {
    const others = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), ne(users.id, id), isNull(users.disabledAt)))
      .limit(1)
      .get();
    if (!others) throw new AccountError('last_admin', 'This is the only admin. Make someone else an admin first.');
  }

  private async row(id: string): Promise<UserRow> {
    const row = await this.db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw new AccountError('not_found', 'No such user.');
    return row;
  }

  /** The open invite behind what someone entered. Wrong ones count per address, like wrong passwords. */
  private async openInvite(input: string, client: Pick<ClientInfo, 'ip'>): Promise<InviteRow> {
    const key = `invite|${client.ip ?? ''}`;
    if (this.recentFailures(key) >= MAX_FAILURES) throw new AccountError('rate_limited', 'Too many attempts. Try again in a few minutes.');
    const code = normalizeInviteCode(input);
    const invite = await this.db.select().from(invites).where(eq(invites.tokenHash, hashToken(code ?? input))).get();
    if (!invite || invite.usedAt || invite.expiresAt < Date.now()) {
      this.failures.set(key, [...this.recentFailuresList(key), Date.now()]);
      throw new AccountError('invalid_invite', 'This invite code is wrong, already used or expired.');
    }
    return invite;
  }

  private recentFailuresList(key: string): number[] {
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    return (this.failures.get(key) ?? []).filter((t) => t > cutoff);
  }

  private recentFailures(key: string): number {
    return this.recentFailuresList(key).length;
  }
}

/** A username from a display name: lowercase letters and digits joined by dots, `me` when nothing usable is left. */
export function usernameFrom(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 32)
    .replace(/\.+$/, '');
  return base.length >= 2 ? base : 'me';
}

function toInviteSummary(r: InviteRow): InviteSummary {
  return { id: r.id, role: r.role, hint: r.codeHint, createdAt: r.createdAt, expiresAt: r.expiresAt, usedAt: r.usedAt, usedBy: r.usedBy };
}

/** 16 symbols from 80 random bits, five bits each, so every symbol is equally likely. */
export function newInviteCode(): string {
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let code = '';
  for (let i = 15; i >= 0; i--) code += INVITE_CODE_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return code;
}

/** A valid hash of a random password, so unknown usernames cost the same time as wrong passwords. */
const DUMMY_HASH = await hashPassword(newToken());
