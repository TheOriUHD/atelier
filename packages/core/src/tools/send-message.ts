/**
 * SendMessage and ListSessions (ARCHITECTURE §8, "Messages between sessions"): an agent writes to another of the
 * person's sessions or to one of its running sub-agents, and a sub-agent to its parent. The message reaches the other
 * conversation as a note naming where it came from; how it is delivered is the ChatService's (`sendSessionMessage`).
 */
import type { Mode, SessionSummary } from '@atelier/protocol';
import { textOutput, type DescribeContext, type Tool, type ToolOutput } from './types.ts';

/** The longest message one call sends. */
export const MESSAGE_MAX_CHARS = 20_000;
/** Sessions ListSessions names at most. */
export const LIST_SESSIONS_MAX = 30;

type Send = (sessionId: string, to: string, message: string) => Promise<ToolOutput>;

function describeSend({ tier, has }: DescribeContext): string {
  if (tier === 'compact') return "Sends a message to another of the person's sessions or to a running sub-agent (its task id). Only when the person asks, or a sub-agent needs it.";
  return [
    `Sends a message to another of the person's sessions${has('Agent') ? ', or to one of your sub-agents while it runs' : ''}.`,
    `- Use it only when the person asks you to tell, ask or hand something to another session${has('Agent') ? ', or when a running sub-agent needs a correction or information it lacks' : ''}. Don't start conversations with other sessions on your own.`,
    `- \`to\` is a session id${has('ListSessions') ? ' (ListSessions finds the one the person means)' : ''}${has('Agent') ? ", or a sub-agent's task id as the Agent tool returned it" : ''}.`,
    '- The message arrives in that conversation as a note naming this session, so write it to stand on its own. An answer, if one comes, arrives here as a note: go on with your work and don\'t wait for it with sleep or repeated checks.',
    '- The result says whether the receiver reads it at its next step, started a turn for it, or has it waiting, and why.',
  ].join('\n');
}

function describeToParent({ tier }: DescribeContext): string {
  if (tier === 'compact') return 'Sends a message to the agent that started you: set `to` to "parent". Only for something it needs before your report.';
  return [
    'Sends a message to the agent that started you (your parent session) while you work.',
    '- Use it for something the parent needs before your report: a blocker, a finding that changes its plan, a choice only it can make. Your final report still carries the result.',
    '- Set `to` to "parent". Its answer, if one comes, arrives as a note before one of your next steps. A parent waiting for your report reads the message only after you finish.',
  ].join('\n');
}

/** `toParent`: the sub-agents' version, which writes only to the session that started them. */
export function createSendMessageTool(send: Send, toParent = false): Tool<{ to: string; message: string }> {
  return {
    name: 'SendMessage',
    readOnly: false,
    description: toParent ? describeToParent : describeSend,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 1, maxLength: 200, description: toParent ? 'Always "parent".' : "A session id, or a sub-agent's task id." },
        message: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_CHARS, description: 'The message, complete in itself.' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    async run({ to, message }, ctx) {
      if (!message.trim()) return textOutput('The message is empty.', true);
      return send(ctx.sessionId, to.trim(), message.trim());
    },
  };
}

/** One of the person's sessions as ListSessions names it. */
export interface SessionListing {
  id: string;
  title: string;
  mode: Mode;
  status: SessionSummary['status'];
  /** The name of its folder, when it has one. */
  folder: string | null;
  updatedAt: number;
}

const MODE_NAMES: Record<Mode, string> = { chat: 'Chat', work: 'Cowork', code: 'Code' };

export function createListSessionsTool(list: (sessionId: string, query: string | null) => Promise<SessionListing[]>): Tool<{ query?: string }> {
  return {
    name: 'ListSessions',
    readOnly: true,
    description: ({ tier, has }) =>
      tier === 'compact'
        ? "Lists the person's other sessions (id, title, status), newest first."
        : [
            `Lists the person's other Code sessions and Cowork tasks, most recent first (at most ${LIST_SESSIONS_MAX}): id, title, mode, status, folder and when it last changed.`,
            `- Use it to find the session the person means when they ask you to tell or ask another session something${has('SendMessage') ? ' (then SendMessage with its id)' : ''}.`,
            '- `query` keeps the sessions whose title or messages match its words.',
          ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 200, description: 'Words to look for in titles and messages.' } },
      additionalProperties: false,
    },
    async run({ query }, ctx) {
      const sessions = await list(ctx.sessionId, query?.trim() || null);
      if (!sessions.length) return textOutput(query?.trim() ? `No other session of the person's matches "${query.trim()}".` : 'The person has no other Code sessions or Cowork tasks.');
      const lines = sessions.map((s) =>
        [
          `- ${s.id}`,
          `"${s.title || 'Untitled'}"`,
          MODE_NAMES[s.mode],
          s.status,
          ...(s.folder ? [`folder ${s.folder}`] : []),
          `updated ${new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        ].join(' · '),
      );
      return textOutput(`The person's other sessions, most recent first:\n${lines.join('\n')}`);
    },
  };
}
