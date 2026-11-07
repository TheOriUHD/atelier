/**
 * The `coop.*` procedures (ARCHITECTURE §24). The host turns co-op on and decides who is in and what they may do; each
 * participant chooses whose models answer them, says they're typing and may leave. Who may call what is in rules.ts;
 * `access` (backend.ts) has already checked it against the caller's part in the session.
 */
import { accountParticipant, type CoopSettings, type CoopState, type ModelsChoice } from '@atelier/protocol';
import type { CoopService, ParticipantInfo } from './service.ts';

export interface CoopHandlerDeps<C> {
  coop: CoopService;
  /** The caller's part in the session, checked against rules.ts for `procedure`; throws not_found otherwise. */
  access(ctx: C, sessionId: string, procedure: string): Promise<ParticipantInfo>;
  /** The calling account. */
  userId(ctx: C): string;
  /** Accounts on this backend others may invite (a team server); empty on a desktop. */
  directory(callerId: string): Promise<{ userId: string; name: string; avatar: string | null }[]>;
  /** Whether this backend is a server (teammates) or a desktop (the relay). */
  surface: 'desktop' | 'web';
  /** Stops what a participant who is removed or leaves had running (chat-service.ts), and forgets their reads. */
  forgetParticipant(sessionId: string, participant: { id: string; userId: string | null }): Promise<void>;
  /** The relay side on a desktop host (host.ts); absent on a server. */
  relay?: {
    open(sessionId: string): Promise<void>;
    invite(sessionId: string): Promise<{ url: string; expiresAt: number }>;
    admit(sessionId: string, knockId: string, allow: boolean): Promise<void>;
    close(sessionId: string): Promise<void>;
  };
  /** A guest's desktop joining a session on another computer (gateway.ts). */
  join?(userId: string, invite: string, models: ModelsChoice): Promise<{ sessionId: string; waiting: boolean }>;
  /** A guest's desktop leaving a mirrored session (gateway.ts). */
  leaveMirror?(sessionId: string): Promise<boolean>;
  error(code: string, message: string): Error;
}

