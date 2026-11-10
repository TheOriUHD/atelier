/**
 * The transcript as rows (ARCHITECTURE §25): what each message shows in the terminal, in order. A row that can't
 * change any more is final; the leading final rows are printed once into the terminal's scrollback (Ink's <Static>),
 * the rest is redrawn as it streams. A row is final when its message ended, when a later part of it began, or (a tool
 * call) when its result came.
 */
import type { LiveSessionState } from '@atelier/client';
import type { Message, Notice, ToolCallPart, ToolResultPart } from '@atelier/protocol';

export type Row =
  | { key: string; kind: 'user'; text: string; attachments: string[]; at: number }
  | { key: string; kind: 'text'; text: string; final: boolean }
  | { key: string; kind: 'thinking'; text: string; final: boolean; seconds: number | null }
  | { key: string; kind: 'tool'; call: ToolCallPart; result: ToolResultPart | undefined; final: boolean; since: number }
  | { key: string; kind: 'notice'; text: string }
  | { key: string; kind: 'error'; text: string; fix?: string | undefined }
  | { key: string; kind: 'local'; lines: string[]; at: number }
  /** Under a finished turn: how long it took, from the message to the end of the reply, and when it ended. */
  | { key: string; kind: 'turn'; since: number; end: number; stopped: boolean };

/** Output of the terminal itself (a command's answer, `!` output), placed among the messages by time. */
export interface LocalRow {
  key: string;
  lines: string[];
  at: number;
}

const isFinal = (r: Row) => !('final' in r) || r.final;

function noticeText(n: Notice): string | null {
  switch (n.kind) {
    case 'compaction':
      return `Compacted the conversation${n.saved ? ` · ${n.saved.toLocaleString('en')} tokens freed` : ''}`;
    case 'moved':
      return `Moved to ${n.to}`;
    case 'loop':
      return 'A /loop turn';
    case 'agent':
      return 'Background agents finished';
    case 'message':
      return 'A message from another session';
    case 'command':
      return null;
    default:
      return null;
  }
}

function userRow(m: Message): Row[] {
  const text = m.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
  const attachments = m.parts.flatMap((p) => (p.type === 'image' ? ['image'] : p.type === 'document' ? [p.name] : []));
  const notices = m.parts.flatMap((p) => (p.type === 'context' && p.notice ? [noticeText(p.notice)].filter((t): t is string => !!t) : []));
  const command = m.parts.find((p) => p.type === 'context' && p.notice?.kind === 'command');
  const rows: Row[] = notices.map((text, i) => ({ key: `${m.id}:n${i}`, kind: 'notice', text }));
  if (text || attachments.length) rows.push({ key: m.id, kind: 'user', text, attachments, at: m.createdAt });
  else if (command && command.type === 'context') rows.push({ key: m.id, kind: 'user', text: command.text.split('\n')[0] ?? '/compact', attachments: [], at: m.createdAt });
  return rows;
}

/** Rows for a session's messages, merged with the terminal's own output. */
export function buildRows(state: Pick<LiveSessionState, 'messages' | 'streamingMessageId' | 'session'>, local: readonly LocalRow[] = []): Row[] {
  const results = new Map<string, ToolResultPart>();
  for (const m of state.messages) for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);
  const running = state.session?.status === 'running' || state.session?.status === 'waiting';
  const rows: Row[] = [];
  /** The turn going on in the loop: when its message was sent, when its last part ended, its last reply and the row after it. */
  let turn: { since: number; end: number; last: Message | null; after: number } | null = null;
  const endTurn = (over: boolean) => {
    const t = turn;
    turn = null;
    if (!t?.last || !over) return;
    rows.splice(t.after, 0, { key: `${t.last.id}:turn`, kind: 'turn', since: t.since, end: t.end, stopped: t.last.stopReason === 'aborted' });
  };
  const pending = [...local].sort((a, b) => a.at - b.at);
  const flushLocal = (before: number) => {
    while (pending.length && pending[0]!.at <= before) {
      const l = pending.shift()!;
      rows.push({ key: l.key, kind: 'local', lines: l.lines, at: l.at });
    }
  };
  for (const m of state.messages) {
    // A message of the person's own starts a turn; the one before it is over.
    if (m.role === 'user' && m.kind === 'normal') {
      endTurn(true);
      turn = { since: m.createdAt, end: m.createdAt, last: null, after: 0 };
    } else if (turn && m.kind === 'normal') {
      turn.end = Math.max(turn.end, m.createdAt + (m.role === 'assistant' ? (m.usage?.durationMs ?? 0) : 0));
      if (m.role === 'assistant') turn.last = m;
    }
    flushLocal(m.createdAt);
    if (m.kind === 'compaction_summary') {
      rows.push({ key: m.id, kind: 'notice', text: 'Earlier messages were summarized to make room' });
      continue;
    }
    if (m.role === 'user' && m.kind === 'normal') {
      rows.push(...userRow(m));
      continue;
    }
    if (m.role !== 'assistant') continue;
    const done = !!m.stopReason || m.id !== state.streamingMessageId;
    m.parts.forEach((part, index) => {
      const key = `${m.id}:${index}`;
      const later = index < m.parts.length - 1;
      if (part.type === 'text' && part.text.trim()) rows.push({ key, kind: 'text', text: part.text, final: done || later });
      else if (part.type === 'thinking' && (part.text.trim() || part.redacted)) {
        rows.push({ key, kind: 'thinking', text: part.text, final: done || later, seconds: m.usage?.durationMs ? Math.round(m.usage.durationMs / 1000) : null });
      } else if (part.type === 'tool_call') {
        const result = results.get(part.id);
        rows.push({ key, kind: 'tool', call: part, result, final: !!result || (done && !running), since: m.createdAt });
      }
    });
    if (m.error) rows.push({ key: `${m.id}:error`, kind: 'error', text: m.error.message, fix: m.error.fix });
    else if (m.stopReason === 'refusal') rows.push({ key: `${m.id}:refusal`, kind: 'error', text: 'The model’s provider ended this reply.' });
    if (turn?.last === m) turn.after = rows.length;
  }
  // The last turn is over once the session stopped running and its reply has ended.
  const last = (turn as { last: Message | null } | null)?.last;
  endTurn(!running && state.streamingMessageId === null && !!(last && (last.stopReason || last.error)));
  flushLocal(Infinity);
  return rows;
}

/** How many rows from the start are final (and may be printed for good). */
export function finalCount(rows: readonly Row[]): number {
  const i = rows.findIndex((r) => !isFinal(r));
  return i === -1 ? rows.length : i;
}
