import type { Message, TextPart, ThinkingPart, ToolCallPart, ToolResultPart } from '@atelier/protocol';

/** How the transcript is laid out: each user message, then everything the assistant did until the next one. */
export type Turn =
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; messages: Message[] }
  | { kind: 'compaction'; message: Message };

export function groupTurns(messages: readonly Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const last = turns.at(-1);
    if (m.kind === 'compaction_summary') turns.push({ kind: 'compaction', message: m });
    else if (m.role === 'user') turns.push({ kind: 'user', message: m });
    else if (last?.kind === 'assistant') last.messages.push(m);
    else turns.push({ kind: 'assistant', messages: [m] });
  }
  return turns;
}

/** Tool results of a turn, keyed by the call they answer. */
export function toolResults(messages: readonly Message[]): Map<string, ToolResultPart> {
  const results = new Map<string, ToolResultPart>();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);
  return results;
}

/** A part of an assistant message, with what is needed to key it and tell whether it is still streaming. */
export interface PartRef<P> {
  key: string;
  message: Message;
  index: number;
  part: P;
}

export type ActivityStep = PartRef<ThinkingPart> | PartRef<ToolCallPart>;

/** An activity step as the transcript shows it: thinking (live or done) or a tool call with its result. */
export type ActivityStepView =
  | { kind: 'thinking'; key: string; text: string; active: boolean }
  | {
      kind: 'tool';
      key: string;
      call: ToolCallPart;
      result: ToolResultPart | undefined;
      running: boolean;
      since: number;
      /** Live output while it runs (Bash). */
      output: string | undefined;
    };

export interface RunState {
  /** The run is going (or waiting for the person). */
  busy: boolean;
  streamingMessageId: string | null;
  toolOutput: Record<string, string>;
}

/** Whether `ref` is the part currently streaming in. */
export const isStreaming = (ref: PartRef<unknown>, streamingMessageId: string | null) =>
  ref.message.id === streamingMessageId && ref.index === ref.message.parts.length - 1;

export function stepView(ref: ActivityStep, results: Map<string, ToolResultPart>, run: RunState): ActivityStepView {
  if (ref.part.type === 'thinking') return { kind: 'thinking', key: ref.key, text: ref.part.text, active: isStreaming(ref, run.streamingMessageId) };
  const result = results.get(ref.part.id);
  return {
    kind: 'tool',
    key: ref.key,
    call: ref.part,
    result,
    running: run.busy && !result,
    since: ref.message.createdAt,
    output: run.toolOutput[ref.part.id],
  };
}

export type TurnItem =
  | { kind: 'text'; ref: PartRef<TextPart> }
  | { kind: 'thinking'; ref: PartRef<ThinkingPart> }
  | { kind: 'artifact'; ref: PartRef<ToolCallPart> }
  | { kind: 'visual'; ref: PartRef<ToolCallPart> }
  /** A run of tool calls, with the thinking between them, shown as one collapsible summary. */
  | { kind: 'activity'; key: string; steps: ActivityStep[] }
  | { kind: 'error'; message: Message }
  /** The model provider ended the reply itself (its own content filter). */
  | { kind: 'refusal'; message: Message };

/** What an assistant turn renders, in order. Thinking only joins an activity run when the run has a tool call. */
export function turnItems(messages: readonly Message[]): TurnItem[] {
  const items: TurnItem[] = [];
  let run: ActivityStep[] = [];
  const flush = () => {
    if (run.some((s) => s.part.type === 'tool_call')) items.push({ kind: 'activity', key: run[0]!.key, steps: run });
    else for (const ref of run) items.push({ kind: 'thinking', ref: ref as PartRef<ThinkingPart> });
    run = [];
  };
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    message.parts.forEach((part, index) => {
      const key = `${message.id}:${index}`;
      if (part.type === 'thinking' || (part.type === 'tool_call' && part.name !== 'artifact' && part.name !== 'inline_visual'))
        run.push({ key, message, index, part } as ActivityStep);
      else if (part.type === 'tool_call') {
        flush();
        items.push({ kind: part.name === 'inline_visual' ? 'visual' : 'artifact', ref: { key, message, index, part } });
      } else if (part.type === 'text' && part.text.trim()) {
        flush();
        items.push({ kind: 'text', ref: { key, message, index, part } });
      }
    });
    if (message.error || message.stopReason === 'refusal') {
      flush();
      items.push({ kind: message.error ? 'error' : 'refusal', message });
    }
  }
  flush();
  return items;
}
