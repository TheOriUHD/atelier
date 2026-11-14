import type { ContextPart, ImageProgress, Message, Notice, TextPart, ThinkingPart, ToolCallPart, ToolResultPart } from '@atelier/protocol';

/** How the transcript is laid out: each user message, then everything the assistant did until the next one. */
export type Turn =
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; messages: Message[] }
  | { kind: 'compaction'; message: Message };

/**
 * A note that another agent's word reached the model (a message from a sub-agent, the parent or another session; a
 * background sub-agent that ended): part of the assistant's work, not something the person said. Its context part.
 */
export function agentNote(m: Message): (ContextPart & { notice: Extract<Notice, { kind: 'message' | 'agent' }> }) | null {
  if (m.role !== 'user' || !m.parts.length || !m.parts.every((p) => p.type === 'context')) return null;
  const part = m.parts.find((p): p is ContextPart => p.type === 'context' && (p.notice?.kind === 'message' || p.notice?.kind === 'agent'));
  return (part as (ContextPart & { notice: Extract<Notice, { kind: 'message' | 'agent' }> }) | undefined) ?? null;
}

export function groupTurns(messages: readonly Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const last = turns.at(-1);
    if (m.kind === 'compaction_summary') turns.push({ kind: 'compaction', message: m });
    // Messages between agents carry on the assistant's turn, as steps of its work, instead of splitting it.
    else if (last?.kind === 'assistant' && agentNote(m)) last.messages.push(m);
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

/** A step of a run of work: thinking, a tool call, or another agent's word reaching the model (`agentNote`). */
export type ActivityStep = PartRef<ThinkingPart> | PartRef<ToolCallPart> | PartRef<ContextPart>;

/** An activity step as the transcript shows it: thinking (live or done) or a tool call with its result. */
export type ActivityStepView =
  | { kind: 'thinking'; key: string; text: string; active: boolean }
  /** A message from another agent, or a background sub-agent that ended. */
  | { kind: 'notice'; key: string; notice: Extract<Notice, { kind: 'message' | 'agent' }> }
  | {
      kind: 'tool';
      key: string;
      call: ToolCallPart;
      result: ToolResultPart | undefined;
      running: boolean;
      since: number;
      /** Live output while it runs (Bash). */
      output: string | undefined;
      /** How far it is while it runs (GenerateImage). */
      progress?: ImageProgress | undefined;
    };

export interface RunState {
  /** The run is going (or waiting for the person). */
  busy: boolean;
  streamingMessageId: string | null;
  toolOutput: Record<string, string>;
  toolProgress?: Record<string, ImageProgress> | undefined;
}

/** Whether `ref` is the part currently streaming in. */
export const isStreaming = (ref: PartRef<unknown>, streamingMessageId: string | null) =>
  ref.message.id === streamingMessageId && ref.index === ref.message.parts.length - 1;

export function stepView(ref: ActivityStep, results: Map<string, ToolResultPart>, run: RunState): ActivityStepView {
  if (ref.part.type === 'thinking') return { kind: 'thinking', key: ref.key, text: ref.part.text, active: isStreaming(ref, run.streamingMessageId) };
  if (ref.part.type === 'context') return { kind: 'notice', key: ref.key, notice: ref.part.notice as Extract<Notice, { kind: 'message' | 'agent' }> };
  const result = results.get(ref.part.id);
  return {
    kind: 'tool',
    key: ref.key,
    call: ref.part,
    result,
    running: run.busy && !result,
    since: ref.message.createdAt,
    output: run.toolOutput[ref.part.id],
    progress: run.toolProgress?.[ref.part.id],
  };
}

export type TurnItem =
  | { kind: 'text'; ref: PartRef<TextPart> }
  | { kind: 'thinking'; ref: PartRef<ThinkingPart> }
  | { kind: 'artifact'; ref: PartRef<ToolCallPart> }
  | { kind: 'visual'; ref: PartRef<ToolCallPart> }
  /** A generated image: seen, not a step of the work, so it leaves the run in Chat, Code and Cowork alike. */
  | { kind: 'image'; ref: PartRef<ToolCallPart> }
  | { kind: 'video'; ref: PartRef<ToolCallPart> }
  | { kind: 'audio'; ref: PartRef<ToolCallPart> }
  /** A run of tool calls, with the thinking between them, shown as one collapsible summary. */
  | { kind: 'activity'; key: string; steps: ActivityStep[] }
  | { kind: 'error'; message: Message }
  /** The model provider ended the reply itself (its own content filter). */
  | { kind: 'refusal'; message: Message };

/** Tool calls the transcript shows as items of their own, not as steps of an activity run. */
const OWN_ITEM: Record<string, 'artifact' | 'visual' | 'image' | 'video' | 'audio'> = { artifact: 'artifact', inline_visual: 'visual', GenerateImage: 'image', GenerateVideo: 'video', GenerateAudio: 'audio' };

/**
 * Whether a thought says anything: not empty (an encrypted one has no text), and more than a lone heading such as
 * "**Preparing backup access**", which some providers send as the whole summary of a step. Rows of those only filled
 * the list.
 */
export function hasThought(text: string): boolean {
  const plain = text.replace(/[*_#`>]/g, ' ').trim();
  if (!plain) return false;
  const lines = plain.split('\n').filter((l) => l.trim());
  return lines.length > 1 || plain.split(/\s+/).length > 8;
}

/** What an assistant turn renders, in order. Thinking only joins an activity run when the run has a tool call. */
export function turnItems(messages: readonly Message[]): TurnItem[] {
  const items: TurnItem[] = [];
  let run: ActivityStep[] = [];
  const flush = () => {
    if (run.some((s) => s.part.type === 'tool_call' || s.part.type === 'context')) items.push({ kind: 'activity', key: run[0]!.key, steps: run });
    else for (const ref of run) items.push({ kind: 'thinking', ref: ref as PartRef<ThinkingPart> });
    run = [];
  };
  const last = messages.at(-1);
  for (const message of messages) {
    const note = agentNote(message);
    if (note) {
      run.push({ key: `${message.id}:${message.parts.indexOf(note)}`, message, index: message.parts.indexOf(note), part: note });
      continue;
    }
    if (message.role !== 'assistant') continue;
    message.parts.forEach((part, index) => {
      const key = `${message.id}:${index}`;
      // A thought that says nothing is left out, unless it is the newest part (it may still be coming in).
      if (part.type === 'thinking' && !hasThought(part.text) && !(message === last && index === message.parts.length - 1)) return;
      const own = part.type === 'tool_call' && Object.hasOwn(OWN_ITEM, part.name) ? OWN_ITEM[part.name] : undefined;
      if (part.type === 'thinking' || (part.type === 'tool_call' && !own)) run.push({ key, message, index, part } as ActivityStep);
      else if (part.type === 'tool_call') {
        flush();
        items.push({ kind: own!, ref: { key, message, index, part } });
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
