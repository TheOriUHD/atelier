/**
 * TaskStop: stops the conversation's background tasks by id (one, several, or all that are running): a command Bash started with
 * `run_in_background` (its ID), a sub-agent started with `run_in_background` (the task id its start reported) or a loop.
 * KillShell does the same for commands alone.
 */
import { textOutput, type DescribeContext, type Tool } from './types.ts';

export interface TaskStopDeps {
  /** What the id names and whether it ran: null when no such task exists, else its title and its status before the stop. */
  stop(sessionId: string, taskId: string): Promise<{ title: string; wasRunning: boolean } | null>;
  /** The ids of the conversation's running tasks: what `all` stops, and what the refusal that names a wrong id lists. */
  running(sessionId: string): Promise<string[]>;
}

function describe({ tier }: DescribeContext): string {
  if (tier === 'compact') return 'Stops background tasks by ID: one (`task_id`), several (`task_ids`) or every running one (`all`).';
  return [
    'Stops background tasks of this conversation: commands started with Bash `run_in_background`, sub-agents started with the Agent tool\'s `run_in_background`, and loops.',
    '- `task_id` is the ID the start reported (`exec-3`, or the task id of the sub-agent). `task_ids` takes several at once, and `all: true` stops every task that is still running: one call, not one per task.',
    '- Use it for work you no longer need, such as a dev server once the task is done, sub-agents whose question was answered another way, or everything when the person tells you to stop the background work. A stopped sub-agent sends no report.',
  ].join('\n');
}

export interface TaskStopInput {
  task_id?: string;
  task_ids?: string[];
  all?: boolean;
}

export function createTaskStopTool(deps: TaskStopDeps): Tool<TaskStopInput> {
  return {
    name: 'TaskStop',
    readOnly: false,
    description: describe,
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, task_ids: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } },
      additionalProperties: false,
    },
    compactExample: { task_id: 'exec-3' },
    async run({ task_id, task_ids, all }, ctx) {
      const running = await deps.running(ctx.sessionId);
      const named = [task_id, ...(task_ids ?? [])].map((id) => id?.trim()).filter((id): id is string => !!id);
      const ids = [...new Set(all ? [...running, ...named] : named)];
      if (!ids.length) {
        if (all) return textOutput('No background task is running.');
        return textOutput('Name the task to stop with `task_id` or `task_ids`, or pass `all: true` to stop every running one.', true);
      }
      const results = await Promise.all(ids.map(async (id) => ({ id, stopped: await deps.stop(ctx.sessionId, id) })));
      const lines = results.map(({ id, stopped }) => {
        if (!stopped) return `There is no background task ${id}. ${running.length ? `Running: ${running.join(', ')}.` : 'None is running.'}`;
        return stopped.wasRunning ? `Stopped ${stopped.title}.` : `${stopped.title} had already ended.`;
      });
      return textOutput(lines.join('\n'), results.every((r) => !r.stopped));
    },
  };
}
