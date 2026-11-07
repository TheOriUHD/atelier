/**
 * Co-op between computers, the host's side (ARCHITECTURE §24). A session's room lives on the relay; this backend dials
 * out to it, and each guest who knows the invite's secret completes an encrypted handshake with it there. The host lets
 * a new guest in after seeing their name and the fingerprint both sides compute; a guest who was let in before (their
 * device key pinned on their participant row) comes back without asking.
 *
 * A guest never reaches the host's app contract: they get `CoopContract`, narrow and checked against their part in
 * this one session (coop/rules.ts), and nothing else of this computer. The screen lock and the host's windows have
 * nothing to do with it; the host's approvals simply wait, and time out (chat-service.ts).
 */
import { createHash } from 'node:crypto';
import {
  CoopContract,
  PeerContract,
  createRpcClient,
  answerWithValue,
  makeInviteUrl,
  parseAnswerWith,
  peerModelRef,
  peerParticipant,
  serveRpc,
  appError,
  type ArtifactSummary,
  type CoopHello,
  type CoopTrack,
  type ContextUsage,
  type Handlers,
  type Part,
  type RpcClient,
  type RpcServerConnection,
  type RunEvent,
  type SessionUsage,
} from '@atelier/protocol';
import type { ChatService } from '../agent/chat-service.ts';
import type { SessionRow } from '../sessions/session-repo.ts';
import { lanes, type JsonChannel } from './lanes.ts';
import type { CoopRelayPort, CoopService, ParticipantInfo } from './service.ts';

/** A guest's channel once their handshake is done (channel.ts `PeerChannel`). */
export interface PeerChannelPort extends JsonChannel {
  /** Which of the room's keys their handshake used (`HostRoomPort.setSecrets`' order). */
  pskIndex?: number;
  /** Their device's static key, base64. */
  remoteKey: string;
  fingerprint: string[];
  close(): void;
}

export interface HostRoomPort {
  onPeer(handler: (peer: PeerChannelPort) => void): void;
  /** The secrets whose keys new handshakes may use: the live invite's and each member's. Sessions up stay up. */
  setSecrets(secrets: string[]): void;
  onRelayState(handler: (state: 'connected' | 'reconnecting' | 'closed') => void): void;
  close(): Promise<void>;
}

/** The transport (channel.ts and invite.ts), behind a port so the host can be tested without a relay. */
export interface CoopTransportPort {
  createRoom(relayUrl: string): Promise<{ roomId: string; hostToken: string }>;
  openHostRoom(opts: { relayUrl: string; roomId: string; hostToken: string; secrets: string[] }): Promise<HostRoomPort>;
  deleteRoom(relayUrl: string, roomId: string, hostToken: string): Promise<void>;
  /** A fresh invite secret (32 random bytes, base64url). */
  newSecret(): string;
}

/** What a guest's calls do in the session: the chat service's methods, the backend's views. */
export interface CoopHostDeps {
  coop: CoopService;
  transport: CoopTransportPort;
  relayUrl(): string | null;
  sessionRow(id: string): Promise<SessionRow | null>;
  hostName(userId: string): Promise<string>;
  secrets: { get(id: string): Promise<string | null | undefined>; set(id: string, value: string): Promise<void>; delete(id: string): Promise<void> };
  chat: Pick<ChatService, 'send' | 'queue' | 'secondOpinion' | 'react' | 'unqueue' | 'sendNow' | 'stop' | 'retry' | 'continue' | 'edit' | 'respond' | 'mayRespond' | 'snapshot' | 'changePreview' | 'editPreview' | 'forgetParticipant'>;
  contextBreakdown(sessionId: string): Promise<{ context: ContextUsage | null; usage: SessionUsage }>;
  sessionDiff(sessionId: string, path?: string): Promise<{ diff: string; truncated: boolean; base: string | null }>;
  artifacts(sessionId: string): Promise<ArtifactSummary[]>;
  /** A blob this session refers to, or null. */
  blob(sessionId: string, sha256: string): Promise<{ mime: string; bytes: Uint8Array } | null>;
  /** Stores a guest's attachment for the session (owned by the host's account, kept with the session). */
  upload(sessionId: string, file: { name: string; mime: string; bytes: Uint8Array }): Promise<{ id: string; name: string; mime: string; size: number; blob: string; kind: string; tokens: number | null; createdAt: number }>;
  /** Blobs referenced by a message a guest sends must be ones the session already has or they uploaded. */
  sessionHasBlob(sessionId: string, sha256: string): Promise<boolean>;
  /** Parallel tracks (backend.ts `coopTracks`), absent where the session's folder has none. */
  tracks?: {
    start(sessionId: string, task: string, by: ParticipantInfo): Promise<CoopTrack>;
    list(sessionId: string): Promise<CoopTrack[]>;
    diff(sessionId: string, trackId: string): Promise<{ diff: string; truncated: boolean; base: string | null }>;
  };
  /** The sessions with a room open: the computer stays awake for them. */
  keepAwake(sessionIds: string[]): void;
  /** The host's windows should read the co-op state again (someone knocked, came, went). */
  stateChanged(sessionId: string): void;
  log(message: string, error?: unknown): void;
  now?(): number;
}

