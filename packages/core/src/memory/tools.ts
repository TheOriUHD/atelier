/**
 * The memory tools (ARCHITECTURE › Memory): MemorySearch and MemoryView read the person's memory, MemoryUpdate changes
 * it, ChatSearch and ChatRead look into their past chats. Which a session gets is `memoryFor`'s decision.
 */
import { formatMemoryHits, isFixedMemorySection, MemorySection, MEMORY_DETAILS_MAX, MEMORY_SUMMARY_MAX, MEMORY_TITLE_MAX, type MemoryEntry } from '@atelier/protocol';
import { textOutput, type Tool } from '../tools/types.ts';
import { CHAT_READ_MAX, CHAT_SEARCH_DEFAULT, CHAT_SEARCH_MAX } from './chat-search.ts';

/** MemorySearch lists at most this many entries, each with this much of its details. */
export const MEMORY_SEARCH_MAX = 8;
const EXCERPT_CHARS = 300;
/** MemoryView shows at most this many entries at once. */
export const MEMORY_VIEW_MAX = 5;

export interface MemoryToolBackend {
  search(query: string): Promise<MemoryEntry[]>;
  view(ids: string[]): Promise<MemoryEntry[]>;
  update(input: MemoryUpdateInput, sessionId: string): Promise<{ text: string; isError?: boolean }>;
  chatSearch(query: string, limit: number, sessionId: string): Promise<string>;
  chatRead(input: ChatReadInput, sessionId: string): Promise<{ text: string; isError?: boolean }>;
}

export interface MemoryUpdateInput {
  op: 'create' | 'update' | 'delete';
  id?: string;
  section?: MemorySection;
  title?: string;
  summary?: string;
  details?: string;
  replace?: { old: string; new: string }[];
  remove?: string[];
  private_topic?: boolean;
}

export interface ChatReadInput {
  session_id: string;
  around?: string;
  before?: number;
  after?: number;
}

const excerpt = (text: string) => (text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text);

export function createMemorySearchTool(backend: MemoryToolBackend): Tool<{ query: string }> {
  return {
    name: 'MemorySearch',
    readOnly: true,
    description: ({ tier, has }) =>
      tier === 'compact'
        ? "Searches what you remember about the person (their memory) and returns matching entries with the start of their details."
        : [
            "Searches the person's memory: what you remember about them from earlier conversations.",
            `- Returns up to ${MEMORY_SEARCH_MAX} matching entries, best first: id, section, title, summary and the start of the details${has('MemoryView') ? '; MemoryView shows the full details' : ''}.`,
            '- Use it when something the person says may connect to what you know about them and the list in `<memory>` doesn\'t settle it. Short queries work best: a name, a topic, a word.',
          ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to look for.' } },
      required: ['query'],
      additionalProperties: false,
    },
    async run({ query }) {
      const hits = await backend.search(query);
      if (!hits.length) return textOutput(`No memories match "${query}".`);
      return textOutput(formatMemoryHits(`${hits.length} memor${hits.length === 1 ? 'y matches' : 'ies match'} "${query}":`, hits.map((h) => ({ ...h, body: excerpt(h.details) }))));
    },
  };
}

export function createMemoryViewTool(backend: MemoryToolBackend): Tool<{ ids: string[] }> {
  return {
    name: 'MemoryView',
    readOnly: true,
    description: `Shows the full details of up to ${MEMORY_VIEW_MAX} memory entries, by the ids \`<memory>\` or MemorySearch gave.`,
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MEMORY_VIEW_MAX, description: 'Entry ids.' } },
      required: ['ids'],
      additionalProperties: false,
    },
    async run({ ids }) {
      const entries = await backend.view([...new Set(ids)].slice(0, MEMORY_VIEW_MAX));
      if (!entries.length) return textOutput('None of these ids is a memory entry. Use ids from `<memory>` or MemorySearch.', true);
      const missing = ids.length - entries.length;
      return textOutput(
        formatMemoryHits(
          `${entries.length} memor${entries.length === 1 ? 'y' : 'ies'}${missing > 0 ? ` (${missing} of the ids matched none)` : ''}:`,
          entries.map((e) => ({ ...e, body: e.details || '(no details yet)' })),
        ),
      );
    },
  };
}

