/**
 * Search over a person's past chats (ARCHITECTURE › Memory › Past chats): ChatSearch ranks messages with the full-text
 * index (`messages_fts`, bm25) plus session titles and returns a short snippet per conversation, never whole chats;
 * ChatRead returns a bounded window of one conversation. There are no embeddings: the model gets "semantic enough"
 * results by issuing several focused queries with synonyms, as the tool description tells it.
 */
import { formatChatHits, messageText, type ChatHit, type Message, type Mode } from '@atelier/protocol';
import type { SessionRepo, SessionRow } from '../sessions/session-repo.ts';
import type { Db } from '../store/db.ts';
import { isTemporary } from '../sessions/temporary.ts';
import { SEARCHABLE_SESSION_SQL } from './access.ts';

export const CHAT_SEARCH_DEFAULT = 6;
export const CHAT_SEARCH_MAX = 8;
/** A hit's snippet, at most. */
export const SNIPPET_CHARS = 220;
/** Messages one ChatRead returns at most, and each message's text at most. */
export const CHAT_READ_MAX = 6;
export const CHAT_READ_MESSAGE_CHARS = 3_000;

/** Words that only make a query match everything. */
const STOPWORDS = new Set(
  'a an and are as at be but by did do does for from had has have how i in is it its me my of on or our so that the their them then there they this to was we were what when where which who why will with you your about der die das und ist ein eine nicht mit von zu den im ich du wir sie es'.split(' '),
);

/** An FTS5 query from free text: each word as a prefix, any of them (bm25 ranks those matching more words first). */
export function ftsQuery(query: string): string | null {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPWORDS.has(w)))].slice(0, 12);
  return words.length ? words.map((w) => `"${w}"*`).join(' OR ') : null;
}

