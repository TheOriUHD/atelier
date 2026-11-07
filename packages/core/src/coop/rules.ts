/**
 * What a co-op participant who isn't a session's owner may call on it (ARCHITECTURE §24). Every procedure that takes a
 * session is listed: `viewer` and `editor` are the least role that may call it, `owner` keeps it to the session's own
 * person (its host), which is also what any procedure missing here means. coop-rules.test.ts fails on a procedure that
 * takes a session and isn't classified, so a new one is a decision, not a hole.
 */
import type { ParticipantRole } from '@atelier/protocol';

export type CoopAccess = Exclude<ParticipantRole, 'host'> | 'owner';

export const COOP_RULES = {
  // Watching: the conversation, its context figures and the changes it made.
  'sessions.subscribe': 'viewer',
  'sessions.unsubscribe': 'viewer',
  'sessions.markSeen': 'viewer',
  'sessions.leave': 'viewer',
  'chat.contextBreakdown': 'viewer',
  'chat.editPreview': 'viewer',
  'chat.changePreview': 'viewer',
  'artifacts.list': 'viewer',
  'checkpoints.list': 'viewer',
  'tasks.output': 'viewer',
  // The session's own changes only (compare 'session'), read through the host's folder; never the rest of the repo.
  'workspaces.diff': 'viewer',
  // Taking part: what one's own messages and turns need. Each checks what it touches is the caller's (chat-service.ts).
  'chat.send': 'editor',
  'chat.queue': 'editor',
  'chat.unqueue': 'editor',
  'chat.sendNow': 'editor',
  'chat.stop': 'editor',
  'chat.retry': 'editor',
  'chat.continue': 'editor',
  'chat.edit': 'editor',
  // A file attached to one's own message: it stays the uploader's, and the session reads it through the message.
  'files.upload': 'editor',
  // Approvals: who may answer is checked per question (its approver).
  'chat.respond': 'viewer',
  // The host's alone: their folder, their settings, the conversation's history and what runs in their name.
  'sessions.update': 'owner',
  'sessions.move': 'owner',
  'sessions.fork': 'owner',
  'sessions.continueInCowork': 'owner',
  'sessions.delete': 'owner',
  'chat.switchBranch': 'owner',
  'chat.compact': 'owner',
  'checkpoints.rewind': 'owner',
  'tasks.stop': 'owner',
  'tasks.clear': 'owner',
  'loops.start': 'owner',
  'loops.stop': 'owner',
  'sideChats.start': 'owner',
  'sideChats.list': 'owner',
  // Co-op itself: everyone sees it, chooses their own models, says they're typing and may leave; the rest is the host's.
  'coop.state': 'viewer',
  'coop.models': 'viewer',
  'coop.leave': 'viewer',
  'coop.typing': 'editor',
  'coop.lend': 'editor',
  'coop.navigate': 'editor',
  'chat.secondOpinion': 'editor',
  // Watching is enough to put an emoji on a message.
  'chat.react': 'viewer',
  'coop.start': 'owner',
  'coop.invite': 'owner',
  'coop.add': 'owner',
  'coop.admit': 'owner',
  'coop.settings': 'owner',
  'coop.participant': 'owner',
  'coop.remove': 'owner',
  'coop.end': 'owner',
} as const satisfies Record<string, CoopAccess>;

export type CoopProcedure = keyof typeof COOP_RULES;

const RANK: Record<ParticipantRole, number> = { viewer: 0, editor: 1, host: 2 };

/** Whether a participant with `role` may call `procedure` on the session. */
export function coopAllows(procedure: string, role: ParticipantRole): boolean {
  if (role === 'host') return true;
  const need = (COOP_RULES as Record<string, CoopAccess>)[procedure] ?? 'owner';
  return need !== 'owner' && RANK[role] >= RANK[need];
}
