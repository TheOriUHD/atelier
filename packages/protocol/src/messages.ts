/**
 * The internal conversation format shared by every provider adapter, the store and the UI.
 * Binary payloads never live in messages: images and documents reference the blob store by sha256.
 */
import { z } from 'zod';
import { Mode } from './settings.ts';

export const TextPart = z.object({ type: z.literal('text'), text: z.string() });
export const ImagePart = z.object({ type: z.literal('image'), mime: z.string(), blob: z.string() });
export const DocumentPart = z.object({ type: z.literal('document'), mime: z.string(), blob: z.string(), name: z.string() });
export const ThinkingPart = z.object({
  type: z.literal('thinking'),
  text: z.string(),
  /** Opaque provider data that must be replayed verbatim on later turns (signatures, encrypted reasoning). */
  replay: z.unknown().optional(),
  /** Provider type that produced `replay`; replay data is dropped when the session switches provider. */
  provider: z.string().optional(),
  redacted: z.boolean().optional(),
});
export const ToolCallPart = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  /** Set when the call spawned a subagent session. */
  childSessionId: z.string().optional(),
});
export const ToolResultPart = z.object({
  type: z.literal('tool_result'),
  callId: z.string(),
  content: z.array(z.discriminatedUnion('type', [TextPart, ImagePart])),
  isError: z.boolean().optional(),
});
/** A reply's quoted passage: at most this many characters, and this many passages to a message. */
export const QUOTE_MAX_CHARS = 4_000;
export const QUOTE_MAX_COUNT = 5;

/**
 * What a note stands for in the transcript, besides what it tells the model: the message a loop sent (`/loop`), a
 * background sub-agent that ended (which the model hears about on its own hidden turn), or a command the person ran.
 */
export const Notice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('loop'), loopId: z.string(), run: z.number().int().positive() }),
  z.object({
    kind: z.literal('agent'),
    taskId: z.string(),
    /** The sub-agent's task, as the model described it. */
    title: z.string(),
    status: z.enum(['done', 'failed', 'stopped']),
    /** The sub-agent's own session, for its transcript. */
    sessionId: z.string(),
  }),
  /** A command the person ran (`/compact`), shown as what they sent. It tells the model nothing. */
  z.object({ kind: z.literal('command'), command: z.string() }),
  /** On a compaction summary: roughly how many tokens it replaced more than it takes ("saved 666.2k tokens"). */
  z.object({ kind: z.literal('compaction'), saved: z.number().int().nonnegative() }),
  /**
   * A passage of an earlier message the person selected and replied to. The transcript shows it above their message;
   * the backend writes what the model is told from `text`.
   */
  z.object({ kind: z.literal('quote'), text: z.string().min(1).max(QUOTE_MAX_CHARS) }),
  /**
   * A message another agent sent this session with SendMessage: from another of the person's sessions, from the
   * session's parent (this is a sub-agent) or from one of its sub-agents (`taskId` names it). `text` is the message.
   */
  z.object({
    kind: z.literal('message'),
    from: z.object({
      sessionId: z.string(),
      title: z.string(),
      relation: z.enum(['session', 'parent', 'sub-agent']),
      mode: Mode,
      taskId: z.string().optional(),
    }),
    text: z.string(),
  }),
]);
export type Notice = z.infer<typeof Notice>;

/**
 * Hidden context delivered on a user turn instead of mutating the frozen system prompt. `state` records the facts the
 * note announced (permission mode, model, date …), so each branch of a conversation knows what it was told; a part
 * with only `state` and empty `text` isn't sent to the model. `notice` is how the transcript shows it, when it does.
 */
export const ContextPart = z.object({ type: z.literal('context'), text: z.string(), state: z.record(z.string(), z.string()).optional(), notice: Notice.optional() });

export const Part = z.discriminatedUnion('type', [
  TextPart,
  ImagePart,
  DocumentPart,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
  ContextPart,
]);
export type Part = z.infer<typeof Part>;
export type TextPart = z.infer<typeof TextPart>;
export type ImagePart = z.infer<typeof ImagePart>;
export type DocumentPart = z.infer<typeof DocumentPart>;
export type ThinkingPart = z.infer<typeof ThinkingPart>;
export type ToolCallPart = z.infer<typeof ToolCallPart>;
export type ToolResultPart = z.infer<typeof ToolResultPart>;
export type ContextPart = z.infer<typeof ContextPart>;

export const Role = z.enum(['user', 'assistant', 'tool']);
export type Role = z.infer<typeof Role>;

export const Usage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
  reasoning: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  tokensPerSecond: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const StopReason = z.enum(['end', 'tool_use', 'max_tokens', 'stop', 'refusal', 'error', 'aborted']);
export type StopReason = z.infer<typeof StopReason>;

export const MessageError = z.object({
  code: z.string(),
  message: z.string(),
  /** Settings deep link that fixes the problem, e.g. `settings/providers`. */
  fix: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type MessageError = z.infer<typeof MessageError>;

/** `context`: a hidden note on the person's side (Stop hook feedback), which isn't a turn of its own. */
export const MessageKind = z.enum(['normal', 'compaction_summary', 'context']);

export const Message = z.object({
  id: z.string(),
  sessionId: z.string(),
  parentId: z.string().nullable(),
  role: Role,
  parts: z.array(Part),
  /** `providerId/modelId` that produced an assistant message. */
  model: z.string().nullable(),
  usage: Usage.nullable(),
  stopReason: StopReason.nullable(),
  error: MessageError.nullable(),
  kind: MessageKind,
  /** For compaction summaries: the last message the summary covers. */
  summarizesThroughId: z.string().nullable(),
  createdAt: z.number(),
});
export type Message = z.infer<typeof Message>;

/** Plain text of the visible text parts, used for titles, search and copy. */
export function messageText(parts: readonly Part[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

/**
 * ExitPlanMode's result when the session isn't in plan mode: nothing needed approving, so the work goes on. Not an
 * error, and the transcript shows it as "Not in plan mode" rather than as a declined plan.
 */
export const PLAN_MODE_OFF = 'Plan mode is off, so this plan needs no approval: go ahead with the work.';
