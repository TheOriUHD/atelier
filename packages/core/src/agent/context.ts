/**
 * Context accounting (ARCHITECTURE §8): how much of the model's window a request fills, by category. Exact where the
 * provider reported usage, estimated for what came after with characters per token learned per model. Plus the
 * transformations that keep a request inside the window; they only change what is sent, never stored history.
 */
import type { ContextUsage, Message, Part } from '@atelier/protocol';
import { isSkillList } from '../extensions/skills.ts';
import type { SystemBlock, ToolDef } from '../providers/types.ts';

export const DEFAULT_CHARS_PER_TOKEN = 4;
/** An image or PDF counts as about what providers charge for a page. */
const MEDIA_CHARS = 1_500 * DEFAULT_CHARS_PER_TOKEN;
/** Role markers and separators around each message. */
const MESSAGE_OVERHEAD_CHARS = 12;

type Categories = ContextUsage['categories'];
type Fixed = Omit<Categories, 'messages'>;

/** Room kept free for the reply: its token cap, at most a quarter of the window and 20k. */
export function outputReserve(contextLength: number, maxOutputTokens: number): number {
  return Math.min(maxOutputTokens, Math.floor(contextLength / 4), 20_000);
}

/** Auto-compaction starts above `autoCompactAt` of the window, or earlier when the reply would not fit otherwise. */
export function compactThreshold(contextLength: number, autoCompactAt: number, reserve: number): number {
  return Math.floor(Math.min(contextLength * autoCompactAt, contextLength - reserve));
}

/**
 * Whether a provider's token count can be right for that many characters. Ollama reports only the prompt tokens it
 * had to evaluate (prompt cache hits are left out), which shows up as far too many characters per token.
 */
function plausible(chars: number, tokens: number): boolean {
  return tokens >= 100 && chars / tokens >= 1 && chars / tokens <= 5;
}

/** Characters per token, learned per model from usage reports and smoothed; 4 until the first one. */
export class Calibration {
  private factors = new Map<string, number>();

  charsPerToken(model: string): number {
    return this.factors.get(model) ?? DEFAULT_CHARS_PER_TOKEN;
  }

  /** The provider counted a request of `chars` characters as `tokens`; false when that count can't be right. */
  observe(model: string, chars: number, tokens: number): boolean {
    if (!plausible(chars, tokens)) return false;
    const previous = this.factors.get(model);
    this.factors.set(model, previous === undefined ? chars / tokens : previous * 0.7 + (chars / tokens) * 0.3);
    return true;
  }
}

/**
 * Budgets that scale with `room`, the tokens the conversation has below the threshold once the system prompt and
 * tools are in. A tail holds the newest round of tool calls; after a compaction the summary and the tail take at most
 * 60% of the room.
 */
export function roomBudgets(room: number): { resultChars: number; tailChars: number; summaryTokens: number } {
  const clamp = (value: number, min: number, max: number) => Math.floor(Math.min(max, Math.max(min, value)));
  return {
    /** A tool result longer than this keeps its start and end in what is sent. */
    resultChars: clamp(room * 0.3, 500, 25_000) * DEFAULT_CHARS_PER_TOKEN,
    /** The newest messages auto-compaction keeps verbatim. */
    tailChars: clamp(room * 0.35, 0, 20_000) * DEFAULT_CHARS_PER_TOKEN,
    summaryTokens: clamp(room * 0.25, 256, 8_000),
  };
}

/** A request's size in characters: the fixed parts by category, and each message. */
export interface RequestSize {
  fixed: Fixed;
  messages: number[];
}

export function requestSize(system: SystemBlock[], tools: ToolDef[], messages: Message[]): RequestSize {
  const fixed: Fixed = { systemPrompt: 0, systemTools: 0, mcpTools: 0, skills: 0 };
  for (const b of system) fixed[isSkillList(b.text) ? 'skills' : 'systemPrompt'] += b.text.length;
  for (const t of tools) fixed[t.name.startsWith('mcp__') ? 'mcpTools' : 'systemTools'] += JSON.stringify(t).length;
  return { fixed, messages: messages.map(messageChars) };
}

export function requestChars(size: RequestSize): number {
  return sum(Object.values(size.fixed)) + sum(size.messages);
}

export function messageChars(m: Message): number {
  return m.parts.reduce((n, p) => n + partChars(p), MESSAGE_OVERHEAD_CHARS);
}

