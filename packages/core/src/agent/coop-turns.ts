/**
 * Co-op turns (ARCHITECTURE §24): who a turn is for, what it runs on and who pays, and how the messages people queue
 * while someone else's turn runs are taken. Pure rules; chat-service.ts applies them.
 *
 * A turn is for the author of the person's message that opened it. Their choice of "whose models answer me" decides the
 * model and the payer: the host's models are the host's to pay for (a guest's use counts against what the host shares),
 * a guest's own models are theirs. The folder, its tools and their approvals stay the host's either way.
 */
import { parseAnswerWith, parsePeerModelRef, peerParticipant, type CoopSettings, type OutboxMessage, type Part, type ParticipantRole } from '@atelier/protocol';

/** A participant as a turn needs them (coop/service.ts `ParticipantInfo`). */
export interface TurnParticipant {
  id: string;
  kind: 'account' | 'peer';
  userId: string | null;
  role: ParticipantRole;
  models: 'host' | 'own';
  model: string | null;
  trusted: boolean;
  name: string;
  /** For this one turn, the model they asked for (an @mention, a second opinion): `host:<ref>` or `own:<ref>`. */
  answerWith?: string;
}

export interface TurnActor {
  /** Co-op is on for the session. */
  shared: boolean;
  /** Whom the turn is for; null outside co-op. */
  participant: TurnParticipant | null;
  /** The account that pays and whose limits count; null when a guest's own computer runs the model. */
  payer: string | null;
  /** The account whose providers resolve the model (personal providers included). */
  modelUser: string | null;
  /** The model to answer with in place of the session's own: a guest's choice. */
  ref: string | null;
  /** Someone else pays for this participant's requests (the host's models, shared): their usage is counted as theirs. */
  forParticipant: string | null;
  /** Why the turn can't run as asked (a guest who brings their own models but chose none). */
  problem: string | null;
}

/** The turn of a session nobody shares: its own person's, as always. */
export const soloActor = (userId: string | null): TurnActor => ({ shared: false, participant: null, payer: userId, modelUser: userId, ref: null, forParticipant: null, problem: null });

/** The actor of a co-op turn for `participant` in a session owned by `hostUserId`. */
export function actorFor(hostUserId: string | null, asked: TurnParticipant): TurnActor {
  const { answerWith, ...participant } = asked;
  const chosen = parseAnswerWith(answerWith);
  const base = { shared: true, participant, problem: null };
  if (participant.role === 'host') return { ...base, payer: hostUserId, modelUser: hostUserId, ref: chosen?.ref ?? null, forParticipant: null };
  // A model asked for this one answer stands in for their usual choice, by the same rules.
  if (chosen) return actorFor(hostUserId, { ...participant, models: chosen.source, model: chosen.ref });
  if (participant.models === 'host') return { ...base, payer: hostUserId, modelUser: hostUserId, ref: participant.model, forParticipant: participant.id };
  if (!participant.model) return { ...base, payer: null, modelUser: null, ref: null, forParticipant: null, problem: `${participant.name} answers with their own models but hasn’t chosen one yet.` };
  // A peer's own model runs on their computer (peer-<key>/<ref>): nothing is paid or limited here.
  if (participant.kind === 'peer' || parsePeerModelRef(participant.model)) return { ...base, payer: null, modelUser: hostUserId, ref: participant.model, forParticipant: null };
  return { ...base, payer: participant.userId, modelUser: participant.userId, ref: participant.model, forParticipant: null };
}

/** Whether `by` wrote a queued message (a message without an author is the host's, from before co-op). */
const wrote = (item: OutboxMessage, by: string | null, hostId: string | null): boolean => (item.author ?? hostId) === by;

/**
 * What a running turn takes in at its next step: its own author's messages and those asked to join it, in order, up to a
 * slash command (which needs a turn of its own). Everyone else's wait for their own turn.
 */
export function takenByTurn(items: readonly OutboxMessage[], actorId: string | null, hostId: string | null, isCommand: (m: OutboxMessage) => boolean): OutboxMessage[] {
  const take: OutboxMessage[] = [];
  for (const m of items) {
    if (!wrote(m, actorId, hostId) && !m.joinTurn) continue;
    if (isCommand(m)) break;
    take.push(m);
  }
  return take;
}

/** After a turn: the next one opens with the first waiting author's messages, in order; the others keep waiting. */
export function nextTurn(items: readonly OutboxMessage[], hostId: string | null): OutboxMessage[] {
  const first = items[0];
  if (!first) return [];
  const author = first.author ?? hostId;
  return items.filter((m) => (m.author ?? hostId) === author);
}

/** Stop gives back the stopper's own waiting messages; everyone else's keep waiting. */
export const keptOnStop = (items: readonly OutboxMessage[], by: string | null, hostId: string | null): OutboxMessage[] => items.filter((m) => !wrote(m, by, hostId));

/** Only the author takes a waiting message back, or sends it now; the host may too. */
export const mayHandle = (item: OutboxMessage, by: string | null, hostId: string | null, byRole: ParticipantRole | null): boolean => byRole === 'host' || wrote(item, by, hostId);

/** Permission modes from the strictest; a guest's turn runs at the host's mode or Accept edits, whichever is stricter. */
const STRICTNESS = ['plan', 'planAuto', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
type Mode = (typeof STRICTNESS)[number];

/**
 * The mode a guest's turn runs at: never the host's Auto or Bypass, which trust the host's own requests. Edits inside the
 * folder go through (Rewind undoes them); commands, the network and anything outside the folder ask the host.
 */
export function guestMode(hostMode: Mode): Mode {
  return STRICTNESS.indexOf(hostMode) <= STRICTNESS.indexOf('acceptEdits') ? hostMode : 'acceptEdits';
}

/** How long a question waits in co-op for the person who may answer it before it is denied by itself. */
export const COOP_QUESTION_TIMEOUT_MS = 5 * 60_000;

/**
 * What a guest's message may carry: Atelier writes its own notes (context parts), so a guest's message keeps only the
 * kinds the server writes again from what they point at (a quote, a marked area). Anything else could pass for a note.
 */
export const guestParts = (parts: readonly Part[]): Part[] => parts.filter((p) => p.type !== 'context' || p.notice?.kind === 'quote' || p.notice?.kind === 'area');

/** The tag that opens each person's message in a shared session, added after their text is escaped (unforgeable). */
export const senderTag = (name: string, host: boolean): string => `<sender name="${name.replaceAll('"', "'").replace(/[<>&]/g, '')}"${host ? ' role="host"' : ''}/>`;

/**
 * Why `by` can't have `value` answer them (an @mention, a second opinion), or null when they can: the host's models only
 * while the host shares them, someone's own models only their own, and a guest's own only where the host agreed.
 */
export function answerWithProblem(value: string, by: TurnParticipant, settings: CoopSettings): string | null {
  const chosen = parseAnswerWith(value);
  if (!chosen) return 'That isn’t a model to answer with.';
  if (by.role === 'host') return parsePeerModelRef(chosen.ref) ? 'That model is a guest’s own.' : null;
  if (chosen.source === 'host') return !settings.shareModels ? 'The host doesn’t share their models in this session.' : parsePeerModelRef(chosen.ref) ? 'That model is a guest’s own.' : null;
  if (!settings.allowGuestModels) return 'The host hasn’t agreed to send this session to guests’ own models.';
  const peer = parsePeerModelRef(chosen.ref);
  if (by.kind === 'peer') return peer && peerParticipant(peer.keyId) === by.id ? null : 'Only your own models answer as yours.';
  return peer ? 'That model is a guest’s own.' : null;
}
