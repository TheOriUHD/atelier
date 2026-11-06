/**
 * Co-op (ARCHITECTURE §24): two to four people work in one session that lives on its host's backend, a desktop's own
 * or a team server. Each person is a participant. On a server a participant is one of its accounts; across desktops a
 * participant is a peer, known by its device key, who joined through an invite link and the relay
 * (packages/core/src/coop).
 *
 * The two ways to power a co-op session are one choice per person, "whose models answer me": the host's (when the host
 * shares them) or their own.
 */
import { z } from 'zod';

/** `account:<userId>` for an account on the host's backend, `peer:<key id>` for a guest from another computer. */
export const ParticipantId = z.string().regex(/^(account|peer):[A-Za-z0-9_-]{1,64}$/);
export type ParticipantId = z.infer<typeof ParticipantId>;

export const accountParticipant = (userId: string): ParticipantId => `account:${userId}`;
export const peerParticipant = (keyId: string): ParticipantId => `peer:${keyId}`;
/** The account a participant id stands for, or null for a peer. */
export function participantUserId(id: string): string | null {
  return id.startsWith('account:') ? id.slice('account:'.length) : null;
}

/**
 * `host`: the session's owner, whose computer or server it runs on. `editor`: can send, queue, stop and answer what is
 * theirs to answer. `viewer`: watches.
 */
export const ParticipantRole = z.enum(['host', 'editor', 'viewer']);
export type ParticipantRole = z.infer<typeof ParticipantRole>;

/** Whose models answer this participant's messages. */
export const ModelsChoice = z.enum(['host', 'own']);
export type ModelsChoice = z.infer<typeof ModelsChoice>;

export const Participant = z.object({
  id: ParticipantId,
  kind: z.enum(['account', 'peer']),
  name: z.string().min(1).max(80),
  /** An avatar as a blob id (accounts) or a data URL the peer sent (at most 64 KB). */
  avatar: z.string().max(90_000).nullable(),
  role: ParticipantRole,
  models: ModelsChoice,
  /** The model this participant answers with: a ref on the host (`host`) or on their own computer (`own`). */
  model: z.string().nullable(),
  /** May answer the host's approval prompts in this session (the host trusts them with the folder). */
  trusted: z.boolean(),
  online: z.boolean(),
  joinedAt: z.number(),
});
export type Participant = z.infer<typeof Participant>;

/** What the host decides for a co-op session. */
export const CoopSettings = z.object({
  /** Guests may answer with the host's models. */
  shareModels: z.boolean(),
  /** At most this many requests a day per guest on the host's models; null: no cap. */
  sharedRequestsPerDay: z.number().int().positive().nullable(),
  /** At most this many US dollars a day per guest on the host's priced models; null: no cap. */
  sharedSpendPerDayUsd: z.number().positive().nullable(),
  /** Guests keep a copy of the conversation when co-op ends or they leave. */
  guestsKeepCopy: z.boolean(),
  /** Guests' own models read what the session reads (files in the host's folder): the host agreed to it. */
  allowGuestModels: z.boolean(),
});
export type CoopSettings = z.infer<typeof CoopSettings>;

export const DEFAULT_COOP_SETTINGS: CoopSettings = {
  shareModels: true,
  sharedRequestsPerDay: 50,
  sharedSpendPerDayUsd: 2,
  guestsKeepCopy: true,
  allowGuestModels: true,
};

/** A co-op session as one participant sees it. */
export const CoopState = z.object({
  sessionId: z.string(),
  /** This viewer's participant id. */
  me: ParticipantId,
  role: ParticipantRole,
  participants: z.array(Participant),
  settings: CoopSettings,
  /** An invite link while one is open (the host only); its secret is never shown again once closed. */
  invite: z.object({ url: z.string(), expiresAt: z.number() }).nullable(),
  /** Someone asking to come in (the host only): their name and the fingerprint both sides see. */
  knocking: z.array(z.object({ id: z.string(), name: z.string(), fingerprint: z.array(z.string()).length(3) })),
  /** Over the relay (desktops) or on this server (accounts). */
  via: z.enum(['relay', 'server']),
  /** The host's computer can't be reached right now (asleep, offline): the session waits for it. */
  hostAway: z.boolean(),
  ended: z.boolean(),
  /** Today's use of the host's models by this viewer, when they answer with them. */
  sharedUse: z.object({ requests: z.number(), spentUsd: z.number() }).nullable(),
});
export type CoopState = z.infer<typeof CoopState>;

/** The model a guest's message is answered with, when it runs on the guest's own computer: `peer-<keyId>/<their ref>`. */
export const PEER_MODEL_PREFIX = 'peer-';
export const peerModelRef = (keyId: string, ref: string): string => `${PEER_MODEL_PREFIX}${keyId}/${ref}`;
export function parsePeerModelRef(ref: string): { keyId: string; ref: string } | null {
  if (!ref.startsWith(PEER_MODEL_PREFIX)) return null;
  const slash = ref.indexOf('/');
  if (slash <= PEER_MODEL_PREFIX.length) return null;
  return { keyId: ref.slice(PEER_MODEL_PREFIX.length, slash), ref: ref.slice(slash + 1) };
}

/** A co-op session mirrored on a guest's own backend has this id prefix (`coop_<roomId>_<host session id>`). */
export const COOP_MIRROR_PREFIX = 'coop_';
export const isCoopMirror = (sessionId: string): boolean => sessionId.startsWith(COOP_MIRROR_PREFIX);

/**
 * An invite link: `https://atelierhq.dev/join#v1.<roomId>.<secret>.<meta>` (or the same fragment on `atelier://join`).
 * The fragment never reaches a server: the relay sees the room id only when a guest connects, and never the secret.
 * `meta` is what the join card shows before anything connects: the host's name, the session's title and mode.
 */
export interface InviteMeta {
  hostName: string;
  title: string;
  mode: 'chat' | 'work' | 'code';
}

const b64url = {
  encode: (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
  decode: (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))),
};

export const INVITE_BASE = 'https://atelierhq.dev/join';

/** The fragment of an invite (after `#`), from a link in either form or the bare fragment. */
export function inviteFragment(invite: string): string {
  const hash = invite.indexOf('#');
  return (hash >= 0 ? invite.slice(hash + 1) : invite).trim();
}

/** The parts of an invite's fragment; null when it isn't one. */
export function parseInviteFragment(invite: string): { roomId: string; secret: string; meta: InviteMeta | null } | null {
  const [version, roomId, secret, meta] = inviteFragment(invite).split('.');
  if (version !== 'v1' || !roomId || !secret || !/^[A-Za-z0-9_-]+$/.test(roomId) || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  let parsed: InviteMeta | null = null;
  if (meta) {
    try {
      const value = JSON.parse(b64url.decode(meta)) as Partial<InviteMeta>;
      if (typeof value.hostName === 'string' && typeof value.title === 'string' && (value.mode === 'chat' || value.mode === 'work' || value.mode === 'code'))
        parsed = { hostName: value.hostName.slice(0, 80), title: value.title.slice(0, 200), mode: value.mode };
    } catch {
      parsed = null;
    }
  }
  return { roomId, secret, meta: parsed };
}

export function makeInviteUrl(roomId: string, secret: string, meta: InviteMeta): string {
  return `${INVITE_BASE}#v1.${roomId}.${secret}.${b64url.encode(JSON.stringify(meta))}`;
}