export function createMemoryUpdateTool(backend: MemoryToolBackend, explicitOnly: boolean): Tool<MemoryUpdateInput> {
  return {
    name: 'MemoryUpdate',
    readOnly: false,
    description: ({ tier }) => {
      const when = explicitOnly
        ? 'The person has turned off remembering on its own: use this only when they explicitly ask you to remember, change or forget something.'
        : 'Use it when the person tells you something lasting about themselves, how they want you to respond, their people or their projects, or asks you to remember or forget something. Not for small talk, one-off tasks or credentials.';
      if (tier === 'compact') return `Saves, changes or deletes one memory entry about the person. ${when}`;
      return [
        "Saves, changes or deletes one entry of the person's memory.",
        `- ${when}`,
        "- Sections: `preferences` (how they want you to respond) and `profile` (who they are, their work) are one entry each: update them by section, without an id. `topic` is a hobby or interest, `area` a larger endeavour of theirs (something they build or run), `person` someone in their life; `project` holds notes for this chat's project, when it is in one.",
        "- `create` needs section, title, summary and details; `update` needs the id (or the section, for preferences and profile): its `details` are the new facts to add, `replace` rewrites a line a newer fact supersedes (quote the old line), `remove` drops lines the person asked you to forget; `delete` needs the id. Update an existing entry rather than creating a second one about the same thing.",
        '- Details are one fact per line, written about the person ("Prefers metric units"), with the date when it is known. When something was wrong, add a line "CORRECTION: …".',
        '- Set `private_topic` for health, religious or political beliefs, sexuality, ethnicity or finances.',
        "- Don't announce routine saves; the person sees them in the conversation.",
      ].join('\n');
    },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['create', 'update', 'delete'] },
        id: { type: 'string', description: 'The entry to update or delete.' },
        section: { type: 'string', enum: [...MemorySection.options] },
        title: { type: 'string', maxLength: MEMORY_TITLE_MAX, description: 'A few words.' },
        summary: { type: 'string', maxLength: MEMORY_SUMMARY_MAX, description: 'One line saying what the entry is about.' },
        details: { type: 'string', maxLength: MEMORY_DETAILS_MAX, description: 'One fact per line: all of a new entry\'s, or the ones to add to an existing entry.' },
        replace: {
          type: 'array',
          items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'], additionalProperties: false },
          description: 'Lines a newer fact supersedes: the old line as it is, and the line that replaces it.',
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Lines to drop, only when the person asks to forget them.' },
        private_topic: { type: 'boolean' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (input.op === 'delete' && !input.id && !(input.section && isFixedMemorySection(input.section))) return textOutput('Deleting needs the id of the entry.', true);
      return toOutput(await backend.update(input, ctx.sessionId));
    },
  };
}

export function createChatSearchTool(backend: MemoryToolBackend): Tool<{ query: string; limit?: number }> {
  return {
    name: 'ChatSearch',
    readOnly: true,
    description: ({ tier, has }) =>
      tier === 'compact'
        ? `Searches the person's past conversations and returns up to ${CHAT_SEARCH_MAX} matches: session id, title, date and a short snippet.`
        : [
            "Searches the person's past conversations (not this one) by the words in them and in their titles.",
            `- Returns up to ${CHAT_SEARCH_MAX} conversations (default ${CHAT_SEARCH_DEFAULT}), best first, each with its session id, the id of the best-matching message, mode, date, title and a short snippet: not whole chats.${has('ChatRead') ? ' ChatRead shows the messages around a hit.' : ''}`,
            "- It matches words, not meaning: search a few times with short, different queries (a name, synonyms, the specific term, another language the person uses) instead of one long sentence.",
            '- Use it when the person refers to an earlier conversation or something you discussed before, or when one would clearly help.',
          ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'A few words to look for.' },
        limit: { type: 'integer', minimum: 1, maximum: CHAT_SEARCH_MAX },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run({ query, limit }, ctx) {
      return textOutput(await backend.chatSearch(query, limit ?? CHAT_SEARCH_DEFAULT, ctx.sessionId));
    },
  };
}

export function createChatReadTool(backend: MemoryToolBackend): Tool<ChatReadInput> {
  return {
    name: 'ChatRead',
    readOnly: true,
    description: [
      `Reads part of one of the person's past conversations: at most ${CHAT_READ_MAX} messages, each cut to a few thousand characters.`,
      '- `session_id` from ChatSearch; `around` a message id from it, with `before` and `after` messages around it (2 and 3 by default). Without `around` it reads from the start.',
      '- Read only what you need, and read on from the last id when the answer is further on.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        around: { type: 'string', description: 'A message id to read around.' },
        before: { type: 'integer', minimum: 0, maximum: CHAT_READ_MAX - 1 },
        after: { type: 'integer', minimum: 0, maximum: CHAT_READ_MAX },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      return toOutput(await backend.chatRead(input, ctx.sessionId));
    },
  };
}

const toOutput = (r: { text: string; isError?: boolean }) => textOutput(r.text, r.isError);
