/**
 * Auto mode (docs/ARCHITECTURE.md §8): a reviewing model decides the calls that would otherwise ask the person. It reads
 * the person's messages and the agent's earlier calls, never tool results, so a hostile file or page can't talk to it.
 */
import type { Message } from '@atelier/protocol';

/** Blocks in a row, and in all, after which Auto mode pauses and the person is asked again. */
export const BLOCKS_IN_A_ROW = 3;
export const BLOCKS_TOTAL = 20;

/** Calls that only look: left out of the review's history, as they change nothing. */
const LOOKUPS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'BashOutput', 'WebSearch', 'Time', 'Usage']);
const REQUESTS = 10;
const ACTIONS = 30;

export interface ReviewSubject {
  /** The person's messages: the top-level session's, where they write. */
  conversation: readonly Message[];
  /** The acting session's messages, when a sub-agent acts; its task is its first message. */
  agent?: readonly Message[] | undefined;
  call: { name: string; input: unknown };
  /** Why the engine sent it for review (a dangerous command's warning, a protected file). */
  reason: string;
  cwd: string | null;
}

/** Every tag escaped, not only Atelier's: nothing the agent wrote can close or forge one here. */
const escapeTags = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const said = (m: Message) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n').trim();

/** The review request: the person's words, what the agent did, and the call to judge. */
export function reviewInput({ conversation, agent, call, reason, cwd }: ReviewSubject): string {
  const requests = conversation.filter((m) => m.role === 'user' && m.kind === 'normal').map(said).filter(Boolean).slice(-REQUESTS);
  const task = agent?.find((m) => m.role === 'user');
  const actions = (agent ?? conversation)
    .flatMap((m) => (m.role === 'assistant' ? m.parts : []))
    .flatMap((p) => (p.type === 'tool_call' && !LOOKUPS.has(p.name) ? [`- ${p.name} ${clip(JSON.stringify(p.input ?? {}), 400)}`] : []))
    .slice(-ACTIONS);
  return [
    `<project>${escapeTags(cwd ?? 'none')}</project>`,
    `<person_messages>\n${requests.map((r) => `<message>${escapeTags(clip(r, 2000))}</message>`).join('\n')}\n</person_messages>`,
    ...(task ? [`<subagent_task>${escapeTags(clip(said(task), 2000))}</subagent_task>`] : []),
    `<earlier_actions>\n${escapeTags(actions.join('\n') || '(none)')}\n</earlier_actions>`,
    `<pending_action tool="${escapeTags(call.name)}">\n${escapeTags(clip(JSON.stringify(call.input ?? {}, null, 1), 8000))}\n</pending_action>`,
    `<note>${escapeTags(reason)}</note>`,
  ].join('\n\n');
}

/**
 * Hosted models get a wider reading of "asked for": an action the request clearly leads to counts. Local models keep the
 * stricter reading (their judgment is less reliable at small sizes).
 */
const HOSTED = new Set(['anthropic', 'openai', 'chatgpt', 'copilot']);
export function reviewLeniency(providerType: string): string {
  return HOSTED.has(providerType)
    ? "\nRead \"asked for\" broadly: an action the person's request clearly leads to (shipping what they asked to ship, pushing the branch they are working on, running the tool their task names) counts as asked, so allow it. Ask only when the request doesn't point to the action, and block as above.\n"
    : '';
}

export type Verdict = { decision: 'allow' } | { decision: 'ask'; reason: string } | { decision: 'block'; reason: string };

/** ALLOW, ASK or BLOCK with its reason; null when the reply is none of them. */
export function parseVerdict(reply: string): Verdict | null {
  const lines = reply.replace(/<think>[\s\S]*?<\/think>/g, '').split('\n').map((l) => l.trim().replace(/^[*`>"\s]+/, ''));
  const rest = (text: string) => text.replace(/[*`]+$/, '').trim();
  for (const line of lines) {
    if (/^ALLOW\b/i.test(line)) return { decision: 'allow' };
    const ask = /^ASK\b[\s:]*(.*)$/i.exec(line);
    if (ask) return { decision: 'ask', reason: rest(ask[1]!) };
    const block = /^BLOCK\b[\s:]*(.*)$/i.exec(line);
    if (block) return { decision: 'block', reason: rest(block[1]!) || 'No reason given.' };
  }
  return null;
}
