/**
 * Summarizing for compaction (ARCHITECTURE §8). The summarizer may be a small model with a smaller window than the
 * conversation: the transcript then goes in chunks that fit, and the chunk summaries are merged (map-reduce).
 */
import { escapeTags, type Message, type Todo } from '@atelier/protocol';
import { headTail } from './context.ts';

/** Room for the instructions and the request's framing around the transcript, in tokens. */
const PROMPT_MARGIN_TOKENS = 512;
/** How much of one tool call, result or note the summarizer reads (an error's end, where the message usually is). */
const CALL_CHARS = 1_000;
const RESULT_CHARS = 2_000;
const NOTE_CHARS = 1_000;
/** Merge rounds before giving up (each at least halves the summaries). */
const MAX_ROUNDS = 6;

export interface Summarizer {
  contextLength: number;
  charsPerToken: number;
  complete(user: string, maxOutputTokens: number): Promise<string>;
}

/** A message as the summarizer reads it: tool calls and results shortened (stored history keeps them whole). */
export function renderForSummary(m: Message): string {
  const role = m.kind === 'compaction_summary' ? 'Earlier summary' : m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Tool';
  const short = (text: string, max: number) => headTail(text, max, (cut) => `[… ${cut} characters left out …]`);
  const body = m.parts
    .map((p) => {
      switch (p.type) {
        // Results were escaped when they were stored; text quoted from a page or a file can't end the transcript either.
        case 'text':
          return escapeTags(p.text);
        case 'tool_call': {
          // Keep the explanation, not executable HTML, in compaction and side-chat context.
          const input = p.name === 'inline_visual' && p.input && typeof p.input === 'object'
            ? { title: (p.input as Record<string, unknown>).title, description: (p.input as Record<string, unknown>).description }
            : p.input ?? {};
          return `[called ${p.name} ${short(JSON.stringify(input), CALL_CHARS)}]`;
        }
        case 'tool_result': {
          const text = p.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join(' ');
          return p.isError ? `[result (error): ${text.length > RESULT_CHARS ? `[…] ${text.slice(-RESULT_CHARS)}` : text}]` : `[result: ${short(text, RESULT_CHARS)}]`;
        }
        case 'image':
          return '[image]';
        case 'document':
          return `[document ${p.name}]`;
        case 'context': {
          // A loaded skill is re-attached after the summary (context-notes.ts), so its name is enough here.
          const skill = /^<skill name="([^"]+)">/.exec(p.text)?.[1];
          if (skill) return `[skill ${skill} loaded]`;
          return p.text ? `[note: ${short(p.text, NOTE_CHARS)}]` : '';
        }
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
  return `${role}: ${body}`;
}

/** What a long task needs to carry on after compaction, given to the summarizer and appended to its summary verbatim. */
export interface CarriedState {
  /** The person's latest request, unless it stays verbatim after the summary. */
  request: string | null;
  todos: Todo[];
  /** Files written or edited in the session. */
  files: string[];
  /** Skills loaded among the summarized messages. */
  skills: string[];
}

export function renderState(state: CarriedState): string {
  const sections: string[] = [];
  if (state.request) sections.push(`### The person's current request (verbatim)\n${state.request}`);
  if (state.todos.length) {
    const mark = { completed: '[x]', in_progress: '[~] (in progress)', pending: '[ ]' } as const;
    sections.push(`### Todo list\n${state.todos.map((t) => `- ${mark[t.status]} ${t.content}`).join('\n')}`);
  }
  if (state.files.length) sections.push(`### Files changed in this session\n${state.files.map((f) => `- ${f}`).join('\n')}`);
  if (state.skills.length) sections.push(`### Skills loaded earlier (load them again with the Skill tool when needed)\n${state.skills.map((s) => `- ${s}`).join('\n')}`);
  return sections.join('\n\n');
}

/**
 * Summarizes `blocks` (rendered messages, oldest first). `state` joins every request that produces the final summary.
 * `scale` below 1 makes chunks smaller (a retry after the summarizer rejected one).
 */
export async function summarize(s: Summarizer, blocks: string[], state: string, maxOutputTokens: number, scale = 1): Promise<string> {
  const stateBlock = state ? `<state>\n${state}\n</state>\n\n` : '';
  const budget = Math.floor((s.contextLength - maxOutputTokens - PROMPT_MARGIN_TOKENS) * s.charsPerToken * scale) - stateBlock.length;
  if (budget < 1_000) throw new Error('The summarizing model’s context window is too small.');
  const chunks = pack(blocks, budget);
  if (chunks.length === 1) return s.complete(`<transcript>\n${chunks[0]}\n</transcript>\n\n${stateBlock}Write the summary now.`, maxOutputTokens);
  let partials: string[] = [];
  for (const [i, chunk] of chunks.entries()) {
    partials.push(
      await s.complete(
        `<transcript part="${i + 1}" of="${chunks.length}">\n${chunk}\n</transcript>\n\nThis is part ${i + 1} of ${chunks.length} of the conversation, oldest first. Summarize this part.`,
        maxOutputTokens,
      ),
    );
  }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const groups = pack(
      partials.map((p, i) => `<summary part="${i + 1}">\n${p}\n</summary>`),
      budget,
    );
    if (groups.length >= partials.length && partials.length > 1) throw new Error('The partial summaries are too long to merge.');
    partials = [];
    for (const group of groups) {
      partials.push(await s.complete(`<partial-summaries>\n${group}\n</partial-summaries>\n\n${stateBlock}Merge these summaries of consecutive parts of one conversation into one summary.`, maxOutputTokens));
    }
    if (partials.length === 1) return partials[0]!;
  }
  throw new Error('The partial summaries are too long to merge.');
}

/** Consecutive blocks joined into chunks of at most `max` characters; a block longer than that alone is shortened. */
function pack(blocks: string[], max: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const raw of blocks) {
    const block = headTail(raw, max, (cut) => `[… ${cut} characters left out …]`);
    if (current && current.length + 2 + block.length > max) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) chunks.push(current);
  return chunks;
}
