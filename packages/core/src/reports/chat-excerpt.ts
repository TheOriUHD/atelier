/**
 * A chat attached to an issue report (ARCHITECTURE §26), shaped for debugging: every message with its tool calls,
 * results, thinking and context notes, as the conversation's active branch has them.
 *
 * A small chat goes whole. A long one keeps what a developer reads first and last: its first messages (the request
 * that started it), the latest compaction summary, and as many of the newest messages as fit, the newest in full and
 * older ones shortened; the gaps are named (`coverage.omitted`). Very long parts are cut in the middle, saying how much
 * was left out. Sub-agents a kept call started come along with their last few messages.
 *
 * Credentials and the words that name this computer are scrubbed from every string (`scrubSecrets`); pictures and files
 * stay out (only their type and name are told).
 */
import type { Message, Part, ReportChat, ReportMessage, ReportPart, Todo } from '@atelier/protocol';
import { REPORT_LIMITS } from '@atelier/protocol';
import { scrubSecrets, type PrivateWords } from './redact.ts';

/** What is kept of each kind of part, in characters. */
interface Caps {
  text: number;
  thinking: number;
  input: number;
  result: number;
  context: number;
}
const FULL: Caps = { text: 40_000, thinking: 6_000, input: 10_000, result: 16_000, context: 6_000 };
const SHORT: Caps = { text: 8_000, thinking: 1_000, input: 2_000, result: 3_000, context: 1_000 };
const CHILD: Caps = { text: 4_000, thinking: 0, input: 1_500, result: 2_000, context: 0 };

/** Bytes the chat may take: the part's limit, less room for the envelope around it. */
export const CHAT_BUDGET = REPORT_LIMITS.chatBytes - 200_000;
const HEAD_MESSAGES = 3;
const CHILD_MESSAGES = 6;

export interface ChildChat {
  title: string;
  mode: string;
  status: string;
  messages: Message[];
}

export interface ExcerptInput {
  session: { mode: string; title: string; model?: string | null; effort?: string | null; permissionMode?: string | null; status: string; createdAt: number; updatedAt: number; coop?: boolean };
  provider?: string | undefined;
  workspace?: { name: string; kind: string } | undefined;
  todos?: readonly Todo[] | undefined;
  usage?: Record<string, number | null> | undefined;
  /** The active branch, oldest first. */
  messages: readonly Message[];
  /** A sub-agent's session, or null when it is gone. */
  child?: (sessionId: string) => Promise<ChildChat | null>;
  words?: PrivateWords;
  budgetBytes?: number;
}

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** `text` at most `max` characters: its start and its end, and how much was left out between. */
export function cut(text: string, max: number): { text: string; cut?: number } {
  if (text.length <= max) return { text };
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const left = text.length - head - tail;
  return { text: `${text.slice(0, head)}\n… [${left.toLocaleString('en')} characters left out] …\n${text.slice(text.length - tail)}`, cut: left };
}

const json = (v: unknown): string => {
  try {
    return typeof v === 'string' ? v : (JSON.stringify(v, null, 1) ?? '');
  } catch {
    return String(v);
  }
};

function part(p: Part, caps: Caps, words: PrivateWords): ReportPart | null {
  const s = (t: string) => scrubSecrets(t, words);
  switch (p.type) {
    case 'text':
      return { type: 'text', ...cut(s(p.text), caps.text) };
    case 'thinking':
      if (!caps.thinking) return null;
      return { type: 'thinking', ...cut(s(p.text), caps.thinking), ...(p.redacted ? { redacted: true } : {}) };
    case 'tool_call':
      return { type: 'tool_call', id: p.id.slice(0, 120), name: p.name.slice(0, 120), ...(({ text, cut: n }) => ({ input: text, ...(n ? { cut: n } : {}) }))(cut(s(json(p.input)), caps.input)) };
    case 'tool_result': {
      const text = p.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
      const images = p.content.filter((c) => c.type === 'image').length + (p.generated?.length ?? 0);
      return { type: 'tool_result', callId: p.callId.slice(0, 120), ...cut(s(text), caps.result), ...(p.isError ? { isError: true } : {}), ...(images ? { images } : {}) };
    }
    case 'image':
      return { type: 'image', mime: p.mime.slice(0, 80) };
    case 'document':
      return { type: 'document', mime: p.mime.slice(0, 120), name: s(p.name.split(/[\\/]/).pop() ?? p.name).slice(0, 300) };
    case 'context':
      // A note that only records state (`text` empty) is not something anyone read.
      if (!p.text.trim() || !caps.context) return null;
      return { type: 'context', ...cut(s(p.text), caps.context) };
    default:
      return null;
  }
}