export function coopHandlers<C>(d: CoopHandlerDeps<C>) {
  const state = async (sessionId: string, as: ParticipantInfo): Promise<CoopState> => {
    const s = await d.coop.state(sessionId, as);
    if (!s) throw d.error('not_found', 'Co-op isn’t on for this session.');
    return s;
  };
  const host = async (ctx: C, sessionId: string, procedure: string): Promise<ParticipantInfo> => {
    const as = await d.access(ctx, sessionId, procedure);
    if (as.role !== 'host') throw d.error('forbidden', 'Only the host can do that.');
    return as;
  };

  return {
    'coop.state': async ({ sessionId }: { sessionId: string }, ctx: C) => {
      const as = await d.access(ctx, sessionId, 'coop.state');
      return d.coop.state(sessionId, as);
    },

    'coop.start': async ({ sessionId }: { sessionId: string }, ctx: C) => {
      const as = await host(ctx, sessionId, 'coop.start');
      if (d.surface === 'desktop') {
        if (!d.relay) throw d.error('unsupported', 'Co-op between computers isn’t available here.');
        await d.relay.open(sessionId);
      } else await d.coop.start(sessionId, { relayUrl: null });
      return state(sessionId, as);
    },

    'coop.invite': async ({ sessionId }: { sessionId: string }, ctx: C) => {
      await host(ctx, sessionId, 'coop.invite');
      if (!d.relay) throw d.error('unsupported', 'On a server, add teammates instead of sending a link.');
      return d.relay.invite(sessionId);
    },

    'coop.directory': async (_input: Record<string, never>, ctx: C) => d.directory(d.userId(ctx)),

    'coop.add': async ({ sessionId, userIds, role }: { sessionId: string; userIds: string[]; role: 'editor' | 'viewer' }, ctx: C) => {
      const as = await host(ctx, sessionId, 'coop.add');
      if (d.surface === 'desktop') throw d.error('unsupported', 'Send an invite link to bring someone in.');
      const room = await d.coop.room(sessionId);
      if (!room) await d.coop.start(sessionId, { relayUrl: null });
      const allowed = new Set((await d.directory(d.userId(ctx))).map((p) => p.userId));
      const others = (await d.coop.list(sessionId)).length - 1;
      if (others + userIds.length > 3) throw d.error('invalid_request', 'A co-op session has room for four people in all.');
      for (const userId of userIds) {
        if (!allowed.has(userId) || userId === as.userId) throw d.error('not_found', 'That person isn’t on this server.');
        await d.coop.addAccount(sessionId, userId, role);
      }
      return state(sessionId, as);
    },

    'coop.admit': async ({ sessionId, knockId, allow }: { sessionId: string; knockId: string; allow: boolean }, ctx: C) => {
      await host(ctx, sessionId, 'coop.admit');
      if (!d.relay) throw d.error('unsupported', 'Nobody knocks on a server: teammates are added.');
      await d.relay.admit(sessionId, knockId, allow);
      return { ok: true as const };
    },

    'coop.settings': async ({ sessionId, settings }: { sessionId: string; settings: Partial<CoopSettings> }, ctx: C) => {
      const as = await host(ctx, sessionId, 'coop.settings');
      await d.coop.updateSettings(sessionId, settings);
      return state(sessionId, as);
    },

    'coop.participant': async ({ sessionId, participantId, role, trusted }: { sessionId: string; participantId: string; role?: 'editor' | 'viewer'; trusted?: boolean }, ctx: C) => {
      const as = await host(ctx, sessionId, 'coop.participant');
      if (participantId === as.id) throw d.error('invalid_request', 'The host’s part doesn’t change.');
      if (!(await d.coop.participant(sessionId, participantId))) throw d.error('not_found', 'They’re no longer in this session.');
      if (role) await d.coop.setRole(sessionId, participantId, role);
      if (trusted !== undefined) await d.coop.setTrusted(sessionId, participantId, trusted);
      return state(sessionId, as);
    },

    'coop.remove': async ({ sessionId, participantId }: { sessionId: string; participantId: string }, ctx: C) => {
      const as = await host(ctx, sessionId, 'coop.remove');
      if (participantId === as.id) throw d.error('invalid_request', 'End co-op instead.');
      const gone = await d.coop.remove(sessionId, participantId);
      if (gone) await d.forgetParticipant(sessionId, { id: gone.id, userId: gone.userId });
      return { ok: true as const };
    },

    'coop.models': async ({ sessionId, models, model }: { sessionId: string; models: ModelsChoice; model: string | null }, ctx: C) => {
      const as = await d.access(ctx, sessionId, 'coop.models');
      if (as.role === 'host') throw d.error('invalid_request', 'The host answers with the session’s own model: choose it in the model menu.');
      await d.coop.setModels(sessionId, as.id, models, model);
      return state(sessionId, (await d.coop.participant(sessionId, as.id))!);
    },

    'coop.typing': async ({ sessionId }: { sessionId: string }, ctx: C) => {
      const as = await d.access(ctx, sessionId, 'coop.typing');
      d.coop.typing(sessionId, as.id);
      return { ok: true as const };
    },

    // A guest on this server lends their own connectors through their account already (chat-service.ts toolsFor);
    // across computers the guest's gateway answers this for its mirror (gateway.ts).
    'coop.lend': async ({ sessionId }: { sessionId: string; lend: boolean }, ctx: C) => {
      await d.access(ctx, sessionId, 'coop.lend');
      return { ok: true as const };
    },

    'coop.leave': async ({ sessionId }: { sessionId: string }, ctx: C) => {
      if (d.leaveMirror && (await d.leaveMirror(sessionId))) return { ok: true as const };
      const as = await d.access(ctx, sessionId, 'coop.leave');
      if (as.role === 'host') throw d.error('invalid_request', 'The host ends co-op instead of leaving.');
      const gone = await d.coop.remove(sessionId, as.id);
      if (gone) await d.forgetParticipant(sessionId, { id: gone.id, userId: gone.userId });
      return { ok: true as const };
    },

    'coop.end': async ({ sessionId }: { sessionId: string }, ctx: C) => {
      await host(ctx, sessionId, 'coop.end');
      // Guests across computers are told first, while they may still fetch the copy the host lets them keep.
      await d.relay?.close(sessionId);
      const gone = await d.coop.end(sessionId);
      for (const p of gone) await d.forgetParticipant(sessionId, { id: p.id, userId: p.userId });
      return { ok: true as const };
    },

    'coop.join': async ({ invite, models }: { invite: string; models: ModelsChoice }, ctx: C) => {
      if (!d.join) throw d.error('unsupported', 'Joining a session on another computer needs the desktop app, running on this computer.');
      return d.join(d.userId(ctx), invite, models);
    },
  };
}

/** The host's own participant id, for a session's owner. */
export const hostParticipantId = accountParticipant;