export interface ChatSearchOptions {
  userId: string;
  /** The conversation asking: never its own hit. */
  excludeSessionId: string;
  query: string;
  limit?: number;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The person's own top-level conversations matching `query`, best first, one hit each: not the asking one, not
 * sub-agents or side chats (children), not temporary chats. Deleted conversations are gone from the tables.
 */
export function searchChats(db: Db, opts: ChatSearchOptions): ChatHit[] {
  const limit = Math.min(Math.max(1, opts.limit ?? CHAT_SEARCH_DEFAULT), CHAT_SEARCH_MAX);
  const match = ftsQuery(opts.query);
  if (!match) return [];
  const scope = `s.user_id = ? AND s.parent_session_id IS NULL AND s.id <> ? AND ${SEARCHABLE_SESSION_SQL}`;
  let rows: { messageId: string; sessionId: string; createdAt: number; snippet: string; score: number }[] = [];
  try {
    rows = db.$client
      .prepare(
        `SELECT m.id AS messageId, m.session_id AS sessionId, m.created_at AS createdAt,
                snippet(messages_fts, 0, '', '', '…', 32) AS snippet, bm25(messages_fts) AS score
         FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ? AND ${scope} AND m.kind = 'normal' AND m.role IN ('user', 'assistant')
         ORDER BY score LIMIT 400`,
      )
      .all(match, opts.userId, opts.excludeSessionId) as typeof rows;
  } catch {
    // A query FTS5 can't parse finds nothing rather than failing the tool.
    rows = [];
  }
  const words = match.split(' OR ').map((w) => w.slice(1, -2));
  const titled = db.$client
    .prepare(`SELECT s.id AS id, s.title AS title, s.mode AS mode, s.updated_at AS updatedAt FROM sessions s WHERE ${scope} AND (${words.map(() => `lower(s.title) LIKE ? ESCAPE '\\'`).join(' OR ')}) LIMIT 200`)
    .all(opts.userId, opts.excludeSessionId, ...words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)) as { id: string; title: string; mode: Mode; updatedAt: number }[];

  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!best.has(r.sessionId)) best.set(r.sessionId, r);
  const ids = [...new Set([...best.keys(), ...titled.map((t) => t.id)])];
  if (!ids.length) return [];
  const sessions = new Map(
    (db.$client.prepare(`SELECT id, title, mode, updated_at AS updatedAt FROM sessions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; title: string; mode: Mode; updatedAt: number }[]).map((s) => [s.id, s]),
  );
  const titleWords = (title: string) => words.filter((w) => title.toLowerCase().includes(w)).length;
  // bm25 is negative, lower is better; each query word in the title counts like a strong message match.
  const scored = ids.map((id) => {
    const hit = best.get(id);
    const session = sessions.get(id)!;
    return { id, hit, session, score: (hit?.score ?? 0) - 4 * titleWords(session.title) };
  });
  scored.sort((a, b) => a.score - b.score || b.session.updatedAt - a.session.updatedAt);
  return scored.slice(0, limit).map(({ id, hit, session }) => ({
    sessionId: id,
    messageId: hit?.messageId ?? null,
    mode: session.mode,
    date: isoDate(hit?.createdAt ?? session.updatedAt),
    title: session.title,
    snippet: clip(hit?.snippet ?? firstUserText(db, id), SNIPPET_CHARS),
  }));
}

function firstUserText(db: Db, sessionId: string): string {
  const row = db.$client.prepare(`SELECT search_text AS text FROM messages WHERE session_id = ? AND role = 'user' AND kind = 'normal' ORDER BY created_at LIMIT 1`).get(sessionId) as { text: string } | undefined;
  return row?.text ?? '';
}

export function chatSearchResult(query: string, hits: ChatHit[]): string {
  if (!hits.length) return `No past chats match "${query}". Try other words: synonyms, a name, or a more specific term.`;
  return formatChatHits(`${hits.length} past chat${hits.length === 1 ? '' : 's'} match "${query}" (best first). ChatRead with a session and message id shows the messages around a hit.`, hits);
}

export interface ChatReadOptions {
  userId: string;
  excludeSessionId: string;
  sessionId: string;
  around?: string;
  before?: number;
  after?: number;
}

/** Whether a session may be read by ChatRead for this person: theirs, top level, not temporary, not the asking one. */
export function readable(row: SessionRow | undefined, opts: Pick<ChatReadOptions, 'userId' | 'excludeSessionId'>): row is SessionRow {
  return !!row && row.userId === opts.userId && !row.parentSessionId && row.id !== opts.excludeSessionId && !isTemporary(row);
}

/** How a message reads in ChatRead: its text, and the tools it used as a line. */
function render(m: Message): string {
  const text = messageText(m.parts).trim();
  const tools = [...new Set(m.parts.flatMap((p) => (p.type === 'tool_call' ? [p.name] : [])))];
  const body = [text, tools.length ? `[used ${tools.join(', ')}]` : ''].filter(Boolean).join('\n');
  return body.length > CHAT_READ_MESSAGE_CHARS ? `${body.slice(0, CHAT_READ_MESSAGE_CHARS)}\n[… ${body.length - CHAT_READ_MESSAGE_CHARS} more characters left out]` : body;
}

/**
 * A window of at most CHAT_READ_MAX messages of the conversation's current branch: around `around` (`before` earlier
 * and `after` later ones), or from its start. Only the person's and the assistant's messages, each cut to
 * CHAT_READ_MESSAGE_CHARS.
 */
export async function readChat(repo: SessionRepo, opts: ChatReadOptions): Promise<{ text: string; isError?: boolean }> {
  const row = await repo.getRow(opts.sessionId);
  if (!readable(row, opts)) return { text: `There is no past chat "${opts.sessionId}" you can read. Use a session id from ChatSearch.`, isError: true };
  const all = (await repo.branch(row.id)).messages.filter((m) => m.kind === 'normal' && m.role !== 'tool' && render(m));
  const at = opts.around ? all.findIndex((m) => m.id === opts.around) : -1;
  let start: number;
  let end: number;
  if (at >= 0) {
    const before = Math.min(Math.max(0, opts.before ?? 2), CHAT_READ_MAX - 1);
    const after = Math.min(Math.max(0, opts.after ?? 3), CHAT_READ_MAX - 1 - before);
    start = Math.max(0, at - before);
    end = Math.min(all.length, at + after + 1);
  } else {
    start = 0;
    end = Math.min(all.length, Math.min(Math.max(1, opts.after ?? CHAT_READ_MAX), CHAT_READ_MAX));
  }
  const window = all.slice(start, end);
  const header = `Chat "${row.title || 'Untitled'}" (session: ${row.id}, ${row.mode}, ${isoDate(row.createdAt)}): messages ${window.length ? `${start + 1}–${end}` : 'none'} of ${all.length}.${opts.around && at < 0 ? ' The message asked for is not on this chat\'s current branch, so this starts at the beginning.' : ''}`;
  const more = end < all.length ? `\n\n[${all.length - end} later message${all.length - end === 1 ? '' : 's'}: call ChatRead again with around set to the last id above and before set to 0 to read on.]` : '';
  const body = window.map((m) => `### ${m.role === 'user' ? 'Person' : 'Assistant'} · ${isoDate(m.createdAt)} · id ${m.id}\n${render(m)}`).join('\n\n');
  return { text: `${header}\n\n${body}${more}` };
}