function message(m: Message, index: number, caps: Caps, words: PrivateWords): ReportMessage {
  const usage = m.usage ? Object.fromEntries(Object.entries(m.usage).filter(([, v]) => typeof v === 'number')) : undefined;
  return {
    index,
    role: m.role,
    kind: m.kind,
    createdAt: m.createdAt,
    ...(m.model ? { model: m.model.slice(0, 160) } : {}),
    ...(m.author ? { author: m.author.slice(0, 80) } : {}),
    ...(m.stopReason ? { stopReason: m.stopReason } : {}),
    ...(m.error ? { error: scrubSecrets(`${m.error.code}: ${m.error.message}`, words).slice(0, 2000) } : {}),
    ...(usage && Object.keys(usage).length ? { usage: usage as Record<string, number> } : {}),
    parts: m.parts
      .map((p) => part(p, caps, words))
      .filter((p): p is ReportPart => p !== null)
      .slice(0, 400),
  };
}

/** The gaps between kept indices, as `{from, to}` (inclusive). */
function gaps(kept: number[], total: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let next = 0;
  for (const i of kept) {
    if (i > next) out.push({ from: next, to: i - 1 });
    next = i + 1;
  }
  if (next < total) out.push({ from: next, to: total - 1 });
  return out;
}

export async function buildChatExcerpt(input: ExcerptInput): Promise<ReportChat> {
  const words = input.words ?? {};
  const budget = input.budgetBytes ?? CHAT_BUDGET;
  const all = input.messages;
  const full = all.map((m, i) => message(m, i, FULL, words));
  const sizes = full.map(bytes);
  const total = sizes.reduce((a, b) => a + b, 0);

  const kept = new Map<number, ReportMessage>();
  let used = 0;
  let shortened = 0;
  if (total <= budget) {
    full.forEach((m, i) => kept.set(i, m));
    used = total;
  } else {
    const take = (i: number, caps: Caps): boolean => {
      if (kept.has(i)) return true;
      const m = caps === FULL ? full[i]! : message(all[i]!, i, caps, words);
      const size = caps === FULL ? sizes[i]! : bytes(m);
      if (used + size > budget) return false;
      kept.set(i, m);
      used += size;
      if (caps !== FULL) shortened++;
      return true;
    };
    // The request that started it, in full; the start of the answer, shortened.
    if (!take(0, FULL)) take(0, SHORT);
    for (let i = 1; i < Math.min(HEAD_MESSAGES, all.length); i++) take(i, SHORT);
    // What the model was told about everything before it, the last time the chat was compacted.
    const summary = all.findLastIndex((m) => m.kind === 'compaction_summary');
    if (summary > 0) take(summary, SHORT);
    // The newest messages, in full until most of the room is used, then shortened, until nothing more fits.
    for (let i = all.length - 1; i >= HEAD_MESSAGES; i--) {
      if (kept.has(i)) continue;
      if (used < budget * 0.7 && take(i, FULL)) continue;
      if (!take(i, SHORT)) break;
    }
  }

  // Sub-agents started by kept calls: their last few messages, while there is room (at most a sixth of it).
  if (input.child) {
    let childRoom = Math.min(budget - used, budget / 6);
    for (const m of [...kept.values()].reverse()) {
      if (childRoom < 20_000) break;
      for (const p of m.parts) {
        const id = p.type === 'tool_call' ? all[m.index]!.parts.find((q) => q.type === 'tool_call' && q.id === p.id && q.childSessionId) : undefined;
        if (p.type !== 'tool_call' || !id || id.type !== 'tool_call' || !id.childSessionId) continue;
        const child = await input.child(id.childSessionId).catch(() => null);
        if (!child) continue;
        const start = Math.max(0, child.messages.length - CHILD_MESSAGES);
        const info = {
          title: scrubSecrets(child.title, words).slice(0, 300),
          mode: child.mode,
          status: child.status,
          messageCount: child.messages.length,
          messages: child.messages.slice(start).map((c, j) => message(c, start + j, CHILD, words)),
        };
        const size = bytes(info);
        if (size > childRoom) continue;
        p.child = info;
        childRoom -= size;
        used += size;
      }
    }
  }

  const indices = [...kept.keys()].sort((a, b) => a - b);
  const omitted = gaps(indices, all.length);
  const usage = input.usage ? Object.fromEntries(Object.entries(input.usage).filter((e): e is [string, number] => typeof e[1] === 'number')) : undefined;
  const s = input.session;
  return {
    session: {
      mode: s.mode,
      title: scrubSecrets(s.title, words).slice(0, 300),
      ...(s.model ? { model: s.model.slice(0, 160) } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      ...(input.workspace ? { workspace: { name: scrubSecrets(input.workspace.name, words).slice(0, 200), kind: input.workspace.kind } } : {}),
      ...(input.todos?.length ? { todos: input.todos.slice(0, 100).map((t) => ({ content: scrubSecrets(t.content, words).slice(0, 500), status: t.status })) } : {}),
      ...(usage && Object.keys(usage).length ? { usage } : {}),
      ...(s.coop ? { coop: true } : {}),
    },
    coverage: { total: all.length, included: indices.length, omitted: omitted.length > 8 ? [...omitted.slice(0, 7), { from: omitted[7]!.from, to: omitted.at(-1)!.to }] : omitted, shortened },
    messages: indices.map((i) => kept.get(i)!),
  };
}
