/**
 * Side chats (`/btw`): a question asked beside a session without interrupting it (ARCHITECTURE › Side chats). A side
 * chat is a child session marked in its overrides, so it is hidden from lists and deleted with its parent like a
 * sub-agent's; unlike one, it talks to the person, only reads, and hears the main conversation at each of its turns as
 * a note on its newest message, never stored, so nothing of it reaches the main session and nothing stale piles up.
 */
import type { Effort, Message, Mode, Part } from '@atelier/protocol';
import { escapeTags } from '../prompts/escape.ts';
import { renderNote, type Overrides } from '../prompts/templates.ts';
import type { Tool } from '../tools/types.ts';
import { renderForSummary } from './compaction.ts';
import { headTail } from './context.ts';

/** The overrides key that marks a child session as a side chat. */
export const SIDE_CHAT_KEY = 'sideChat';

/** A quick question needs a quick answer: side chats think at this level, whatever the main session's. */
export const SIDE_CHAT_EFFORT: Effort = 'low';

/** The built-in tools a side chat has: they look at the folder and the web, and change nothing. */
const SIDE_CHAT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'MemorySearch', 'MemoryView', 'ChatSearch', 'ChatRead']);

/** The most a side chat's title (its first question) keeps. */
const TITLE_CHARS = 80;

export function isSideChat(row: { parentSessionId: string | null; overrides: Record<string, unknown> }): boolean {
  return row.parentSessionId !== null && row.overrides[SIDE_CHAT_KEY] === true;
}

/** The title a side chat starts with: its question on one line, cut to fit. */
export function sideChatTitle(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/**
 * The read-only part of a session's tools. Chat's Read is its own sandbox's, which a side chat doesn't share, so a
 * chat's side chat only reads the web and read-only connectors.
 */
export function sideChatTools<T extends Pick<Tool, 'name' | 'readOnly'>>(mode: Mode, tools: T[]): T[] {
  return tools.filter((t) => t.readOnly && (t.name.startsWith('mcp__') || (SIDE_CHAT_TOOLS.has(t.name) && !(mode === 'chat' && t.name === 'Read'))));
}

/**
 * The main conversation as the side chat reads it, at most `maxChars`: its start (the task, or the summary that
 * replaced the older part) and as much of its newest part as fits, each message as the summarizer renders it.
 */
export function mainTranscript(messages: readonly Message[], maxChars: number): string {
  const blocks = messages.map(renderForSummary).filter((b) => !/^\w[\w ]*: $/.test(b));
  if (!blocks.length) return '';
  const first = headTail(blocks[0]!, Math.floor(maxChars / 4), (cut) => `[… ${cut} characters left out …]`);
  let room = maxChars - first.length;
  const tail: string[] = [];
  for (let i = blocks.length - 1; i > 0; i--) {
    const block = blocks[i]!;
    if (block.length > room) {
      // The newest message alone is longer than the room: its start and end still say what it is.
      if (!tail.length && room > 200) tail.unshift(headTail(block, room, (cut) => `[… ${cut} characters left out …]`));
      break;
    }
    tail.unshift(block);
    room -= block.length + 2;
  }
  const skipped = blocks.length - 1 - tail.length;
  return [first, ...(skipped > 0 ? [`[… ${skipped} earlier message${skipped === 1 ? '' : 's'} left out …]`] : []), ...tail].join('\n\n');
}

/** The note a side chat's newest message carries: what it is, and the main conversation as it stands. */
export function sideChatNote(input: { title: string | null; running: boolean; transcript: string }, overrides: Overrides = {}): string {
  return renderNote(
    'notes/side-chat',
    { title: escapeTags(input.title ?? ''), running: input.running ? 'yes' : '', transcript: input.transcript, empty: input.transcript ? '' : 'yes' },
    overrides,
  );
}

/** `history` with `note` in front of its newest message from the person (in what is sent only). */
export function withSideChatNote(history: Message[], note: string): Message[] {
  const at = history.findLastIndex((m) => m.role === 'user' && m.kind === 'normal');
  if (at < 0) return history;
  const part: Part = { type: 'context', text: note };
  return history.map((m, i) => (i === at ? { ...m, parts: [part, ...m.parts] } : m));
}
