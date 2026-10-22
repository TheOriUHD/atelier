import { describe, expect, it, vi } from 'vitest';
import type { PermissionAnswer, PermissionRequest } from '@atelier/protocol';
import { createChangeDirectoryTool, type ChangeDirectoryDeps } from './change-directory.ts';
import type { ToolContext } from './types.ts';

const ctx = { sessionId: 's1', callId: 'c1', signal: new AbortController().signal } as ToolContext;
const text = (r: Awaited<ReturnType<ReturnType<typeof createChangeDirectoryTool>['run']>>) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

function setup(answer: PermissionAnswer, move: ChangeDirectoryDeps['move'] = async (_s, path) => `Now in ${path}.`) {
  const asked: PermissionRequest[] = [];
  const deps: ChangeDirectoryDeps = {
    approve: async (_s, request) => (asked.push(request), answer),
    current: async () => ({ root: '/work/app', host: null }),
    move: vi.fn(move),
  };
  return { tool: createChangeDirectoryTool(deps), deps, asked };
}

describe('ChangeDirectory', () => {
  it('asks the person with where it comes from and why, then moves to the folder they approved', async () => {
    const { tool, deps, asked } = setup({ behavior: 'allow' });
    const out = await tool.run({ path: '../api', reason: 'The bug is there.' }, ctx);
    expect(asked[0]).toMatchObject({ toolName: 'ChangeDirectory', input: { path: '../api', reason: 'The bug is there.', from: '/work/app', host: null } });
    expect(deps.move).toHaveBeenCalledWith('s1', '../api');
    expect(text(out)).toBe('Now in ../api.');
  });

  it('moves to the folder the person corrected or picked instead', async () => {
    const { tool, deps } = setup({ behavior: 'allow', path: '/other/place' });
    await tool.run({ path: '../api' }, ctx);
    expect(deps.move).toHaveBeenCalledWith('s1', '/other/place');
    const picked = setup({ behavior: 'allow', path: '/picked' });
    await picked.tool.run({}, ctx);
    expect(picked.deps.move).toHaveBeenCalledWith('s1', '/picked');
  });

  it('stays put when declined, with their words, or when no folder was chosen', async () => {
    const declined = setup({ behavior: 'deny', message: 'finish here first' });
    const out = await declined.tool.run({ path: '/x' }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toBe('The person declined to change the folder and said: finish here first');
    expect(declined.deps.move).not.toHaveBeenCalled();
    const none = setup({ behavior: 'allow' });
    const empty = await none.tool.run({ path: '  ' }, ctx);
    expect(text(empty)).toBe('No folder was chosen, so the session stays in /work/app.');
    expect(none.deps.move).not.toHaveBeenCalled();
  });

  it('reports a folder that can’t be used and stays in the current one', async () => {
    const { tool } = setup({ behavior: 'allow' }, async () => {
      throw new Error("Can't open /nope: no such folder.");
    });
    const out = await tool.run({ path: '/nope' }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toBe("Could not move to /nope: Can't open /nope: no such folder. The session stays in /work/app.");
  });
});
