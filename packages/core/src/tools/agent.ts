/**
 * Agent (ARCHITECTURE §8): delegates a task to a sub-agent that runs as a child session with its own
 * context. The parent's tool call links to the child so the transcript can show its progress. With
 * `run_in_background` the call returns at once and the parent hears how the sub-agent ended later.
 */
import { textOutput, type Tool, type ToolOutput } from './types.ts';

export interface Delegation {
  description: string;
  prompt: string;
  subagentType: string;
  /** Return at once; the result reaches the parent as a note when the sub-agent ends. */
  background: boolean;
}

type Delegate = (parentSessionId: string, call: { messageId: string; callId: string }, task: Delegation, signal: AbortSignal) => Promise<ToolOutput>;

interface AgentInput {
  description: string;
  prompt: string;
  subagent_type: string;
  run_in_background?: boolean;
}

/** `agents`: definitions the person or project added, offered next to the built-in general-purpose agent. */
export function createAgentTool(delegate: Delegate, agents: { name: string; description: string }[] = []): Tool<AgentInput> {
  const kinds = [{ name: 'general-purpose', description: 'Any self-contained task, with your tools except asking the person questions and starting sub-agents.' }, ...agents];
  const types = `Sub-agent types:\n${kinds.map((k) => `- ${k.name}: ${k.description}`).join('\n')}`;
  return {
    name: 'Agent',
    // Sub-agents run in parallel; each of their own calls goes through the permission check.
    readOnly: true,
    description: ({ tier, has }) =>
      tier === 'compact'
        ? [
            'Starts a sub-agent for a big, self-contained task, such as a search across many files.',
            "- The sub-agent can't see this conversation: write a complete `prompt` that says what to find or do and what to report.",
            '- Only its final report comes back to you.',
            '',
            types,
          ].join('\n')
        : [
            'Hands a self-contained task to a sub-agent that works in its own context and returns one report.',
            '- Use it when substantial independent work genuinely benefits from parallel execution or an isolated review. A sub-agent repeats context and tool setup, so delegation must save more work than it adds. Prefer direct tools for quick tasks; never delegate merely to look busy.',
            `- Don't use it for a file you can name${has('Glob') || has('Grep') ? ', a definition Glob or Grep finds in one call' : ''}, a read of two files, or anything you already delegated.`,
            '- Agents started in one message run in parallel. Parallelize investigation and review, but make changes yourself or through one writing agent whose brief names the files it owns, so two agents never edit the same files.',
            "- `prompt` must be complete and self-contained, because the agent can't see this conversation: the goal and why, what is known or ruled out, the paths and lines involved, whether to change files or only investigate, and what to report and at what length.",
            "- Open the brief with the project and the agent's role. The agent gets the project's ATELIER.md and other instruction files as you do; point it to the notes files they link that bear on its task.",
            '- The report reaches only you. Tell the person what matters, and check edits an agent claims before you report them as done.',
            "- `run_in_background: true` starts the agent and returns at once, so you can go on working; its result arrives later as a note in this conversation, and a conversation that has gone quiet resumes for it. Use it when there is useful work to do meanwhile or for long investigations running side by side, and leave it off when your next step depends on the report. Until the note arrives you don't know what the agent found: don't guess, and don't wait for it with sleep or repeated checks. TaskStop with its task id stops it if you no longer need it.",
            '',
            types,
          ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', minLength: 1, maxLength: 80, description: 'A label of 3 to 5 words for the task, shown to the person.' },
        prompt: { type: 'string', minLength: 1, maxLength: 50_000, description: 'The complete, self-contained brief for the sub-agent.' },
        subagent_type: { type: 'string', minLength: 1, maxLength: 130, description: 'One of the sub-agent types listed in this description.' },
        run_in_background: { type: 'boolean', description: 'Return at once; the result arrives later as a note.' },
      },
      required: ['description', 'prompt', 'subagent_type'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (!input.prompt.trim()) return textOutput('The prompt is empty.', true);
      return delegate(
        ctx.sessionId,
        { messageId: ctx.messageId, callId: ctx.callId },
        { description: input.description, prompt: input.prompt, subagentType: input.subagent_type, background: input.run_in_background === true },
        ctx.signal,
      );
    },
  };
}
