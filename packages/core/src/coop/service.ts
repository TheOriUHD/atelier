/**
 * Co-op (ARCHITECTURE §24): who is in a shared session and what they may do, the host's settings, presence and typing.
 * The session itself runs like any other in chat-service.ts; this decides who the turns are for and who answers what.
 *
 * The host is the session's own person. On a team server the others are accounts there; across desktops they are
 * peers that came in through the relay (host.ts). Either way they are rows in `session_participants`.
 */
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  accountParticipant,
  CoopSettings,
  DEFAULT_COOP_SETTINGS,
  type CoopState,
  type ModelsChoice,
  type Participant,
  type ParticipantRole,
  type RunEvent,
} from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { coopRooms, usageEvents } from '../store/schema.ts';
import type { SessionRow } from '../sessions/session-repo.ts';
import { ParticipantRepo, type ParticipantRow } from './participants.ts';

/** A participant as a turn or a check needs them; the host included. */
export interface ParticipantInfo {
  id: string;
  kind: 'account' | 'peer';
  /** The account on this backend: the host's, or a server member's; null for a peer. */
  userId: string | null;
  peerKey: string | null;
  role: ParticipantRole;
  models: ModelsChoice;
  model: string | null;
  trusted: boolean;
  name: string;
}

export type RoomRow = typeof coopRooms.$inferSelect;

/** What the relay side adds for desktop hosts (host.ts); absent on a team server, where co-op needs no relay. */
export interface CoopRelayPort {
  invite(sessionId: string): { url: string; expiresAt: number } | null;
  knocking(sessionId: string): { id: string; name: string; fingerprint: string[] }[];
  /** Whether the guest `participantId`'s computer is connected right now. */
  peerOnline(sessionId: string, participantId: string): boolean;
}

export interface CoopDeps {
  db: Db;
  sessionRow(id: string): Promise<SessionRow | null>;
  /** An account's display name and avatar blob. */
  account(userId: string): Promise<{ name: string; avatar: string | null } | null>;
  /** Sends a run event to everyone watching the session. */
  emit(sessionId: string, event: RunEvent): void;
  /** The session's summary changed for its participants' sidebars (added, removed, ended). */
  changed(sessionId: string, userIds: string[]): void;
  /** Accounts with a window on the session right now. */
  watchers(sessionId: string): Set<string>;
  relay?: CoopRelayPort;
  now?(): number;
}

const TYPING_EVERY_MS = 2000;

export class CoopService {
  readonly participants: ParticipantRepo;
  private readonly typed = new Map<string, number>();

  constructor(private readonly deps: CoopDeps) {
    this.participants = new ParticipantRepo(deps.db);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The co-op room of a session, while co-op is on. */
  async room(sessionId: string): Promise<RoomRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(coopRooms)
      .where(and(eq(coopRooms.sessionId, sessionId), isNull(coopRooms.endedAt)));
    return row ?? null;
  }

  /** Whether the session is shared right now: co-op is on for it (sub-agents and side chats ask for their root). */
  async isShared(sessionId: string): Promise<boolean> {
    return !!(await this.room(await this.rootOf(sessionId)));
  }

  /** The main session a sub-agent or side chat belongs to. */
  async rootOf(sessionId: string): Promise<string> {
    let id = sessionId;
    for (let i = 0; i < 20; i++) {
      const row = await this.deps.sessionRow(id);
      if (!row?.parentSessionId) return id;
      id = row.parentSessionId;
    }
    return id;
  }

  async settings(sessionId: string): Promise<CoopSettings> {
    const room = await this.room(sessionId);
    const parsed = CoopSettings.safeParse({ ...DEFAULT_COOP_SETTINGS, ...(room?.settings ?? {}) });
    return parsed.success ? parsed.data : DEFAULT_COOP_SETTINGS;
  }

  /** Turns co-op on for a session (or returns the room it has). `relayUrl` null: on this server, no relay. */
  async start(sessionId: string, opts: { relayUrl: string | null; roomId?: string | null; hostTokenSecret?: string | null } = { relayUrl: null }): Promise<RoomRow> {
    const existing = await this.room(sessionId);
    if (existing) return existing;
    await this.deps.db
      .insert(coopRooms)
      .values({ sessionId, relayUrl: opts.relayUrl, roomId: opts.roomId ?? null, hostTokenSecret: opts.hostTokenSecret ?? null, settings: { ...DEFAULT_COOP_SETTINGS }, createdAt: this.now(), endedAt: null })
      .onConflictDoUpdate({ target: coopRooms.sessionId, set: { relayUrl: opts.relayUrl, roomId: opts.roomId ?? null, hostTokenSecret: opts.hostTokenSecret ?? null, endedAt: null, createdAt: this.now() } });
    return (await this.room(sessionId))!;
  }

