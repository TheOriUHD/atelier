/**
 * What a Code session's live status and context ring show while a reply streams (ARCHITECTURE §8): output tokens
 * estimated from the streamed characters with the model's calibrated characters per token, exact once a reply's usage
 * arrives, and the context window grown by the reply streaming now.
 */
import type { ContextUsage, Message, RunPhase } from '@atelier/protocol';
import { queuedLabel, type LiveSessionState } from '../../lib/live-session.ts';
import { PHASE_TEXTS } from '../chat/run-phase.tsx';
import { turnItems } from '../chat/turns.ts';

/** "980", "1.2k", "804.2k", "1M". */
export function formatTokenCount(n: number): string {
  const short = (value: number, unit: string) => `${+value.toFixed(1)}${unit}`;
  if (n >= 1_000_000) return short(n / 1_000_000, 'M');
  if (n >= 1000) return short(n / 1000, 'k');
  return String(Math.round(n));
}

export { formatElapsed } from '../chat/parts.tsx';

/** Characters a reply produced so far: text, thinking and tool input (still streaming or complete). */
function streamedChars(state: LiveSessionState, m: Message): number {
  return m.parts.reduce((n, p, i) => {
    if (p.type === 'text' || p.type === 'thinking') return n + p.text.length;
    if (p.type === 'tool_call') return n + (state.toolInputs[`${m.id}:${i}`]?.length ?? JSON.stringify(p.input ?? {}).length);
    return n;
  }, 0);
}

const charsPerToken = (state: LiveSessionState) => state.context?.charsPerToken ?? 4;

/** Providers whose streamed reasoning is the whole reasoning, so its characters match the tokens counted for it. */
const FULL_REASONING = new Set(['ollama', 'llamacpp']);

/**
 * Whether a finished reply's characters stand for all its output tokens: not when reasoning was hidden, summarized or
 * redacted (Anthropic's summaries, OpenAI's reasoning tokens), which the usage counts in full.
 */
function countsAllOutput(m: Message): boolean {
  if (m.usage?.reasoning) return false;
  return m.parts.every((p) => p.type !== 'thinking' || (!p.redacted && FULL_REASONING.has(p.provider ?? '')));
}

/**
 * Characters per output token for live estimates: from this session's finished replies (what streamed against the
 * output their usage reports) once they add up to 100 tokens, else the context's figure. That one is learned from
 * prompts, whose tool schemas tokenize differently: on Ollama gpt-oss-20b's replies ran 3.7 characters a token
 * against 5.1 for its prompts, so live counts came out about a quarter low. Kept between 1 and 8.
 */
function outputCharsPerToken(state: LiveSessionState): number {
  let chars = 0;
  let tokens = 0;
  for (const m of state.messages) {
    if (m.role !== 'assistant' || !m.usage || m.usage.output < 20 || m.id === state.streamingMessageId || !countsAllOutput(m)) continue;
    chars += streamedChars(state, m);
    tokens += m.usage.output;
  }
  return tokens >= 100 && chars > 0 ? Math.min(8, Math.max(1, chars / tokens)) : charsPerToken(state);
}

/** Tokens a reply produced: its usage once reported, estimated until then. */
function outputTokens(state: LiveSessionState, m: Message, perToken = outputCharsPerToken(state)): number {
  return m.usage ? m.usage.output : Math.ceil(streamedChars(state, m) / perToken);
}

/** The context window, plus the reply streaming now (the last `context` event counted everything before it). */
export function liveContext(state: LiveSessionState): ContextUsage | null {
  const { context } = state;
  const streaming = state.messages.find((m) => m.id === state.streamingMessageId);
  if (!context || !streaming || streaming.usage) return context;
  const extra = outputTokens(state, streaming);
  return { ...context, used: context.used + extra, categories: { ...context.categories, messages: context.categories.messages + extra } };
}

const TOOL_VERBS: Record<string, string> = {
  Bash: 'Running a command',
  BashOutput: 'Reading command output',
  Read: 'Reading',
  Glob: 'Searching',
  Grep: 'Searching',
  Write: 'Writing',
  Edit: 'Editing',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading the web',
  Agent: 'Running a sub-agent',
  TodoWrite: 'Planning',
  Skill: 'Loading a skill',
};

