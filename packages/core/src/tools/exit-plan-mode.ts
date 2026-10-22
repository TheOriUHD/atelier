/**
 * ExitPlanMode (ARCHITECTURE §8): shows the plan for approval. Approving switches the session to the
 * mode the person picked; declining keeps it in plan mode with their feedback.
 */
import { PLAN_MODE_OFF, type PermissionAnswer, type PermissionMode, type PermissionRequest } from '@atelier/protocol';
import { textOutput, type DescribeContext, type Tool } from './types.ts';

export interface ExitPlanModeDeps {
  /** The session's effective permission mode. */
  mode(sessionId: string): Promise<PermissionMode | null>;
  approve(sessionId: string, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>;
  setMode(sessionId: string, mode: PermissionMode): Promise<void>;
}

/** The names the person sees in the mode picker. */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = { auto: 'Auto', default: 'Ask', acceptEdits: 'Accept edits', plan: 'Plan', bypassPermissions: 'Bypass' };

const APPROVAL_NOTES: Partial<Record<PermissionMode, string>> = {
  auto: 'Another model reviews your actions in place of the person and blocks the risky ones',
  acceptEdits: 'File edits are accepted automatically',
  default: 'Edits and commands still ask for approval',
};

const APPROVED = /^The person approved the plan; the permission mode is now (Auto|Ask|Accept edits)\./;

/** The mode an approval result announced, so context notes don't announce it again (agent/context-notes.ts). */
export function approvedMode(result: string): PermissionMode | null {
  const label = APPROVED.exec(result)?.[1];
  return (Object.entries(PERMISSION_MODE_LABELS).find(([, l]) => l === label)?.[0] as PermissionMode | undefined) ?? null;
}

function describe({ tier, has }: DescribeContext): string {
  if (tier === 'compact') return ['In plan mode, presents your plan and asks the person to approve it.', '- `plan`: Markdown with the files to change and how you will check the result.'].join('\n');
  return [
    'Presents your plan while plan mode is on and asks the person to approve it; approval switches the session to the permission mode they choose.',
    '- Use it only after investigating, and only for implementation plans, never for answers to research questions.',
    '- `plan` is Markdown: the goal, the approach, the files to change and what changes in each, existing code to reuse, and how you will verify the result.',
    ...(has('AskUser') ? ['- Ask open questions with AskUser before this call, not inside the plan.'] : []),
    '- If the person declines, the result carries their feedback: revise the plan and present it again.',
  ].join('\n');
}

export function createExitPlanModeTool(deps: ExitPlanModeDeps): Tool<{ plan: string }> {
  return {
    name: 'ExitPlanMode',
    readOnly: false,
    description: describe,
    inputSchema: {
      type: 'object',
      properties: { plan: { type: 'string', minLength: 1, maxLength: 20_000, description: 'The implementation plan, in Markdown.' } },
      required: ['plan'],
      additionalProperties: false,
    },
    async run({ plan }, ctx) {
      if ((await deps.mode(ctx.sessionId)) !== 'plan') return textOutput(PLAN_MODE_OFF);
      const answer = await deps.approve(
        ctx.sessionId,
        { callId: ctx.callId, toolName: 'ExitPlanMode', input: { plan }, reason: 'Approve the plan to start making changes.', suggestedRule: '' },
        ctx.signal,
      );
      if (answer.behavior === 'deny') {
        return textOutput(
          answer.message
            ? `The person wants changes to the plan: ${answer.message}\nStay in plan mode, revise the plan and present it again.`
            : 'The person did not approve the plan. Stay in plan mode and ask what to change.',
          true,
        );
      }
      const mode = answer.mode ?? 'default';
      await deps.setMode(ctx.sessionId, mode);
      return textOutput(
        `The person approved the plan; the permission mode is now ${PERMISSION_MODE_LABELS[mode]}. ${APPROVAL_NOTES[mode] ?? APPROVAL_NOTES.default}. ` +
          'Start implementing it, and keep the task list current.',
      );
    },
  };
}
