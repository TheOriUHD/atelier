/**
 * Co-op between computers, the guest's side (ARCHITECTURE §24). Joining a session on someone else's computer puts a
 * mirror of it in this person's own Atelier, `coop_<room>_<host session>`: the sidebar lists it, and the app's ordinary
 * calls for it (subscribe, send, queue, approve…) go to the host over the encrypted channel, the host's run events come
 * back the same way. Nothing of the session is stored here while it lasts, only the membership to join again; when it
 * ends the host may let them keep a copy, which is then a normal session of theirs.
 *
 * The same channel carries the other direction: the host asks this computer to run the guest's own model for their
 * turns (`model.describe` / `model.stream`), and to call the connectors they lend, each call only after they allowed it
 * in the session.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  appError,
  COOP_MIRROR_PREFIX,
  CoopContract,
  createRpcClient,
  isCoopMirror,
  lentToolOf,
  parseAnswerWith,
  parsePeerModelRef,
  parseInviteFragment,
  PeerContract,
  serveRpc,
  type CoopState,
  type CoopWelcome,
  type FileRef,
  type Handlers,
  type Message,
  type ModelInfo,
  type ModelsChoice,
  type PendingInteraction,
  type PermissionRequest,
  type RpcClient,
  type RunEvent,
  type SessionSnapshot,
  type SessionSummary,
  type Usage,
} from '@atelier/protocol';
import type { ModelResolver } from '../agent/chat-service.ts';
import type { StreamEvent } from '../providers/types.ts';
import type { Db } from '../store/db.ts';
import { coopMemberships } from '../store/schema.ts';
import { lanes, type JsonChannel } from './lanes.ts';
import { PEER_SELF } from './peer-model.ts';

/** A guest's channel to the host (channel.ts `GuestChannel`). */
export interface GuestChannelPort extends JsonChannel {
  /** The host's device key, base64: pinned after the first join. */
  readonly remoteKey: string;
  readonly fingerprint: readonly string[];
  /** The link is back after a gap: what was sent meanwhile is lost. */
  onReconnected(handler: () => void): void;
  /** The relay says whether the host's computer is connected. */
  onHost(handler: (present: boolean) => void): void;
  /** The secret for the next handshake: the member secret the host gave once it let them in. */
  setSecret(secret: string): void;
  close(): void;
}

export interface GuestTransportPort {
  /** `userId`: whose device key the handshake uses (on a server, each account has its own). */
  join(opts: { relayUrl: string; roomId: string; secret: string; name: string; version: string; hostKey: string | null; signal?: AbortSignal; userId?: string }): Promise<GuestChannelPort>;
}

/** A connector tool of this person's that they may lend to their turns in someone else's session. */
export interface LentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  call(input: unknown, signal: AbortSignal): Promise<{ content: unknown[]; isError?: boolean }>;
}

export interface CoopGatewayDeps {
  db: Db;
  relayUrl(): string | null;
  transport: GuestTransportPort;
  secrets: { get(id: string): Promise<string | null | undefined>; set(id: string, value: string): Promise<void>; delete(id: string): Promise<void> };
  /** The person's name and avatar (a data URL) as others see them. */
  profile(userId: string): Promise<{ name: string; avatar: string | null }>;
  version: string;
  /** To the person's own windows. */
  emitToUser(userId: string, event: 'sessions.changed', payload: SessionSummary): void;
  emitToUser(userId: string, event: 'sessions.removed', payload: { id: string }): void;
  /** A run event of a mirror, to the windows that have it open. */
  emitSession(sessionId: string, seq: number, event: RunEvent): void;
  /** The person's own models, for their turns in the host's session. */
  models: ModelResolver;
  /** Why the person can't send another request right now (their own limits), or null. */
  limit(userId: string): Promise<string | null>;
  /** What their model used for the host's session, on their own Usage page. */
  recordUsage(entry: { userId: string; sessionId: string; model: ModelInfo; usage: Usage; mode: string }): void;
  /** Their connectors' tools (only when they lend them). */
  connectorTools(userId: string): Promise<LentTool[]>;
  hasBlob(sha256: string): Promise<boolean>;
  putBlob(bytes: Uint8Array, mime: string): Promise<string>;
  /** Keeps a copy of the conversation as a session of the person's own; returns its id. */
  saveCopy(userId: string, snapshot: SessionSnapshot, title: string): Promise<string | null>;
  /** Whether a sidebar group is this person's (to file a mirror in it). */
  ownsGroup(userId: string, groupId: string): Promise<boolean>;
  /**
   * A server: many accounts on one backend. Each joins with its own device key, under ids of its own (two accounts of
   * one server can be in the same room), and sees a blob of a mirror only once its own host sent it (`canRead`,
   * `grant`): one that is here already may be another account's. A desktop has one person and leaves these out.
   */
  perAccount?: boolean;
  /** Whether the account may read a blob already (something of theirs refers to it). */
  canRead?(userId: string, sha256: string): Promise<boolean>;
  /** The account's host sent this blob for a session they are in: theirs to read for a while (store/blob-access.ts). */
  grant?(userId: string, sha256: string): void;
  log(message: string, error?: unknown): void;
  now?(): number;
}

type Membership = typeof coopMemberships.$inferSelect;

