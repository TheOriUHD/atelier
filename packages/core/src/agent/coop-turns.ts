/**
 * Co-op turns (ARCHITECTURE §24): who a turn is for, what it runs on and who pays, and how the messages people queue
 * while someone else's turn runs are taken. Pure rules; chat-service.ts applies them.
 *
 * A turn is for the author of the person's message that opened it. Their choice of "whose models answer me" decides the
 * model and the payer: the host's models are the host's to pay for (a guest's use counts against what the host shares),
 * a guest's own models are theirs. The folder, its tools and their approvals stay the host's either way.
 */
import { parsePeerModelRef, type OutboxMessage, type ParticipantRole } from '@atelier/protocol';

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
export function actorFor(hostUserId: string | null, participant: TurnParticipant): TurnActor {
  const base = { shared: true, participant, problem: null };
  if (participant.role === 'host') return { ...base, payer: hostUserId, modelUser: hostUserId, ref: null, forParticipant: null };
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