/** How long an invite lets new people knock (someone let in before comes back whenever). */
const INVITE_TTL_MS = 24 * 3600_000;
/** At most four people in a co-op session, the host included. */
const MAX_PEOPLE = 4;
/** What one guest may store on the host's computer in a day: files and bytes (attachments). */
const UPLOADS_PER_DAY = 100;
const UPLOAD_BYTES_PER_DAY = 200 * 1024 * 1024;
/** The most one message of a guest's may hold, as JSON (its files are uploads, counted above). */
const MAX_MESSAGE_JSON = 1_000_000;

interface Knock {
  id: string;
  peer: PeerChannelPort;
  hello: CoopHello;
  keyId: string;
  admit(): void;
  decline(): void;
}

interface Guest {
  participantId: string;
  keyId: string;
  channel: PeerChannelPort;
  /** The guest's computer, for their own models and connectors. */
  peer: RpcClient<typeof PeerContract>;
  server: RpcServerConnection<typeof CoopContract>;
  admitted: boolean;
  subscribed: boolean;
  /** Today's uploads: the UTC day, how many, how many bytes. */
  uploads?: { day: string; files: number; bytes: number };
  /** Co-op ended: who they were, for the copy they may still fetch before their channel closes. */
  farewell?: ParticipantInfo;
}

interface Room {
  sessionId: string;
  roomId: string;
  room: HostRoomPort;
  /** The live invite's secret: new people may knock with it until `inviteUntil`. */
  secret: string;
  inviteUntil: number;
  /** Each admitted guest's own secret, by participant id: how they come back once the invite is gone. */
  members: Map<string, string>;
  /** Withdraws the invite's key when it lapses. */
  lapse?: ReturnType<typeof setTimeout>;
  inviteUrl: string | null;
  knocks: Map<string, Knock>;
  guests: Map<string, Guest>;
}