interface Link {
  membership: Membership;
  channel: GuestChannelPort | null;
  client: RpcClient<typeof CoopContract> | null;
  welcome: CoopWelcome | null;
  admitted: boolean;
  /** The host's computer is connected and the channel up. */
  connected: boolean;
  /** Some window here has the session open: the host sends its events. */
  watched: boolean;
  /** The last state seen, shown while the host is away. */
  state: CoopState | null;
  /** The last snapshot, for a copy when it ends. */
  snapshot: SessionSnapshot | null;
  /** Their own model for their turns (a ref on this computer), when they answer with their own. */
  models: ModelsChoice;
  model: string | null;
  /** Other models of their own they asked for by name (an @mention, a second opinion): the host may run those too. */
  secondary: Set<string>;
  /** They lend their connectors to their own turns. */
  lend: boolean;
  /** Connector calls they allowed in the session, each good for one call. */
  allowed: Map<string, number>;
  /** The connector calls the session asked them about, by interaction id. */
  asked: Map<string, string>;
  streams: Map<string, AbortController>;
  ended: boolean;
  /**
   * Sub-agents' and tracks' sessions in the host's session, by the host's ids, as its conversation names them (a tool
   * call that started one, a background agent, a track): their transcripts open here read-only. `watchedChildren` are
   * the ones a window has open.
   */
  children: Set<string>;
  watchedChildren: Set<string>;
  /** The question the host's session waits on is this person's to answer: their sidebar and notifications say so. */
  waitingOnYou: boolean;
}

/** Sub-agents' and tracks' session ids a snapshot or event names: tool calls that started one, background agents. */
export function childSessionIds(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 16 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) childSessionIds(v, out, depth + 1);
    return out;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.childSessionId === 'string') out.add(o.childSessionId);
  if (o.kind === 'agent' && typeof o.sessionId === 'string') out.add(o.sessionId);
  for (const v of Object.values(o)) if (v && typeof v === 'object') childSessionIds(v, out, depth + 1);
  return out;
}

/** At most this many of the guest's own model's requests run for the host at once. */
const MAX_STREAMS = 3;

/** A short tag of an account, for ids that must differ between two accounts of one server. */
const accountTag = (userId: string): string => createHash('sha256').update(userId).digest('base64url').slice(0, 12);

/**
 * The mirror's id on the guest's backend: `coop_<room>_<host session>` on a desktop (one person), with the account's tag
 * after it on a server (`account`), where two accounts may join the same room.
 */
export const mirrorId = (roomId: string, hostSessionId: string, account?: string): string => `${COOP_MIRROR_PREFIX}${roomId}_${hostSessionId}${account ? `_${accountTag(account)}` : ''}`;

/** Where the room's pre-shared key is kept: one per room on a desktop, one per account and room on a server. */
export const pskSecretId = (roomId: string, account?: string): string => `coop-psk-${roomId}${account ? `-${accountTag(account)}` : ''}`;

/** `value` without the parts that name a blob in `missing` (a copy keeps only what its host really sent). */
function withoutBlobs<T>(value: T, missing: ReadonlySet<string>): T {
  if (Array.isArray(value))
    return value.filter((v) => !(v && typeof v === 'object' && typeof (v as { blob?: unknown }).blob === 'string' && missing.has((v as { blob: string }).blob))).map((v) => withoutBlobs(v, missing)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'blob' && typeof v === 'string' && missing.has(v) ? '' : withoutBlobs(v, missing);
    return out as T;
  }
  return value;
}

const callKey = (name: string, input: unknown): string => createHash('sha256').update(name).update('\n').update(JSON.stringify(input ?? null)).digest('hex');

/** The blobs a request refers to (images, documents), to fetch from the host before the model reads them. */
function blobsOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) blobsOf(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'blob' && typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) out.add(v);
      else if (typeof v === 'object') blobsOf(v, out);
    }
  }
  return out;
}

export class CoopGateway {
  private readonly links = new Map<string, Link>();