function partChars(p: Part): number {
  switch (p.type) {
    case 'text':
    case 'context':
      return p.text.length;
    case 'thinking':
      return p.redacted ? 0 : p.text.length;
    case 'tool_call':
      return p.name.length + JSON.stringify(p.input ?? {}).length;
    case 'tool_result':
      return p.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : MEDIA_CHARS), 0);
    case 'image':
    case 'document':
      return MEDIA_CHARS;
  }
}

/**
 * The tokens a request (`messages`, as sent) takes. Anchored on the newest reply in it with a plausible usage report:
 * the provider's count of everything up to that reply, plus the reply, plus estimates for what came after. Estimated
 * throughout without one, or with `exact` when the provider just counted the whole request.
 */
export function contextUsage(
  size: RequestSize,
  messages: Message[],
  opts: { model: string; charsPerToken: number; limit: number; threshold: number; exact?: number },
): ContextUsage {
  const tokens = (chars: number) => Math.ceil(chars / opts.charsPerToken);
  const fixedChars = sum(Object.values(size.fixed));
  let used = opts.exact ?? tokens(fixedChars + sum(size.messages));
  // Replies older than the summary that starts the history were counted with what it replaced.
  const since = messages[0]?.kind === 'compaction_summary' ? messages[0].createdAt : 0;
  const anchor = opts.exact === undefined ? messages.findLastIndex((m) => m.role === 'assistant' && m.usage && m.model === opts.model && m.createdAt > since) : -1;
  if (anchor >= 0) {
    const usage = messages[anchor]!.usage!;
    const input = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (plausible(fixedChars + sum(size.messages.slice(0, anchor)), input)) used = input + usage.output + tokens(sum(size.messages.slice(anchor + 1)));
  }
  const fixed: Fixed = {
    systemPrompt: tokens(size.fixed.systemPrompt),
    systemTools: tokens(size.fixed.systemTools),
    mcpTools: tokens(size.fixed.mcpTools),
    skills: tokens(size.fixed.skills),
  };
  const fixedTokens = sum(Object.values(fixed));
  used = Math.max(used, fixedTokens);
  return {
    used,
    limit: opts.limit,
    threshold: opts.threshold,
    categories: { ...fixed, messages: used - fixedTokens },
    charsPerToken: Math.round(opts.charsPerToken * 100) / 100,
  };
}

/** Keeps the start and the end of an over-long text, with `note(cut)` where the middle was. */
export function headTail(text: string, max: number, note: (cut: number) => string): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n${note(cut)}\n${tail > 0 ? text.slice(-tail) : ''}`;
}

const cutNote = (cut: number) =>
  `[… ${cut.toLocaleString('en-US')} characters cut here to fit the context window. The full output is kept; to see the cut part, run the tool again on a narrower range (Read with offset and limit, Grep, a more specific command).]`;

/** Tool results longer than `maxChars` keep their start and end in what is sent. */
export function capToolResults(messages: Message[], maxChars: number): Message[] {
  return messages.map((m) => {
    if (m.role !== 'tool' || !m.parts.some((p) => p.type === 'tool_result' && p.content.some((c) => c.type === 'text' && c.text.length > maxChars))) return m;
    const parts = m.parts.map((p) =>
      p.type === 'tool_result' ? { ...p, content: p.content.map((c) => (c.type === 'text' ? { ...c, text: headTail(c.text, maxChars, cutNote) } : c)) } : p,
    );
    return { ...m, parts };
  });
}

const STUB = '[Output left out to fit the context window. Run the tool again if you need it.]';

/**
 * The last resort when summarizing can't free enough: the oldest tool results (never the newest round) become a short
 * stub in what is sent, until `excessChars` are saved or none are left.
 */
export function stubOldResults(messages: Message[], excessChars: number): Message[] {
  const newest = messages.findLastIndex((m) => m.role === 'tool');
  let left = excessChars;
  return messages.map((m, i) => {
    if (left <= 0 || m.role !== 'tool' || i === newest) return m;
    const parts = m.parts.map((p) => {
      if (p.type !== 'tool_result') return p;
      left -= partChars(p) - STUB.length;
      return { ...p, content: [{ type: 'text' as const, text: STUB }] };
    });
    return { ...m, parts };
  });
}

/**
 * Where the verbatim tail of a compaction starts: the newest messages within `budgetChars`, beginning where a request
 * can (not at a tool result, which needs its call). The last `keep` messages stay whatever their size.
 */
export function tailStart(messages: Message[], budgetChars: number, keep = 0): number {
  let start = messages.length;
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    chars += messageChars(messages[i]!);
    if (chars > budgetChars && i < messages.length - keep) break;
    if (messages[i]!.role !== 'tool' && messages[i]!.kind !== 'compaction_summary') start = i;
  }
  return start;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
