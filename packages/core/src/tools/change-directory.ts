/**
 * ChangeDirectory: the session moves to another folder and goes on, one conversation. The person is always asked
 * (it grants access to a folder), also in Bypass; they may correct the path or pick the folder themselves.
 */
import type { PermissionAnswer, PermissionRequest } from '@atelier/protocol';
import { textOutput, type DescribeContext, type Tool } from './types.ts';

export interface ChangeDirectoryDeps {
  approve(sessionId: string, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>;
  /** The folder the session works in and the SSH host it lives on (null on this computer). */
  current(sessionId: string): Promise<{ root: string; host: string | null }>;
  /** Moves the session; what the model needs to know about the new folder. Throws an Error whose message is for the person. */
  move(sessionId: string, path: string): Promise<string>;
}

function describe({ tier }: DescribeContext): string {
  if (tier === 'compact') return 'Moves this session to another folder, after the person agrees.';
  return [
    'Moves this session to another folder and carries on there, in the same conversation. The person is asked first and may correct the folder or pick one themselves.',
    "- Use it when the work belongs in a different project or folder than the one you are in, for example to continue in a sibling repository. It doesn't copy anything: files stay where they are.",
    '- `path` is the folder (absolute, `~/…`, or relative to the current folder). Leave it out to ask the person to choose.',
    '- Afterwards the Read, Write, Edit, Bash and search tools work in the new folder, and the result tells you what it holds.',
  ].join('\n');
}

export function createChangeDirectoryTool(deps: ChangeDirectoryDeps): Tool<{ path?: string; reason?: string }> {
  return {
    name: 'ChangeDirectory',
    readOnly: false,
    description: describe,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The folder to move to; leave out to let the person choose.' },
        reason: { type: 'string', description: 'Why the work belongs there, in a sentence the person reads.' },
      },
      additionalProperties: false,
    },
    compactExample: { path: '~/projects/api', reason: 'The bug is in the API repository.' },
    async run({ path, reason }, ctx) {
      const from = await deps.current(ctx.sessionId);
      const wanted = path?.trim() ?? '';
      const answer = await deps.approve(
        ctx.sessionId,
        {
          callId: ctx.callId,
          toolName: 'ChangeDirectory',
          input: { path: wanted, reason: reason?.trim() ?? '', from: from.root, host: from.host },
          reason: 'The assistant wants to work in another folder.',
          suggestedRule: '',
        },
        ctx.signal,
      );
      if (answer.behavior === 'deny') {
        return textOutput(
          answer.message
            ? `The person declined to change the folder and said: ${answer.message}`
            : 'The person declined to change the folder. Keep working where you are, or ask them what they want.',
          true,
        );
      }
      const target = (answer.path ?? wanted).trim();
      if (!target) return textOutput('No folder was chosen, so the session stays in ' + from.root + '.', true);
      try {
        return textOutput(await deps.move(ctx.sessionId, target));
      } catch (e) {
        return textOutput(`Could not move to ${target}: ${e instanceof Error ? e.message : String(e)} The session stays in ${from.root}.`, true);
      }
    },
  };
}