  async updateSettings(sessionId: string, patch: Partial<CoopSettings>): Promise<CoopSettings> {
    const next = CoopSettings.parse({ ...(await this.settings(sessionId)), ...patch });
    await this.deps.db.update(coopRooms).set({ settings: next }).where(eq(coopRooms.sessionId, sessionId));
    await this.presence(sessionId);
    return next;
  }

  async setRoom(sessionId: string, patch: Partial<Pick<RoomRow, 'relayUrl' | 'roomId' | 'hostTokenSecret' | 'inviteSecret' | 'inviteExpiresAt'>>): Promise<void> {
    await this.deps.db.update(coopRooms).set(patch).where(eq(coopRooms.sessionId, sessionId));
  }

  /** The host as a participant. */
  private async host(row: SessionRow): Promise<ParticipantInfo | null> {
    if (!row.userId) return null;
    const account = await this.deps.account(row.userId);
    return { id: accountParticipant(row.userId), kind: 'account', userId: row.userId, peerKey: null, role: 'host', models: 'host', model: row.model, trusted: true, name: account?.name ?? 'Host' };
  }

  private info(p: ParticipantRow): ParticipantInfo {
    return { id: p.id, kind: p.kind, userId: p.userId, peerKey: p.peerKey, role: p.role, models: p.models, model: p.model, trusted: p.trusted, name: p.name };
  }

  /** A participant of the session (its root), the host included; null for someone not in it. */
  async participant(sessionId: string, participantId: string): Promise<ParticipantInfo | null> {
    const root = await this.rootOf(sessionId);
    const row = await this.deps.sessionRow(root);
    if (!row) return null;
    const host = await this.host(row);
    if (host && host.id === participantId) return host;
    const p = await this.participants.get(root, participantId);
    return p && p.leftAt === null ? this.info(p) : null;
  }

  /** An account's part in a session (its root): the host when it owns it, its participant row otherwise. */
  async participantOfUser(sessionId: string, userId: string): Promise<ParticipantInfo | null> {
    return this.participant(sessionId, accountParticipant(userId));
  }

  /** Everyone in the session as the client shows them: the host first, then in the order they came in. */
  async list(sessionId: string): Promise<Participant[]> {
    const root = await this.rootOf(sessionId);
    const row = await this.deps.sessionRow(root);
    if (!row) return [];
    const watchers = this.deps.watchers(root);
    const out: Participant[] = [];
    const host = await this.host(row);
    if (host?.userId) {
      const account = await this.deps.account(host.userId);
      out.push({ id: host.id, kind: 'account', name: host.name, avatar: account?.avatar ?? null, role: 'host', models: 'host', model: row.model, trusted: true, online: watchers.has(host.userId), joinedAt: row.createdAt });
    }
    for (const p of await this.participants.list(root)) {
      const online = p.kind === 'account' ? !!p.userId && watchers.has(p.userId) : !!this.deps.relay?.peerOnline(root, p.id);
      out.push({ id: p.id, kind: p.kind, name: p.name, avatar: p.avatar, role: p.role, models: p.models, model: p.model, trusted: p.trusted, online, joinedAt: p.joinedAt });
    }
    return out;
  }

  /** Tells everyone watching who is in the session and online now. */
  async presence(sessionId: string): Promise<void> {
    const root = await this.rootOf(sessionId);
    if (!(await this.room(root))) return;
    this.deps.emit(root, { type: 'presence', participants: await this.list(root) });
  }

  /** A participant types in the message box: told to the others at most every 2 s. */
  typing(sessionId: string, participantId: string): void {
    const key = `${sessionId}\n${participantId}`;
    const now = this.now();
    if (now - (this.typed.get(key) ?? 0) < TYPING_EVERY_MS) return;
    this.typed.set(key, now);
    this.deps.emit(sessionId, { type: 'typing', participantId });
  }

  /** Adds accounts of this server (a team server's co-op). */
  async addAccount(sessionId: string, userId: string, role: Exclude<ParticipantRole, 'host'>): Promise<ParticipantRow> {
    const account = await this.deps.account(userId);
    if (!account) throw new Error('That account doesn’t exist.');
    const settings = await this.settings(sessionId);
    const row = await this.participants.add({ sessionId, id: accountParticipant(userId), kind: 'account', userId, name: account.name, avatar: account.avatar, role, models: settings.shareModels ? 'host' : 'own' }, this.now());
    this.deps.changed(sessionId, [userId]);
    await this.presence(sessionId);
    return row;
  }