export interface LiveStatus {
  verb: string;
  /** The model's server is loading the model or reading the prompt: the verb is that phase's first text (it says more the longer it takes). */
  phase: RunPhase | null;
  retryAttempt?: number;
  /** When the person's request was sent (the turn's elapsed time counts from it). */
  since: number;
  /** Output tokens of the whole turn so far. */
  tokens: number;
  /** The turn ends in a run of tool calls: in the compact transcript its live line says what runs, not this one. */
  activity: boolean;
  /** Whether output tokens are counted (a compaction writes no reply to count). */
  counts: boolean;
  /** Requests ahead of this one on the model's server, or null when it isn't waiting in line. */
  queued: number | null;
  /** Tokens per second of this session's latest reply that reported its speed, null before the first. */
  rate: number | null;
  /**
   * The streaming reply has started its output and isn't finished: while its server sends nothing (Ollama holds a
   * tool call back until it's complete), the count can move on at `rate`.
   */
  generating: boolean;
  /** How full the model's window is, with the reply streaming now (what auto-compaction goes by); null before the first `context` event. */
  contextUsed: number | null;
  contextLimit: number | null;
}

/** The running verb, the turn's start and its output tokens; null while nothing runs or the run waits for the person. */
export function liveStatus(state: LiveSessionState): LiveStatus | null {
  if (state.session?.status !== 'running') return null;
  // A `/compact` just sent is the run's start, not the message of some earlier turn: its time, and no reply to count.
  const last = state.messages.at(-1);
  const command = last?.parts.some((p) => p.type === 'context' && p.notice?.kind === 'command') ? last : undefined;
  const start = state.messages.findLastIndex((m) => m.role === 'user' && m.kind === 'normal');
  const turn = state.messages.slice(start + 1);
  const perToken = outputCharsPerToken(state);
  const tokens = turn.reduce((n, m) => (m.role === 'assistant' ? n + outputTokens(state, m, perToken) : n), 0);
  const streaming = state.streamingMessageId ? turn.find((m) => m.id === state.streamingMessageId) : undefined;
  const generating = !!streaming && !streaming.usage && streamedChars(state, streaming) > 0;
  const phase = state.queued === null && !state.compacting ? state.phase : null;
  const activity = turnItems(turn).at(-1)?.kind === 'activity';
  const context = liveContext(state);
  const window = { contextUsed: context?.used ?? null, contextLimit: context?.limit ?? null };
  if (command) return { verb: 'Compacting conversation', phase: null, since: command.createdAt, tokens: 0, counts: false, queued: null, activity: false, rate: null, generating: false, ...window };
  return { verb: verb(state, turn), phase, retryAttempt: phase === 'retrying' ? state.retryAttempt : undefined, since: state.messages[start]?.createdAt ?? 0, tokens, counts: !state.compacting, queued: state.queued, activity, rate: replyRate(state.messages), generating, ...window };
}

function replyRate(messages: Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, usage } = messages[i]!;
    if (role !== 'assistant' || !usage) continue;
    const rate = usage.tokensPerSecond ?? (usage.durationMs ? (usage.output / usage.durationMs) * 1000 : 0);
    if (rate > 0) return rate;
  }
  return null;
}

function verb(state: LiveSessionState, turn: Message[]): string {
  if (state.queued !== null) return queuedLabel(state.queued);
  if (state.compacting) return 'Compacting conversation';
  if (state.phase) return PHASE_TEXTS[state.phase][0]!.text;
  const last = turn.at(-1);
  const part = last?.parts.at(-1);
  // Tool calls with no results yet are running, or their input is still streaming in.
  if (last?.role === 'assistant' && part?.type === 'tool_call') return TOOL_VERBS[part.name] ?? (part.name.startsWith('mcp__') ? 'Using a connector' : 'Working');
  if (last?.id === state.streamingMessageId && part?.type === 'text') return 'Writing';
  return 'Thinking';
}
