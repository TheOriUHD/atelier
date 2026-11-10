import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../workspaces/workspace.ts';
import type { ToolContext } from '../types.ts';
import { createBashTools } from './bash.ts';

const ctx: ToolContext = { sessionId: 'session', messageId: 'message', callId: 'call', signal: new AbortController().signal, emit: () => {} };

/** A workspace whose runner answers `shell.exec` with `result`. */
function workspaceAnswering(result: Record<string, unknown>): Workspace {
  return {
    id: 'w',
    deviceId: null,
    host: null,
    root: '/work',
    home: '/home/ada',
    os: 'darwin',
    shell: 'bash',
    pathSep: '/',
    runner: { call: async () => result, on: () => () => undefined } as never,
    shellFor: async () => 'shell',
  } as Workspace;
}

describe('Bash', () => {
  it('says when a killed command is still held by the system, so the model narrows it down instead of running it again', async () => {
    const [bash] = createBashTools(
      workspaceAnswering({ execId: 'x', exitCode: 137, cwd: '/work', durationMs: 123_000, output: 'searching\n', truncated: false, timedOut: true, stillRunning: true }),
    );
    const out = await bash!.run({ command: 'find / -iname "wave*"', description: 'Search for the reference files' }, ctx);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toContain(
      "Timed out after 120s and killed, but it hadn't exited a few seconds later: something in the system holds it, such as a network volume or a permission prompt. Don't run it again as it is; narrow it down (fewer folders, a -maxdepth).",
    );
  });

  it('tells models, small ones too, not to search the whole disk', () => {
    const [bash] = createBashTools(workspaceAnswering({}));
    const describeFor = bash!.description as (ctx: { tier: string; mode: string; has(name: string): boolean }) => string;
    for (const tier of ['full', 'compact']) expect(describeFor({ tier, mode: 'code', has: () => true })).toContain('`find /`');
  });
});
