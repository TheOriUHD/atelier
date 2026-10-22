/** TodoWrite (ARCHITECTURE §8): the session's task list, shown in the Tasks pane and kept across reloads. */
import type { Todo } from '@atelier/protocol';
import { textOutput, type DescribeContext, type Tool } from './types.ts';

function describe({ tier, mode, has }: DescribeContext): string {
  if (tier === 'compact') {
    return [
      'Sets the task list the person sees: only your own work, none of theirs. Send it whole each time.',
      '- One item `in_progress`; mark each `completed` once done.',
    ].join('\n');
  }
  return [
    'Keeps the task list for this session, which the person watches while you work.',
    '- Use it for work with three or more distinct steps, for several requests in one message, or for a plan that was just approved. Skip it for one small change or a question.',
    '- Send the whole list every time. Each item has `content` in the imperative ("Run the tests"), `activeForm` in the continuous form shown while it is under way ("Running the tests") and a `status`.',
    `- Keep exactly one item \`in_progress\` while you work${has('Agent') ? ' (one per track while sub-agents work on several at once)' : ''}. Mark an item \`completed\` as soon as it is done, not in batches.`,
    "- Completed means really done: not with failing tests, not half-built, not blocked. When something blocks an item, keep it open and add one that describes the blocker.",
    '- Add follow-up items you discover, and remove items that are no longer needed.',
    '- List only your own work. Never add an item for the person (testing, approving, deciding, installing); say what you need from them in your message instead.',
    ...(mode === 'work' ? ['- Make the last item a check of the deliverable.'] : []),
  ].join('\n');
}

export function createTodoWriteTool(save: (sessionId: string, todos: Todo[]) => Promise<void>): Tool<{ todos: Todo[] }> {
  return {
    name: 'TodoWrite',
    readOnly: false,
    description: describe,
    compactExample: { todos: [{ content: '<step>', activeForm: '<doing the step>', status: 'in_progress' }] },
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', minLength: 1, maxLength: 300, description: 'What to do, in the imperative ("Run the tests").' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string', maxLength: 300, description: 'The same step in the continuous form, shown while it is in progress ("Running the tests").' },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    async run({ todos }, ctx) {
      await save(ctx.sessionId, todos);
      ctx.emit({ type: 'todos', todos });
      const open = todos.filter((t) => t.status !== 'completed').length;
      return textOutput(open ? `Task list updated: ${open} of ${todos.length} open. Keep it current as you work.` : 'Task list updated: everything is done.');
    },
  };
}