/** Where a guest's own secret for a room is kept in the host's secret store. */
const memberSecretId = (sessionId: string, participantId: string): string => `coop-member-${sessionId}-${participantId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** A short id for a device key: what its participant id carries. */
export const keyIdOf = (staticKey: string): string => createHash('sha256').update(staticKey).digest('base64url').slice(0, 16);

export class CoopHost {
  private readonly rooms = new Map<string, Room>();
  /** After `shutdown`: channels that close late (the relay tells them a moment after) change nothing. */
  private stopped = false;

  constructor(private readonly deps: CoopHostDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** What the co-op service shows of the relay side (CoopState's invite, knocking, presence). */
  get port(): CoopRelayPort {
    return {
      invite: (sessionId) => {
        const r = this.rooms.get(sessionId);
        return r?.inviteUrl && r.inviteUntil > this.now() ? { url: r.inviteUrl, expiresAt: r.inviteUntil } : null;
      },
      knocking: (sessionId) => [...(this.rooms.get(sessionId)?.knocks.values() ?? [])].map((k) => ({ id: k.id, name: k.hello.name, fingerprint: k.peer.fingerprint })),
      peerOnline: (sessionId, participantId) => !!this.rooms.get(sessionId)?.guests.get(participantId)?.admitted,
    };
  }

  /** Turns co-op on for a session across computers: a room on the relay, or the one it had (after a restart). */
  async open(sessionId: string): Promise<void> {
    if (this.rooms.has(sessionId)) return;
    const relayUrl = this.deps.relayUrl();
    if (!relayUrl) throw appError('unsupported', 'Co-op between computers is switched off on this computer.');
    const known = await this.deps.coop.room(sessionId);
    let roomId = known?.roomId ?? null;
    let hostToken = known?.hostTokenSecret ? await this.deps.secrets.get(known.hostTokenSecret) : null;
    let secret = known?.inviteSecret ? await this.deps.secrets.get(known.inviteSecret) : null;
    if (!roomId || !hostToken || !secret) {
      const created = await this.deps.transport.createRoom(relayUrl);
      roomId = created.roomId;
      hostToken = created.hostToken;
      secret = this.deps.transport.newSecret();
      await this.deps.secrets.set(`coop-host-${sessionId}`, hostToken);
      await this.deps.secrets.set(`coop-invite-${sessionId}`, secret);
      await this.deps.coop.start(sessionId, { relayUrl, roomId, hostTokenSecret: `coop-host-${sessionId}` });
      await this.deps.coop.setRoom(sessionId, { inviteSecret: `coop-invite-${sessionId}`, inviteExpiresAt: this.now() + INVITE_TTL_MS });
    }
    // The guests let in before come back with their own secrets.
    const members = new Map<string, string>();
    for (const p of await this.deps.coop.participants.list(sessionId)) {
      if (p.kind !== 'peer') continue;
      const member = await this.deps.secrets.get(memberSecretId(sessionId, p.id));
      if (member) members.set(p.id, member);
    }
    const inviteUntil = (await this.deps.coop.room(sessionId))?.inviteExpiresAt ?? 0;
    const r: Room = { sessionId, roomId, room: null as unknown as HostRoomPort, secret, inviteUntil, members, inviteUrl: null, knocks: new Map(), guests: new Map() };
    r.room = await this.deps.transport.openHostRoom({ relayUrl, roomId, hostToken, secrets: this.secretsOf(r) });
    const room = r.room;
    this.rooms.set(sessionId, r);
    this.scheduleLapse(r);
    room.onPeer((peer) => this.arrive(r, peer));
    room.onRelayState((state) => {
      if (state === 'closed') this.deps.log(`co-op room of ${sessionId} closed by the relay`);
    });
    this.awake();
  }

  /** Opens the rooms of the sessions that had co-op on when this backend stopped. */
  async resume(sessionIds: string[]): Promise<void> {
    for (const id of sessionIds) await this.open(id).catch((e: unknown) => this.deps.log(`couldn't open the co-op room of ${id}`, e));
  }

  /** The invite link: valid for new people for 24 hours from now. */
  async invite(sessionId: string): Promise<{ url: string; expiresAt: number }> {
    await this.open(sessionId);
    const r = this.rooms.get(sessionId)!;
    // Each link is new: the one before stops working, and nobody it reached can knock any more.
    r.secret = this.deps.transport.newSecret();
    await this.deps.secrets.set(`coop-invite-${sessionId}`, r.secret);
    r.inviteUntil = this.now() + INVITE_TTL_MS;
    await this.deps.coop.setRoom(sessionId, { inviteSecret: `coop-invite-${sessionId}`, inviteExpiresAt: r.inviteUntil });
    r.room.setSecrets(this.secretsOf(r));
    this.scheduleLapse(r);
    const row = await this.deps.sessionRow(sessionId);
    const hostName = row?.userId ? await this.deps.hostName(row.userId) : 'Someone';
    r.inviteUrl = makeInviteUrl(r.roomId, r.secret, { hostName, title: row?.title || 'Untitled', mode: (row?.mode ?? 'chat') as 'chat' | 'work' | 'code' });
    this.deps.stateChanged(sessionId);
    return { url: r.inviteUrl, expiresAt: r.inviteUntil };
  }

  async admit(sessionId: string, knockId: string, allow: boolean): Promise<void> {
    const knock = this.rooms.get(sessionId)?.knocks.get(knockId);
    if (!knock) throw appError('not_found', 'They’re no longer waiting.');
    if (allow && (await this.deps.coop.list(sessionId)).length >= MAX_PEOPLE) throw appError('invalid_request', 'A co-op session has room for four people in all.');
    if (allow) knock.admit();
    else knock.decline();
  }

  /** Co-op ended: everyone is told and let go, and the room is deleted on the relay. */
  async close(sessionId: string): Promise<void> {
    const r = this.rooms.get(sessionId);
    if (!r) return;
    const copy = (await this.deps.coop.settings(sessionId)).guestsKeepCopy;
    const room = await this.deps.coop.room(sessionId);
    const relayUrl = this.deps.relayUrl();
    const token = room?.hostTokenSecret ? await this.deps.secrets.get(room.hostTokenSecret) : null;
    for (const g of r.guests.values()) {
      g.farewell = (await this.deps.coop.participant(sessionId, g.participantId)) ?? undefined;
      g.server.emit('gone', { reason: 'ended', copy });
    }
    for (const k of r.knocks.values()) k.peer.close();
    if (r.lapse) clearTimeout(r.lapse);
    this.rooms.delete(sessionId);
    this.awake();
    for (const id of r.members.keys()) await this.deps.secrets.delete(memberSecretId(sessionId, id)).catch(() => undefined);
    // A few seconds for the guests to fetch their copy, then the room is gone from the relay.
    setTimeout(() => {
      for (const g of r.guests.values()) g.channel.close();
      void r.room.close().catch(() => undefined);
      if (relayUrl && token) void this.deps.transport.deleteRoom(relayUrl, r.roomId, token).catch(() => undefined);
    }, 5000).unref?.();
    await this.deps.secrets.delete(`coop-host-${sessionId}`).catch(() => undefined);
    await this.deps.secrets.delete(`coop-invite-${sessionId}`).catch(() => undefined);
  }

  /** Atelier quits: the links to the relay close, the rooms stay (guests see the host away until it is back). */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const r of this.rooms.values()) {
      if (r.lapse) clearTimeout(r.lapse);
      await r.room.close().catch(() => undefined);
    }
    this.rooms.clear();
  }

  /** The host removed a guest: their channel closes. */
  removed(sessionId: string, participantId: string): void {
    const r = this.rooms.get(sessionId);
    // Their own secret goes: their device can't even start a handshake with the room any more.
    if (r?.members.delete(participantId)) {
      r.room.setSecrets(this.secretsOf(r));
      void this.deps.secrets.delete(memberSecretId(sessionId, participantId)).catch(() => undefined);
    }
    const g = r?.guests.get(participantId);
    if (!g) return;
    g.server.emit('gone', { reason: 'removed', copy: false });
    this.rooms.get(sessionId)!.guests.delete(participantId);
    setTimeout(() => g.channel.close(), 1000);
  }

  /** A run event of a session with a room: to the guests who follow it. */
  forward(sessionId: string, seq: number, event: RunEvent): void {
    const r = this.rooms.get(sessionId);
    if (!r) return;
    for (const g of r.guests.values()) if (g.admitted && g.subscribed) g.server.emit('session.event', { seq, event });
  }

  /** The guest's computer for their own models and connectors, while they are connected (PeerModelAdapter). */
  peerOf(keyId: string): RpcClient<typeof PeerContract> | null {
    for (const r of this.rooms.values()) for (const g of r.guests.values()) if (g.keyId === keyId && g.admitted) return g.peer;
    return null;
  }

  /** The keys new handshakes may use: the invite's while it lasts, then each member's. */
  private secretsOf(r: Room): string[] {
    return [...(r.inviteUntil > this.now() ? [r.secret] : []), ...r.members.values()];
  }

  /** When the invite lapses, its key goes; members still come back. */
  private scheduleLapse(r: Room): void {
    if (r.lapse) clearTimeout(r.lapse);
    const wait = r.inviteUntil - this.now();
    if (wait <= 0) return;
    r.lapse = setTimeout(() => r.room.setSecrets(this.secretsOf(r)), Math.min(wait + 1000, 2 ** 31 - 1));
    r.lapse.unref?.();
  }

  private awake(): void {
    this.deps.keepAwake([...this.rooms.keys()]);
  }

  /** Someone finished the handshake: serve them CoopContract, and let them in or have them knock. */
  private arrive(r: Room, channel: PeerChannelPort): void {
    const keyId = keyIdOf(channel.remoteKey);
    const participantId = peerParticipant(keyId);
    const { coop: coopLane, peer: peerLane } = lanes(channel);
    const peer = createRpcClient(PeerContract, peerLane);
    let guest: Guest | null = null;
    const sessionId = r.sessionId;

    const self = async (): Promise<ParticipantInfo> => {
      if (!guest?.admitted) throw appError('forbidden', 'The host hasn’t let you in yet.');
      if (guest.farewell) return guest.farewell;
      const p = await this.deps.coop.participant(sessionId, participantId);
      if (!p) throw appError('not_found', 'You’re no longer in this session.');
      return p;
    };
    const editor = async (): Promise<ParticipantInfo> => {
      const p = await self();
      if (guest?.farewell) throw appError('forbidden', 'Co-op ended for this session.');
      if (p.role === 'viewer') throw appError('forbidden', 'You’re watching this session.');
      return p;
    };
    const sized = (parts: Part[]) => {
      if (JSON.stringify(parts).length > MAX_MESSAGE_JSON) throw appError('invalid_request', 'That message is too long: attach long text as a file instead.');
    };
    const ownBlobs = async (parts: Part[]) => {
      sized(parts);
      for (const p of parts) if ((p.type === 'image' || p.type === 'document') && !(await this.deps.sessionHasBlob(sessionId, p.blob))) throw appError('forbidden', 'Attach files through the session.');
    };
    const refusals = async <T>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (e) {
        if (e instanceof Error && /^Only (its author|your own)/.test(e.message)) throw appError('forbidden', e.message);
        if (e instanceof Error && /^(That isn’t a model|That model is a guest|The host doesn’t share|The host hasn’t agreed|That emoji isn’t|Ask for a second opinion|Message not found|You have \d+ messages waiting)/.test(e.message)) throw appError('invalid_request', e.message);
        throw e;
      }
    };
    // A model of their own is a ref on their computer: here it runs through them (peer-model.ts).
    const theirs = (value: string | undefined): string | undefined => {
      const chosen = parseAnswerWith(value);
      return chosen?.source === 'own' ? answerWithValue({ source: 'own', ref: peerModelRef(keyId, chosen.ref) }) : value;
    };

    const handlers: Handlers<typeof CoopContract, object> = {
      'coop.hello': async (hello) => {
        if (guest || r.knocks.get(keyId)?.peer === channel) throw appError('invalid_request', 'Already said hello.');
        const row = await this.deps.sessionRow(sessionId);
        if (!row) throw appError('not_found', 'That session is gone.');
        const hostName = row.userId ? await this.deps.hostName(row.userId) : 'The host';
        const base = { participantId, hostName, sessionId, title: row.title, mode: row.mode as 'chat' | 'work' | 'code', fingerprint: channel.fingerprint };
        // Someone let in before (their device key on a participant row still in the session) comes back without asking.
        const known = await this.deps.coop.participants.get(sessionId, participantId);
        if (known && known.leftAt === null && known.peerKey === channel.remoteKey) {
          guest = { participantId, keyId, channel, peer, server, admitted: true, subscribed: false };
          r.guests.set(participantId, guest);
          await this.deps.coop.participants.update(sessionId, participantId, { name: hello.name, avatar: hello.avatar });
          await this.deps.coop.presence(sessionId);
          return { admitted: true, ...base, ...(r.members.get(participantId) ? { memberSecret: r.members.get(participantId)! } : {}) };
        }
        if (r.inviteUntil <= this.now()) throw appError('forbidden', 'This invite has expired: ask the host for a new link.');
        const id = keyId;
        const knock: Knock = {
          id,
          peer: channel,
          hello,
          keyId,
          admit: () => {
            void (async () => {
              if ((await this.deps.coop.list(sessionId)).length >= MAX_PEOPLE) throw appError('invalid_request', 'A co-op session has room for four people in all.');
              const settings = await this.deps.coop.settings(sessionId);
              const models = hello.models === 'own' && hello.model ? 'own' : settings.shareModels ? 'host' : 'own';
              await this.deps.coop.addPeer(sessionId, { id: participantId, peerKey: channel.remoteKey, name: hello.name, avatar: hello.avatar, models });
              // Their own way back in, once the invite is gone: a secret only they and this computer hold.
              const member = this.deps.transport.newSecret();
              await this.deps.secrets.set(memberSecretId(sessionId, participantId), member);
              r.members.set(participantId, member);
              r.room.setSecrets(this.secretsOf(r));
              if (models === 'own' && hello.model) await this.deps.coop.participants.update(sessionId, participantId, { model: `peer-${keyId}/${hello.model}` });
              r.knocks.delete(id);
              guest = { participantId, keyId, channel, peer, server, admitted: true, subscribed: false };
              r.guests.set(participantId, guest);
              server.emit('admitted', { participantId, memberSecret: member });
              await this.deps.coop.presence(sessionId);
              this.deps.stateChanged(sessionId);
            })().catch((e: unknown) => this.deps.log('admitting a guest failed', e));
          },
          decline: () => {
            r.knocks.delete(id);
            server.emit('gone', { reason: 'declined', copy: false });
            setTimeout(() => channel.close(), 1000);
            this.deps.stateChanged(sessionId);
          },
        };
        r.knocks.set(id, knock);
        this.deps.stateChanged(sessionId);
        return { admitted: false, ...base };
      },
      'coop.state': async () => this.deps.coop.state(sessionId, await self()),
      'coop.subscribe': async () => {
        await self();
        guest!.subscribed = true;
        return this.deps.chat.snapshot(sessionId);
      },
      'coop.unsubscribe': async () => {
        if (guest) guest.subscribed = false;
        return { ok: true as const };
      },
      'coop.models': async ({ models, model }) => {
        const p = await self();
        // A guest's own model runs on their computer: its ref carries their key.
        await this.deps.coop.setModels(sessionId, p.id, models, models === 'own' && model ? `peer-${keyId}/${model}` : model);
        return (await this.deps.coop.state(sessionId, (await this.deps.coop.participant(sessionId, p.id))!))!;
      },
      'coop.typing': async () => {
        this.deps.coop.typing(sessionId, (await editor()).id);
        return { ok: true as const };
      },
      'coop.leave': async () => {
        if (guest?.admitted) {
          await this.deps.coop.remove(sessionId, participantId);
          await this.deps.chat.forgetParticipant(sessionId, participantId);
        }
        r.guests.delete(participantId);
        setTimeout(() => channel.close(), 500);
        return { ok: true as const };
      },
      'chat.send': async ({ parentId, parts, answerWith }) => {
        const p = await editor();
        await ownBlobs(parts);
        const asked = theirs(answerWith);
        return { userMessageId: await refusals(() => this.deps.chat.send(sessionId, parts, parentId, p, asked ? { answerWith: asked } : {})) };
      },
      'chat.queue': async ({ parts, joinTurn, answerWith }) => {
        const p = await editor();
        await ownBlobs(parts);
        const asked = theirs(answerWith);
        return refusals(() => this.deps.chat.queue(sessionId, parts, p, { ...(joinTurn ? { joinTurn } : {}), ...(asked ? { answerWith: asked } : {}) }));
      },
      'chat.secondOpinion': async ({ messageId, model }) => {
        const p = await editor();
        await refusals(() => this.deps.chat.secondOpinion(sessionId, messageId, theirs(model)!, p));
        return { ok: true as const };
      },
      'chat.react': async ({ messageId, emoji, on }) => {
        const p = await self();
        if (guest?.farewell) throw appError('forbidden', 'Co-op ended for this session.');
        await refusals(() => this.deps.chat.react(sessionId, messageId, emoji, on, p));
        return { ok: true as const };
      },
      'coop.track': async ({ task }) => {
        const p = await editor();
        if (!this.deps.tracks) throw appError('unsupported', 'Parallel tracks aren’t available here.');
        return refusals(() => this.deps.tracks!.start(sessionId, task, p));
      },
      'coop.tracks': async () => (await self(), this.deps.tracks ? this.deps.tracks.list(sessionId) : []),
      'coop.trackDiff': async ({ trackId }) => {
        await self();
        if (!this.deps.tracks) throw appError('unsupported', 'Parallel tracks aren’t available here.');
        return this.deps.tracks.diff(sessionId, trackId);
      },
      'coop.navigate': async ({ on }) => {
        const p = await editor();
        const settings = await this.deps.coop.settings(sessionId);
        if (on && p.models === 'host' && !settings.shareModels) throw appError('invalid_request', 'The host doesn’t share their models: choose one of your own first.');
        if (on && p.models === 'own' && !settings.allowGuestModels) throw appError('invalid_request', 'The host hasn’t agreed to send this session to guests’ own models.');
        if (on) await this.deps.coop.updateSettings(sessionId, { navigator: p.id });
        else if (settings.navigator === p.id) await this.deps.coop.updateSettings(sessionId, { navigator: null });
        return (await this.deps.coop.state(sessionId, (await this.deps.coop.participant(sessionId, p.id))!))!;
      },
      'chat.unqueue': async ({ id }) => ({ parts: await refusals(async () => this.deps.chat.unqueue(sessionId, id, await editor())) }),
      'chat.sendNow': async ({ id }) => (await refusals(async () => this.deps.chat.sendNow(sessionId, id, await editor())), { ok: true as const }),
      'chat.stop': async () => (await this.deps.chat.stop(sessionId, await editor()), { ok: true as const }),
      'chat.retry': async ({ messageId }) => (await this.deps.chat.retry(sessionId, messageId, await editor()), { ok: true as const }),
      'chat.continue': async () => (await this.deps.chat.continue(sessionId, await editor()), { ok: true as const }),
      'chat.edit': async ({ messageId, parts }) => {
        const p = await editor();
        await ownBlobs(parts);
        return { userMessageId: await refusals(() => this.deps.chat.edit(sessionId, messageId, parts, p)) };
      },
      'chat.respond': async ({ interactionId, answer }) => {
        const p = await self();
        if (!(await this.deps.chat.mayRespond(sessionId, interactionId, p))) throw appError('forbidden', 'This one is for someone else to answer.');
        if (!this.deps.chat.respond(sessionId, interactionId, answer as never, p)) throw appError('not_waiting', 'This question was already answered or the response stopped.');
        return { ok: true as const };
      },
      'chat.contextBreakdown': async () => (await self(), this.deps.contextBreakdown(sessionId)),
      'chat.changePreview': async ({ interactionId }) => {
        await self();
        const preview = await this.deps.chat.changePreview(sessionId, interactionId);
        if (!preview) throw appError('not_waiting', 'This question was already answered or the response stopped.');
        return preview;
      },
      'chat.editPreview': async ({ callId }) => {
        await self();
        const preview = await this.deps.chat.editPreview(sessionId, callId);
        if (!preview) throw appError('not_found', 'That edit is not in this conversation.');
        return preview;
      },
      'session.diff': async ({ path }) => (await self(), this.deps.sessionDiff(sessionId, path)),
      'artifacts.list': async () => (await self(), this.deps.artifacts(sessionId)),
      'blob.get': async ({ sha256 }) => {
        await self();
        const blob = await this.deps.blob(sessionId, sha256);
        if (!blob) throw appError('not_found', 'That file isn’t part of this session.');
        return { mime: blob.mime, dataBase64: Buffer.from(blob.bytes).toString('base64') };
      },
      'files.upload': async ({ name, mime, dataBase64 }) => {
        await editor();
        // A guest's files are stored on the host's computer: so much a day, no more.
        const day = new Date(this.now()).toISOString().slice(0, 10);
        const used = guest!.uploads?.day === day ? guest!.uploads : { day, files: 0, bytes: 0 };
        const bytes = Math.floor((dataBase64.length * 3) / 4);
        if (used.files >= UPLOADS_PER_DAY || used.bytes + bytes > UPLOAD_BYTES_PER_DAY) throw appError('rate_limited', 'You’ve attached as much as a guest may today. It starts again tomorrow.');
        guest!.uploads = { day, files: used.files + 1, bytes: used.bytes + bytes };
        return this.deps.upload(sessionId, { name, mime, bytes: new Uint8Array(Buffer.from(dataBase64, 'base64')) });
      },
    };
    const server = serveRpc(CoopContract, handlers, coopLane, {}, (method, error) => this.deps.log(`co-op call ${method} failed`, error));
    channel.onClose(() => {
      server.close();
      peer.close();
      if (r.knocks.get(keyId)?.peer === channel) r.knocks.delete(keyId);
      // A guest who came back on a new channel keeps it: only this channel's guest goes.
      if (r.guests.get(participantId)?.channel === channel) r.guests.delete(participantId);
      if (this.stopped) return;
      this.deps.coop.presence(sessionId).catch((error: unknown) => this.deps.log('co-op presence failed', error));
      this.deps.stateChanged(sessionId);
    });
  }
}