  /** Adds a guest from another computer whom the host let in (host.ts). */
  async addPeer(sessionId: string, p: { id: string; peerKey: string; name: string; avatar: string | null; models: ModelsChoice }): Promise<ParticipantRow> {
    const row = await this.participants.add({ sessionId, id: p.id, kind: 'peer', peerKey: p.peerKey, name: p.name, avatar: p.avatar, role: 'editor', models: p.models }, this.now());
    await this.presence(sessionId);
    return row;
  }

  async setRole(sessionId: string, participantId: string, role: Exclude<ParticipantRole, 'host'>): Promise<void> {
    await this.participants.update(sessionId, participantId, { role, ...(role === 'viewer' ? { trusted: false } : {}) });
    await this.presence(sessionId);
  }

  async setTrusted(sessionId: string, participantId: string, trusted: boolean): Promise<void> {
    await this.participants.update(sessionId, participantId, { trusted });
    await this.presence(sessionId);
  }

  /** A participant's choice of whose models answer them, and which. The host's only while the host shares them. */
  async setModels(sessionId: string, participantId: string, models: ModelsChoice, model: string | null): Promise<void> {
    if (models === 'host' && !(await this.settings(sessionId)).shareModels) throw new Error('The host doesn’t share their models in this session.');
    await this.participants.update(sessionId, participantId, { models, model });
    await this.presence(sessionId);
  }

  /** The host removes someone, or they leave. Returns who it was, for the run's clean-up (chat-service.ts). */
  async remove(sessionId: string, participantId: string): Promise<ParticipantRow | null> {
    const row = await this.participants.get(sessionId, participantId);
    if (!row || row.leftAt !== null) return null;
    await this.participants.remove(sessionId, participantId, this.now());
    if (row.userId) this.deps.changed(sessionId, [row.userId]);
    await this.presence(sessionId);
    return row;
  }

  /** Co-op ends: everyone but the host leaves, and the session is the host's alone again. */
  async end(sessionId: string): Promise<ParticipantRow[]> {
    const gone = await this.participants.list(sessionId);
    await this.participants.removeAll(sessionId, this.now());
    await this.deps.db.update(coopRooms).set({ endedAt: this.now(), inviteSecret: null, inviteExpiresAt: null }).where(eq(coopRooms.sessionId, sessionId));
    this.deps.changed(sessionId, gone.flatMap((p) => (p.userId ? [p.userId] : [])));
    this.deps.emit(sessionId, { type: 'presence', participants: [] });
    return gone;
  }

  /** What a guest answering with the host's models used of them today: requests and dollars. */
  async sharedUse(sessionId: string, participantId: string): Promise<{ requests: number; spentUsd: number }> {
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    const [row] = await this.deps.db
      .select({ requests: sql<number>`count(*)`, spent: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)` })
      .from(usageEvents)
      .where(and(eq(usageEvents.sessionId, sessionId), eq(usageEvents.participant, participantId), gte(usageEvents.ts, start.getTime())));
    return { requests: Number(row?.requests ?? 0), spentUsd: Number(row?.spent ?? 0) };
  }

  /** Why a guest can't use the host's models for another request right now, or null when they can. */
  async sharedCapReached(sessionId: string, participantId: string): Promise<string | null> {
    const settings = await this.settings(sessionId);
    if (!settings.shareModels) return 'The host doesn’t share their models in this session: choose one of your own.';
    const used = await this.sharedUse(sessionId, participantId);
    if (settings.sharedRequestsPerDay !== null && used.requests >= settings.sharedRequestsPerDay)
      return `You’ve used the ${settings.sharedRequestsPerDay} requests a day the host shares with each guest. It starts again tomorrow, or choose one of your own models.`;
    if (settings.sharedSpendPerDayUsd !== null && used.spentUsd >= settings.sharedSpendPerDayUsd)
      return `You’ve used the $${settings.sharedSpendPerDayUsd.toFixed(2)} a day the host shares with each guest. It starts again tomorrow, or choose one of your own models.`;
    return null;
  }

  /** The co-op state as one viewer sees it. */
  async state(sessionId: string, viewer: ParticipantInfo): Promise<CoopState | null> {
    const room = await this.room(sessionId);
    if (!room) return null;
    const host = viewer.role === 'host';
    return {
      sessionId,
      me: viewer.id,
      role: viewer.role,
      participants: await this.list(sessionId),
      settings: await this.settings(sessionId),
      invite: host ? (this.deps.relay?.invite(sessionId) ?? null) : null,
      knocking: host ? (this.deps.relay?.knocking(sessionId) ?? []) : [],
      via: room.relayUrl ? 'relay' : 'server',
      hostAway: false,
      ended: room.endedAt !== null,
      sharedUse: !host && viewer.models === 'host' ? await this.sharedUse(sessionId, viewer.id) : null,
    };
  }
}
