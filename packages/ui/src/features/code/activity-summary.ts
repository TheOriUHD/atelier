/**
 * Code's compact transcript (design/components.md › Code activity): a running run of tool calls reads as what it does
 * right now ("Creating launch.json"); a finished one as its summary (`activitySummary` in tool-cards.tsx).
 */
import type { ActivityStepView } from '../chat/turns.ts';
import { displayPath } from './paths.ts';

type ToolView = Extract<ActivityStepView, { kind: 'tool' }>;

/** Calls that keep their own card in the compact transcript: a plan to read, a sub-agent to follow, memory steps with their links. */
export const OWN_CARD = new Set(['ExitPlanMode', 'Agent', 'MemorySearch', 'MemoryView', 'MemoryUpdate', 'ChatSearch', 'ChatRead']);

const input = (step: ToolView) => (step.call.input && typeof step.call.input === 'object' ? (step.call.input as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Calls in the run that failed: an error result, or a command that exited with another code than 0. */
export function failedCount(steps: readonly ActivityStepView[]): number {
  return steps.filter((step) => {
    if (step.kind !== 'tool' || !step.result) return false;
    if (step.result.isError) return true;
    if (step.call.name !== 'Bash') return false;
    const result = step.result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    const exit = /\n\nExit code (-?\d+)\.$/m.exec(result);
    return !!exit && exit[1] !== '0';
  }).length;
}

/** What a running run of calls is doing now: the step still running, else the latest one. */
export function activityLabel(steps: readonly ActivityStepView[], root: string | null): string {
  const step = steps.findLast((s) => s.kind === 'tool' && s.running) ?? steps.at(-1);
  if (!step) return 'Working';
  if (step.kind === 'thinking') return 'Thinking';
  const args = input(step);
  const path = () => displayPath(text(args.file_path), root);
  switch (step.call.name) {
    case 'Bash':
      return text(args.description) || 'Running a command';
    case 'Read':
      return `Reading ${path()}`;
    case 'Write':
      return `Creating ${path()}`;
    case 'Edit':
      return `Editing ${path()}`;
    case 'Glob':
    case 'Grep':
      return `Searching for ${text(args.pattern)}`;
    case 'WebFetch':
      return `Fetching ${text(args.url)}`;
    case 'WebSearch':
      return 'Searching the web';
    case 'TodoWrite':
      return 'Updating the task list';
    case 'Skill':
      return 'Loading a skill';
    case 'AskUser':
      return 'Asking a question';
    case 'BashOutput':
      return 'Checking a command';
    case 'KillShell':
      return 'Stopping a command';
    case 'TaskStop':
      return 'Stopping a background task';
    case 'ChangeDirectory':
      return 'Changing folder';
    case 'SendMessage':
      return `Messaging ${messageTargetKind(text(args.to))}`;
    case 'ListSessions':
      return 'Looking up sessions';
    case 'Time':
      return 'Checking the time';
    case 'Usage':
      return 'Checking usage';
    default:
      return step.call.name.startsWith('mcp__') ? 'Using a connector' : `Using ${step.call.name}`;
  }
}

/** Who a SendMessage call writes to, from its `to`: "parent", a sub-agent's task id, or a session id. */
export function messageTargetKind(to: string): string {
  return to === 'parent' ? 'the parent session' : to.startsWith('agent:') ? 'a sub-agent' : 'another session';
}
