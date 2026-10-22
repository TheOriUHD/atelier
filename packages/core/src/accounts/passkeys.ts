/**
 * Passkeys (ARCHITECTURE §14, M5): WebAuthn credentials for signing in on the web without a password. A
 * passkey belongs to the site's hostname, so it works only where the app is opened in a browser at that
 * address (the desktop app keeps using passwords). Challenges live in memory for a few minutes.
 */
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransport, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { and, desc, eq } from 'drizzle-orm';
import type { PasskeySummary, UserSummary } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { passkeys } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import { AccountError, type AccountService, type ClientInfo } from './account-service.ts';

const CHALLENGE_TTL_MS = 5 * 60_000;
/** Starting a sign-in needs no account, so open ceremonies are capped; the oldest give way. */
const MAX_OPEN_CHALLENGES = 1000;

/** The site a ceremony runs for: its origin (`https://atelier.example.com`) and hostname (the RP ID). */
export interface RelyingParty {
  origin: string;
  name: string;
}

export class Passkeys {
  private challenges = new Map<string, { challenge: string; userId: string | null; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly accounts: AccountService,
  ) {}

  async list(userId: string): Promise<PasskeySummary[]> {
    const rows = await this.db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(desc(passkeys.createdAt)).all();
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.db.delete(passkeys).where(and(eq(passkeys.userId, userId), eq(passkeys.id, id)));
  }

  /** Starts adding a passkey for a signed-in person. */
  async registrationOptions(user: UserSummary, rp: RelyingParty): Promise<{ flowId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    const existing = await this.db.select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: new URL(rp.origin).hostname,
      userName: user.username,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransport[] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return { flowId: this.remember(options.challenge, user.id), options };
  }

  async register(user: UserSummary, flowId: string, response: RegistrationResponseJSON, rp: RelyingParty, name: string): Promise<PasskeySummary> {
    const challenge = this.take(flowId, user.id);
    const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: new URL(rp.origin).hostname }).catch(() => null);
    if (!result?.verified) throw new AccountError('invalid_credentials', 'The passkey couldn’t be verified. Try again.');
    const { credential } = result.registrationInfo;
    const row = {
      id: credential.id,
      userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? [],
      name: name.trim().slice(0, 80) || 'Passkey',
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    await this.db.insert(passkeys).values(row);
    return { id: row.id, name: row.name, createdAt: row.createdAt, lastUsedAt: null };
  }

  /** Starts a passkey sign-in; the browser offers the passkeys it has for this site. */
  async authenticationOptions(rp: RelyingParty): Promise<{ flowId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    const options = await generateAuthenticationOptions({ rpID: new URL(rp.origin).hostname, userVerification: 'required' });
    return { flowId: this.remember(options.challenge, null), options };
  }

  async signIn(flowId: string, response: AuthenticationResponseJSON, rp: RelyingParty, client: ClientInfo): Promise<{ token: string; user: UserSummary }> {
    const challenge = this.take(flowId, null);
    const row = await this.db.select().from(passkeys).where(eq(passkeys.id, response.id)).get();
    const invalid = new AccountError('invalid_credentials', 'That passkey isn’t registered here.');
    if (!row) throw invalid;
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: new URL(rp.origin).hostname,
      credential: { id: row.id, publicKey: Buffer.from(row.publicKey, 'base64url'), counter: row.counter, transports: row.transports as AuthenticatorTransport[] },
    }).catch(() => null);
    if (!result?.verified) throw invalid;
    await this.db.update(passkeys).set({ counter: result.authenticationInfo.newCounter, lastUsedAt: Date.now() }).where(eq(passkeys.id, row.id));
    return this.accounts.signInAs(row.userId, client);
  }

  private remember(challenge: string, userId: string | null): string {
    const now = Date.now();
    for (const [id, c] of this.challenges) if (c.expires < now) this.challenges.delete(id);
    if (this.challenges.size >= MAX_OPEN_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value!);
    const flowId = newId();
    this.challenges.set(flowId, { challenge, userId, expires: now + CHALLENGE_TTL_MS });
    return flowId;
  }

  /** A ceremony's challenge, used once, for the same person who started it. */
  private take(flowId: string, userId: string | null): string {
    const c = this.challenges.get(flowId);
    this.challenges.delete(flowId);
    if (!c || c.expires < Date.now() || c.userId !== userId) throw new AccountError('invalid_credentials', 'That passkey request expired. Try again.');
    return c.challenge;
  }
}