  constructor(private readonly deps: CoopGatewayDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Joins from an invite: connects, introduces the person, and waits for the host to let them in (`waiting`). */
  async join(userId: string, invite: string, models: ModelsChoice, model: string | null = null): Promise<{ sessionId: string; waiting: boolean; fingerprint?: string[] }> {
    const relayUrl = this.deps.relayUrl();
    if (!relayUrl) throw appError('unsupported', this.deps.perAccount ? 'An admin turned off co-op with other computers on this server.' : 'Co-op between computers is switched off on this computer.');
    const parsed = parseInviteFragment(invite);
    if (!parsed) throw appError('invalid_request', 'That isn’t a co-op invite link.');
    // Already in it (a second click on the same link): the same mirror.
    for (const link of this.links.values())
      if (link.membership.userId === userId && link.membership.roomId === parsed.roomId && !link.ended) return { sessionId: link.membership.id, waiting: !link.admitted, ...(link.channel ? { fingerprint: [...link.channel.fingerprint] } : {}) };
    const account = this.deps.perAccount ? userId : undefined;
    const pskSecret = pskSecretId(parsed.roomId, account);
    const meta = parsed.meta ?? { hostName: 'Someone', title: 'Shared session', mode: 'chat' as const };
    const placeholder: Membership = {
      id: '',
      userId,
      relayUrl,
      roomId: parsed.roomId,
      pskSecret,
      hostKey: null,
      hostName: meta.hostName,
      hostSessionId: null,
      title: meta.title,
      mode: meta.mode,
      copySessionId: null,
      joinedAt: this.now(),
      endedAt: null,
      localTitle: null,
      pinnedAt: null,
      groupId: null,
      archivedAt: null,
      finishedUnseenAt: null,
    };
    const link = this.blank(placeholder, models, model);
    // The invite's secret until the host gives them their own (`keep`), which then replaces it.
    await this.deps.secrets.set(pskSecret, parsed.secret);
    const welcome = await this.connect(link, parsed.secret);
    const id = mirrorId(parsed.roomId, welcome.sessionId, account);
    const joined = { ...placeholder, id, hostKey: link.channel!.remoteKey, hostName: welcome.hostName, hostSessionId: welcome.sessionId, title: welcome.title, mode: welcome.mode };
    // Joining again keeps how they filed it in their sidebar (their name for it, pinned, group).
    const { localTitle: _t, pinnedAt: _p, groupId: _g, archivedAt: _a, finishedUnseenAt: _u, ...fresh } = joined;
    await this.deps.db.insert(coopMemberships).values(joined).onConflictDoUpdate({ target: coopMemberships.id, set: fresh });
    link.membership = (await this.deps.db.select().from(coopMemberships).where(eq(coopMemberships.id, id)))[0] ?? joined;
    this.links.set(id, link);
    this.changed(link);
    // The same four emoji the host sees, to compare with them.
    return { sessionId: id, waiting: !welcome.admitted, fingerprint: [...welcome.fingerprint] };
  }

  /**
   * Joins again the sessions this person was in when Atelier stopped (the host lets pinned guests straight in). Ended
   * ones without a copy stay in the sidebar, ended, until the person removes them.
   */
  async resume(): Promise<void> {
    const rows = await this.deps.db.select().from(coopMemberships).where(isNull(coopMemberships.copySessionId));
    for (const row of rows) {
      if (this.links.has(row.id)) continue;
      const link = this.blank(row, 'host', null);
      this.links.set(row.id, link);
      if (row.endedAt !== null) {
        link.ended = true;
        continue;
      }
      void (async () => {
        const secret = await this.deps.secrets.get(row.pskSecret);
        if (!secret) return this.end(link, false);
        await this.connect(link, secret);
      })().catch((e: unknown) => this.deps.log(`couldn't join ${row.id} again`, e));
    }
  }

  private blank(membership: Membership, models: ModelsChoice, model: string | null): Link {
    return { membership, channel: null, client: null, welcome: null, admitted: false, connected: false, watched: false, state: null, snapshot: null, models, model, secondary: new Set(), lend: false, allowed: new Map(), asked: new Map(), streams: new Map(), ended: false, children: new Set(), watchedChildren: new Set(), waitingOnYou: false };
  }

  /** The channel to the host, its two directions, and what the host tells. */
  private async connect(link: Link, secret: string): Promise<CoopWelcome> {
    const { userId } = link.membership;
    const profile = await this.deps.profile(userId);
    const channel = await this.deps.transport.join({ relayUrl: link.membership.relayUrl, roomId: link.membership.roomId, secret, name: profile.name, version: this.deps.version, hostKey: link.membership.hostKey, userId });
    const { coop, peer } = lanes(channel);
    const client = createRpcClient(CoopContract, coop);
    link.channel = channel;
    link.client = client;
    const peerServer = serveRpc(PeerContract, this.peerHandlers(link, (payload) => peerServer.emit('model.event', payload)), peer, {}, (method, error) => this.deps.log(`co-op peer call ${method} failed`, error));

    client.on('session.event', ({ seq, event }) => this.event(link, seq, event));
    client.on('child.event', ({ sessionId, seq, event }) => {
      if (!link.watchedChildren.has(sessionId)) return;
      this.learn(link, event);
      this.deps.emitSession(sessionId, seq, event);
    });
    client.on('admitted', ({ memberSecret }) => {
      link.admitted = true;
      if (memberSecret) void this.keep(link, memberSecret);
      void this.syncChoice(link).catch(() => undefined);
      this.changed(link);
      if (link.watched) this.resync(link);
    });
    client.on('gone', ({ reason, copy }) => void this.end(link, copy, reason).catch((e: unknown) => this.deps.log('ending a co-op session failed', e)));
    client.on('session.changed', ({ title, mode }) => {
      link.membership = { ...link.membership, title, mode };
      void this.deps.db.update(coopMemberships).set({ title, mode }).where(eq(coopMemberships.id, link.membership.id)).catch(() => undefined);
      this.changed(link);
    });
    channel.onHost((present) => {
      link.connected = present;
      this.emit(link, { type: 'host_away', away: !present });
      this.changed(link);
    });
    channel.onReconnected(() => void this.hello(link).then(() => link.watched && this.resync(link)).catch((e: unknown) => this.deps.log('greeting the host again failed', e)));
    channel.onClose(() => {
      link.connected = false;
      for (const s of link.streams.values()) s.abort();
      link.streams.clear();
      if (!link.ended) {
        this.emit(link, { type: 'host_away', away: true });
        this.changed(link);
      }
    });
    return this.hello(link);
  }

  private async hello(link: Link): Promise<CoopWelcome> {
    const profile = await this.deps.profile(link.membership.userId);
    const welcome = await link.client!.call('coop.hello', { name: profile.name, avatar: profile.avatar, models: link.models, model: link.models === 'own' ? link.model : null, version: this.deps.version });
    link.welcome = welcome;
    link.admitted = welcome.admitted;
    if (welcome.memberSecret) await this.keep(link, welcome.memberSecret);
    link.connected = true;
    this.emit(link, { type: 'host_away', away: false });
    if (welcome.admitted) await this.syncChoice(link).catch(() => undefined);
    return welcome;
  }

  /**
   * What the host has on record for this person's models: after Atelier restarted here, the host's word is what runs.
   * A model of their own is `peer-<key>/<ref>` there and `<ref>` here.
   */
  private async syncChoice(link: Link): Promise<void> {
    const state = await link.client!.call('coop.state', {});
    link.state = state;
    const me = state?.participants.find((p) => p.id === state.me);
    if (!me) return;
    link.models = me.models;
    const own = me.model ? parsePeerModelRef(me.model) : null;
    link.model = me.models === 'own' && own ? own.ref : null;
  }

  /** Their own secret for the room: kept in place of the invite's, and used for every later handshake. */
  private async keep(link: Link, secret: string): Promise<void> {
    link.channel?.setSecret(secret);
    await this.deps.secrets.set(link.membership.pskSecret, secret).catch((e: unknown) => this.deps.log('keeping the co-op member secret failed', e));
  }

  /** The window reloads the session: the host's view of it is the one that counts. */
  private resync(link: Link): void {
    this.emit(link, { type: 'resync' });
  }

  private emit(link: Link, event: RunEvent): void {
    if (link.membership.id) this.deps.emitSession(link.membership.id, link.snapshot?.seq ?? 0, event);
  }

  /** A host run event, as this computer's windows see it; connector questions are noted, for the tickets. */
  /** The sub-agents' and tracks' sessions something from the host names, which this person may then open. */
  private learn(link: Link, value: unknown): void {
    for (const id of childSessionIds(value)) if (!isCoopMirror(id) && id !== link.membership.hostSessionId) link.children.add(id);
  }

  private event(link: Link, seq: number, event: RunEvent): void {
    this.learn(link, event);
    if (event.type === 'pending') {
      this.noteAsked(link, event.pending);
      this.noteWaiting(link, event.pending);
    }
    if (link.snapshot && seq > link.snapshot.seq) link.snapshot = { ...link.snapshot, seq };
    const me = link.welcome?.participantId ?? link.state?.me;
    this.deps.emitSession(link.membership.id, seq, event.type === 'presence' && me ? { ...event, participants: ownModelHere(event.participants, me) } : event);
  }

  /**
   * Whether the question the host's session waits on is this person's: their own (a connector they lend), or the host's
   * when the host trusts them with approvals. Their sidebar shows it waiting and their notifications tell them.
   */
  private noteWaiting(link: Link, pending: PendingInteraction | null): void {
    const me = link.welcome?.participantId ?? link.state?.me;
    const people = link.state?.participants ?? [];
    const self = people.find((p) => p.id === me);
    const hostId = people.find((p) => p.role === 'host')?.id;
    const approver = pending ? (pending.approver ?? hostId) : undefined;
    const mine = !!pending && !!me && (approver === me || (!!self?.trusted && self.role !== 'viewer' && !!hostId && approver === hostId));
    if (mine === link.waitingOnYou) return;
    link.waitingOnYou = mine;
    this.changed(link);
  }

  /** The guest's own connector calls are asked of them in the session; what they allow there may run once. */
  private noteAsked(link: Link, pending: PendingInteraction | null): void {
    if (!pending || pending.kind !== 'permission' || pending.approver !== link.welcome?.participantId) return;
    const request = pending.payload as PermissionRequest;
    const tool = lentToolOf(request.toolName, link.welcome!.participantId);
    if (tool) link.asked.set(pending.id, callKey(tool, request.input));
  }

  /** The summary the sidebar shows for a mirror. */
  summary(link: Link): SessionSummary {
    const m = link.membership;
    const ended = link.ended || m.endedAt !== null;
    return {
      id: m.id,
      mode: m.mode,
      workspaceId: null,
      permissionMode: null,
      title: m.localTitle ?? m.title,
      projectId: null,
      model: null,
      effort: null,
      connectorsOff: [],
      research: false,
      coop: { role: link.state?.role === 'viewer' ? 'viewer' : 'editor', hostName: m.hostName, participants: link.state?.participants.length ?? 2, mirror: true, waitingOnYou: !ended && link.waitingOnYou, ...(ended ? { ended: true } : {}) },
      status: !ended && link.waitingOnYou ? 'waiting' : 'idle',
      pinnedAt: m.pinnedAt,
      groupId: m.groupId,
      archivedAt: m.archivedAt,
      finishedUnseen: m.finishedUnseenAt !== null,
      createdAt: m.joinedAt,
      updatedAt: m.joinedAt,
    } as SessionSummary;
  }

  private changed(link: Link): void {
    if (link.membership.id) this.deps.emitToUser(link.membership.userId, 'sessions.changed', this.summary(link));
  }

  /** The person's mirrors for `sessions.list`: the ones they're in, and ended ones until they have a copy. */
  async list(userId: string): Promise<SessionSummary[]> {
    const rows = await this.deps.db.select().from(coopMemberships).where(eq(coopMemberships.userId, userId));
    return rows.filter((r) => r.endedAt === null || !r.copySessionId).map((r) => this.summary(this.links.get(r.id) ?? { ...this.blank(r, 'host', null), ended: r.endedAt !== null }));
  }

  /** Co-op ended for them (they left, were removed, or the host ended it): a copy if the host allows one. */
  /** `farewell`: what to tell the host once the copy is made, before the channel closes (their own leave). */
  private async end(link: Link, copy: boolean, reason?: 'declined' | 'removed' | 'ended', farewell?: () => Promise<unknown>): Promise<void> {
    if (link.ended) return;
    link.ended = true;
    for (const s of link.streams.values()) s.abort();
    let copySessionId: string | null = null;
    if (copy && reason !== 'declined') {
      // The latest of the conversation, fetched while the channel still stands.
      let snapshot = (await link.client?.call('coop.subscribe', {}).catch(() => null)) ?? link.snapshot;
      const missing = new Set<string>();
      // From this link itself: it is ended already, so the other lookups pass it by.
      if (snapshot) for (const sha of blobsOf(snapshot.messages)) if (!(await this.ownBlob(link.membership.userId, sha)) && !(await this.blobFrom(link, sha).catch(() => false))) missing.add(sha);
      // On a server a copy names only blobs its host sent (or the account's own): a message of the host's could name
      // any hash, and the copy would let them read another account's file.
      if (snapshot && this.deps.perAccount && missing.size) snapshot = { ...snapshot, messages: withoutBlobs(snapshot.messages, missing) };
      if (snapshot) copySessionId = await this.deps.saveCopy(link.membership.userId, snapshot, link.membership.title).catch(() => null);
    }
    await farewell?.();
    link.channel?.close();
    link.client?.close();
    if (link.membership.id) {
      await this.deps.db.update(coopMemberships).set({ endedAt: this.now(), copySessionId }).where(eq(coopMemberships.id, link.membership.id));
      link.membership = { ...link.membership, endedAt: this.now(), copySessionId };
      await this.deps.secrets.delete(link.membership.pskSecret).catch(() => undefined);
      if (reason === 'declined') {
        this.links.delete(link.membership.id);
        await this.deps.db.delete(coopMemberships).where(eq(coopMemberships.id, link.membership.id));
        this.deps.emitToUser(link.membership.userId, 'sessions.removed', { id: link.membership.id });
        return;
      }
      this.emit(link, { type: 'presence', participants: [] });
      if (copySessionId) this.deps.emitToUser(link.membership.userId, 'sessions.removed', { id: link.membership.id });
      else this.changed(link);
    }
  }

  /** Atelier quits: the channels close, the memberships stay to join again next time. */
  shutdown(): void {
    for (const link of this.links.values()) {
      link.channel?.close();
      link.client?.close();
    }
    this.links.clear();
  }

  /** The person removes an ended mirror from their sidebar. */
  async forget(userId: string, id: string): Promise<void> {
    const link = this.links.get(id);
    // Removing it from the sidebar keeps nothing: no copy appears in its place.
    if (link && !link.ended) await this.leave(userId, id, false);
    this.links.delete(id);
    await this.deps.db.delete(coopMemberships).where(and(eq(coopMemberships.id, id), eq(coopMemberships.userId, userId)));
    this.deps.emitToUser(userId, 'sessions.removed', { id });
  }

  /**
   * They leave: a copy first when the host lets guests keep one (the leave dialog promises it), then the host is told.
   * Someone still waiting to be let in has nothing to copy.
   */
  async leave(userId: string, id: string, keepCopy = true): Promise<void> {
    const link = this.mine(userId, id);
    const settings = keepCopy && link.admitted && link.connected ? ((await link.client?.call('coop.state', {}).catch(() => null)) ?? link.state)?.settings : link.state?.settings;
    await this.end(link, keepCopy && link.admitted && !!settings?.guestsKeepCopy, undefined, async () => link.client?.call('coop.leave', {}).catch(() => undefined));
  }

  private mine(userId: string, id: string): Link {
    const link = this.links.get(id);
    if (!link || link.membership.userId !== userId) throw appError('not_found', 'That session isn’t here.');
    return link;
  }

  private live(userId: string, id: string): RpcClient<typeof CoopContract> {
    const link = this.mine(userId, id);
    if (link.ended) throw appError('not_found', 'Co-op ended for this session.');
    if (!link.client || !link.connected) throw appError('host_away', `${link.membership.hostName}’s computer isn’t connected right now. It goes on when they’re back.`);
    if (!link.admitted) throw appError('forbidden', `Waiting for ${link.membership.hostName} to let you in.`);
    return link.client;
  }

  /** Whether `sessionId` is one of this person's mirrors, or a sub-agent's or track's session in one. */
  owns(userId: string, sessionId: string): boolean {
    if (isCoopMirror(sessionId)) return this.links.get(sessionId)?.membership.userId === userId;
    return this.parentOf(userId, sessionId) !== null;
  }

  /** The mirror whose host session has `childId` among its sub-agents' and tracks' sessions. */
  private parentOf(userId: string, childId: string): Link | null {
    for (const link of this.links.values()) if (link.membership.userId === userId && !link.ended && link.children.has(childId)) return link;
    return null;
  }

  /** A sub-agent's or track's transcript: read-only, from the host, while the window has it open. */
  private async childCall(userId: string, link: Link, childId: string, method: string, watching: boolean): Promise<unknown> {
    switch (method) {
      case 'sessions.subscribe': {
        const snapshot = await this.live(userId, link.membership.id).call('coop.subscribeChild', { sessionId: childId });
        link.watchedChildren.add(childId);
        this.learn(link, snapshot);
        return snapshot;
      }
      case 'sessions.unsubscribe':
      case 'sessions.leave':
        if (!watching) {
          link.watchedChildren.delete(childId);
          await link.client?.call('coop.unsubscribeChild', { sessionId: childId }).catch(() => undefined);
        }
        return method === 'sessions.leave' ? { deleted: false } : { ok: true };
      case 'sessions.markSeen':
        return { ok: true };
      case 'artifacts.list':
      case 'checkpoints.list':
        return [];
      default:
        throw appError('unsupported', 'A sub-agent’s transcript in a session you joined is only for reading.');
    }
  }

  /**
   * An app call for a mirror, as the backend's handlers receive it: forwarded to the host when it is one a guest may
   * make there, refused otherwise. `watching` says whether another window here still has the session open.
   */
  async call(userId: string, method: string, input: Record<string, unknown>, watching = false): Promise<unknown> {
    const id = String(input.sessionId ?? input.id ?? '');
    if (!isCoopMirror(id)) {
      const parent = this.parentOf(userId, id);
      if (!parent) throw appError('not_found', 'That session isn’t here.');
      return this.childCall(userId, parent, id, method, watching);
    }
    const link = this.mine(userId, id);
    switch (method) {
      case 'sessions.subscribe': {
        link.watched = true;
        if (link.ended || !link.client || !link.connected || !link.admitted) return this.offlineSnapshot(link);
        const snapshot = await link.client.call('coop.subscribe', {});
        link.snapshot = snapshot;
        this.learn(link, snapshot);
        this.noteWaiting(link, snapshot.pending ?? null);
        return { ...snapshot, session: { ...this.summary(link), title: link.membership.localTitle ?? snapshot.session.title, mode: snapshot.session.mode, model: snapshot.session.model, effort: snapshot.session.effort, status: snapshot.session.status } };
      }
      case 'sessions.unsubscribe':
      case 'sessions.leave':
        if (!watching) {
          link.watched = false;
          await link.client?.call('coop.unsubscribe', {}).catch(() => undefined);
        }
        return method === 'sessions.leave' ? { deleted: false } : { ok: true };
      case 'sessions.markSeen':
        if (link.membership.finishedUnseenAt !== null) await this.updateView(userId, link, { unread: false });
        return { ok: true };
      case 'sessions.update':
        return this.updateView(userId, link, input);
      case 'sessions.delete':
        await this.forget(userId, id);
        return { ok: true };
      case 'artifacts.list':
        return link.ended || !link.connected ? [] : this.live(userId, id).call('artifacts.list', {});
      case 'tasks.output':
        return this.live(userId, id).call('tasks.output', { taskId: String(input.taskId), since: Number(input.since) || 0 });
      case 'checkpoints.list':
        return [];
      case 'coop.state': {
        if (link.ended) return link.state ? here({ ...link.state, ended: true, lending: link.lend }) : null;
        if (!link.client || !link.connected || !link.admitted) return link.state ? here({ ...link.state, hostAway: !link.connected, lending: link.lend }) : null;
        const state = await link.client.call('coop.state', {});
        link.state = state;
        return state ? here({ ...state, lending: link.lend }) : state;
      }
      case 'coop.models': {
        const models = input.models as ModelsChoice;
        const model = (input.model as string | null) ?? null;
        const state = await this.live(userId, id).call('coop.models', { models, model });
        link.models = models;
        link.model = models === 'own' ? model : null;
        link.state = state;
        return here(state);
      }
      case 'coop.lend': {
        link.lend = !!input.lend;
        return { ok: true };
      }
      case 'coop.typing':
        return this.live(userId, id).call('coop.typing', {});
      case 'coop.leave':
        await this.leave(userId, id);
        return { ok: true };
      case 'chat.send':
        this.askedFor(link, input.answerWith);
        // No parent named: after the host's latest message, as for anyone's send (null would start a new branch).
        return this.live(userId, id).call('chat.send', { ...(input.parentId !== undefined ? { parentId: input.parentId as string | null } : {}), parts: input.parts as never, ...(typeof input.answerWith === 'string' ? { answerWith: input.answerWith } : {}) });
      case 'chat.queue':
        this.askedFor(link, input.answerWith);
        return this.live(userId, id).call('chat.queue', { parts: input.parts as never, ...(input.joinTurn ? { joinTurn: true } : {}), ...(typeof input.answerWith === 'string' ? { answerWith: input.answerWith } : {}) });
      case 'chat.secondOpinion': {
        // Their own model answers on their computer: it must be the one the host may call for them.
        this.askedFor(link, input.model);
        return this.live(userId, id).call('chat.secondOpinion', { messageId: String(input.messageId), model: String(input.model) });
      }
      case 'chat.react':
        return this.live(userId, id).call('chat.react', { messageId: String(input.messageId), emoji: String(input.emoji), on: !!input.on });
      case 'coop.track': {
        const track = await this.live(userId, id).call('coop.track', { task: String(input.task) });
        link.children.add(track.id);
        return track;
      }
      case 'coop.tracks': {
        if (link.ended || !link.connected) return [];
        const tracks = await this.live(userId, id).call('coop.tracks', {});
        for (const t of tracks) link.children.add(t.id);
        return tracks;
      }
      case 'coop.trackDiff':
        return this.live(userId, id).call('coop.trackDiff', { trackId: String(input.trackId) });
      case 'coop.navigate': {
        const state = await this.live(userId, id).call('coop.navigate', { on: !!input.on });
        link.state = state;
        return here(state);
      }
      case 'chat.unqueue':
        return this.live(userId, id).call('chat.unqueue', { id: String(input.id) });
      case 'chat.sendNow':
        return this.live(userId, id).call('chat.sendNow', { id: String(input.id) });
      case 'chat.stop':
        return this.live(userId, id).call('chat.stop', {});
      case 'chat.retry':
        return this.live(userId, id).call('chat.retry', { messageId: String(input.messageId) });
      case 'chat.continue':
        return this.live(userId, id).call('chat.continue', {});
      case 'chat.edit':
        return this.live(userId, id).call('chat.edit', { messageId: String(input.messageId), parts: input.parts as never });
      case 'chat.respond': {
        const interactionId = String(input.interactionId);
        const answer = input.answer as never as { behavior?: string };
        const result = await this.live(userId, id).call('chat.respond', { interactionId, answer: answer as never });
        // A connector call of theirs they allowed: it may run once.
        const asked = link.asked.get(interactionId);
        if (asked && answer.behavior === 'allow') link.allowed.set(asked, (link.allowed.get(asked) ?? 0) + 1);
        link.asked.delete(interactionId);
        return result;
      }
      case 'chat.contextBreakdown':
        return this.live(userId, id).call('chat.contextBreakdown', {});
      case 'chat.changePreview':
        return this.live(userId, id).call('chat.changePreview', { interactionId: String(input.interactionId) });
      case 'chat.editPreview':
        return this.live(userId, id).call('chat.editPreview', { callId: String(input.callId) });
      case 'workspaces.diff':
        return this.live(userId, id).call('session.diff', { ...(typeof input.path === 'string' ? { path: input.path } : {}) });
      case 'files.upload': {
        const ref = await this.live(userId, id).call('files.upload', { name: String(input.name), mime: String(input.mime), dataBase64: String(input.dataBase64) });
        return ref as FileRef;
      }
      default:
        throw appError('unsupported', 'That isn’t available in a session you joined.');
    }
  }

  /**
   * How the person files a mirror in their own sidebar: their name for it, pinned, group, archived, unread. The host's
   * session doesn't change, and anything else a session has is the host's.
   */
  private async updateView(userId: string, link: Link, input: Record<string, unknown>): Promise<SessionSummary> {
    const { id: _id, title, pinned, groupId, archived, unread, ...rest } = input;
    if (Object.values(rest).some((v) => v !== undefined)) throw appError('forbidden', `Only ${link.membership.hostName} can change that.`);
    if (typeof groupId === 'string' && !(await this.deps.ownsGroup(userId, groupId))) throw appError('not_found', 'Group not found.');
    const now = this.now();
    const patch: Partial<Membership> = {
      ...(typeof title === 'string' ? { localTitle: title.trim() || null } : {}),
      ...(typeof pinned === 'boolean' ? { pinnedAt: pinned ? now : null } : {}),
      ...(groupId === null || typeof groupId === 'string' ? { groupId } : {}),
      ...(typeof archived === 'boolean' ? { archivedAt: archived ? now : null } : {}),
      ...(typeof unread === 'boolean' ? { finishedUnseenAt: unread ? now : null } : {}),
    };
    if (Object.keys(patch).length) {
      await this.deps.db.update(coopMemberships).set(patch).where(eq(coopMemberships.id, link.membership.id));
      link.membership = { ...link.membership, ...patch };
      this.changed(link);
    }
    return this.summary(link);
  }

  /** A model of their own they named for an answer: the host may run it for them from now on. */
  private askedFor(link: Link, value: unknown): void {
    const chosen = typeof value === 'string' ? parseAnswerWith(value) : null;
    if (chosen?.source === 'own') link.secondary.add(chosen.ref);
  }

  /** What a window shows while the host is away or it ended: the last snapshot, or an empty one. */
  private offlineSnapshot(link: Link): SessionSnapshot {
    const base = link.snapshot;
    const session = this.summary(link);
    if (base) return { ...base, session: { ...session, title: link.membership.localTitle ?? base.session.title }, streamingMessageId: null, pending: null, queued: null, phase: null };
    return { session, messages: [], siblings: {}, streamingMessageId: null, pending: null, todos: [], tasks: [], toolOutput: {}, context: null, compacting: false, queued: null, phase: null, outbox: [], seq: 0 } as unknown as SessionSnapshot;
  }

  /**
   * A blob a mirror's message refers to, fetched from the hosts this person is connected to (the host checks it). On a
   * server a blob that is here already counts only when it is the account's own: otherwise their host must send it, and
   * then it is theirs to read (`grant`).
   */
  async fetchBlob(userId: string | null, sha256: string): Promise<boolean> {
    if (await this.ownBlob(userId, sha256)) return true;
    if (this.deps.perAccount && userId === null) return false;
    for (const link of this.links.values()) {
      if ((userId !== null && link.membership.userId !== userId) || link.ended || !link.client || !link.connected || !link.admitted) continue;
      if (await this.blobFrom(link, sha256)) return true;
    }
    return false;
  }

  /** The blob is here and theirs to see: any blob here on a desktop, one of the account's own on a server. */
  private async ownBlob(userId: string | null, sha256: string): Promise<boolean> {
    if (!(await this.deps.hasBlob(sha256))) return false;
    if (!this.deps.perAccount || !this.deps.canRead) return true;
    return userId !== null && (await this.deps.canRead(userId, sha256));
  }

  /** Asks one host for a blob of its session, checks it against its hash, keeps it, and lets the account read it. */
  private async blobFrom(link: Link, sha256: string): Promise<boolean> {
    if (!link.client) return false;
    const got = await link.client.call('blob.get', { sha256 }).catch(() => null);
    if (!got) return false;
    const bytes = new Uint8Array(Buffer.from(got.dataBase64, 'base64'));
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) return false;
    await this.deps.putBlob(bytes, got.mime);
    this.deps.grant?.(link.membership.userId, sha256);
    return true;
  }

  /** Whether the account has a mirror whose host may send it blobs right now (a window asks for one of its images). */
  connectedFor(userId: string): boolean {
    for (const link of this.links.values()) if (link.membership.userId === userId && !link.ended && link.client && link.connected && link.admitted) return true;
    return false;
  }

  /** What the host may ask of this computer: the person's own chosen model, and connectors they lend, nothing else. */
  private peerHandlers(link: Link, streamed: (payload: { streamId: string; event: unknown }) => void): Handlers<typeof PeerContract, object> {
    const { userId } = link.membership;
    const chosen = (ref: string) => {
      if (link.ended || !link.admitted) throw appError('forbidden', 'Not in that session.');
      if (!(link.models === 'own' && link.model && ref === link.model) && !link.secondary.has(ref)) throw appError('forbidden', 'That isn’t a model they answer with.');
    };
    return {
      'model.describe': async ({ ref }) => {
        chosen(ref);
        return (await this.deps.models.resolve(ref, userId)).info;
      },
      'model.stream': async ({ streamId, request }, ctx) => {
        chosen(request.model);
        if (link.streams.size >= MAX_STREAMS) throw appError('rate_limited', 'Their model is busy with other requests of this session.');
        const refused = await this.deps.limit(userId);
        if (refused) throw appError('limit_reached', refused);
        const { adapter, info } = await this.deps.models.resolve(request.model, userId);
        // Images and documents the request shows, from the host, checked against their hash. On a server one the host
        // can't send is refused rather than read here: it may be another account's.
        for (const sha of blobsOf(request.messages)) if (!(await this.fetchBlob(userId, sha)) && this.deps.perAccount) throw appError('forbidden', 'That file isn’t part of this session.');
        const controller = new AbortController();
        ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });
        link.streams.set(streamId, controller);
        const messages = (request.messages as Message[]).map((m) =>
          m.role !== 'assistant' ? m : { ...m, parts: m.parts.map((p) => (p.type === 'thinking' && p.provider === PEER_SELF ? { ...p, provider: adapter.type } : p)) },
        ) as Message[];
        const server = (event: StreamEvent) => streamed({ streamId, event });
        try {
          // The host names the model by its ref here (`chatgpt/gpt-6.1`); the provider wants its own id (`gpt-6.1`).
          for await (const event of adapter.stream({ ...request, model: info.modelId, effort: (request.effort ?? undefined) as never, messages, signal: controller.signal })) {
            if (event.type === 'usage') this.deps.recordUsage({ userId, sessionId: link.membership.id, model: info, usage: event.usage, mode: link.membership.mode });
            server(event);
            if (event.type === 'finish') break;
          }
        } finally {
          link.streams.delete(streamId);
        }
        return { ok: true as const };
      },
      'model.cancel': async ({ streamId }) => {
        link.streams.get(streamId)?.abort();
        return { ok: true as const };
      },
      'mcp.list': async () => {
        if (!link.lend || link.ended || !link.admitted) return [];
        return (await this.deps.connectorTools(userId)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, readOnly: t.readOnly }));
      },
      'mcp.call': async ({ name, input }, ctx) => {
        if (!link.lend || link.ended || !link.admitted) throw appError('forbidden', 'They don’t lend their connectors.');
        // Every call of theirs is one they allowed in the session, read-only ones too: their accounts, their say.
        const key = callKey(name, input);
        const left = link.allowed.get(key) ?? 0;
        if (left < 1) throw appError('forbidden', 'They haven’t allowed this call.');
        if (left === 1) link.allowed.delete(key);
        else link.allowed.set(key, left - 1);
        const tool = (await this.deps.connectorTools(userId)).find((t) => t.name === name);
        if (!tool) throw appError('not_found', 'That connector tool isn’t there anymore.');
        return tool.call(input, ctx.signal);
      },
    };
  }
}

/**
 * The guest's own model as their app knows it: the host keeps it as `peer-<key>/<ref>` (it runs on the guest's computer),
 * and the app looked for a model by that name among its own, found none and said "no model chosen".
 */
export function ownModelHere<P extends { id: string; model: string | null }>(participants: readonly P[], me: string): P[] {
  return participants.map((p) => (p.id === me && p.model ? { ...p, model: parsePeerModelRef(p.model)?.ref ?? p.model } : p));
}

function here<S extends { me: string; participants: { id: string; model: string | null }[] } | null>(state: S): S {
  return state ? { ...state, participants: ownModelHere(state.participants, state.me) } : state;
}
