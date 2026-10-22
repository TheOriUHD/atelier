import { describe, expect, it, vi } from 'vitest';
import type { BackgroundTask } from '@atelier/protocol';
import type { Workspace } from '../workspaces/workspace.ts';
import { BackgroundTasks } from './background-tasks.ts';

/** A runner whose background commands run until the test ends them. */
function fakeWorkspace() {
  const execs = new Map<string, { output: string; running: boolean; exitCode: number | null }>();
  const runner = {
    call: vi.fn(async (method: string, params: { execId: string; sinceOffset?: number }) => {
      const x = execs.get(params.execId);
      if (!x) throw new Error(`unknown exec ${params.execId}`);
      if (method === 'shell.kill') {
        const killed = x.running;
        Object.assign(x, { running: false, exitCode: 137 });
        return { killed };
      }
      const since = params.sinceOffset ?? 0;
      return { output: x.output.slice(since), offset: x.output.length, running: x.running, exitCode: x.exitCode, truncated: false };
    }),
    on: () => () => {},
  };
  return { ws: { runner } as unknown as Workspace, execs };
}

function setup() {
  const { ws, execs } = fakeWorkspace();
  const changes: BackgroundTask[][] = [];
  const stopAgent = vi.fn(async () => {});
  let now = 1000;
  const tasks = new BackgroundTasks({ changed: (_s, list) => void changes.push(list), stopAgent, now: () => now, pollMs: 60_000 });
  return { ws, execs, tasks, changes, stopAgent, tick: (ms: number) => void (now += ms) };
}

describe('BackgroundTasks', () => {
  it('lists background commands, counts the running ones and notices when they end', async () => {
    const { ws, execs, tasks, changes, tick } = setup();
    execs.set('e1', { output: 'serving on :3000\n', running: true, exitCode: null });
    tasks.addCommand('s1', ws, { execId: 'e1', command: 'npm run dev', description: 'Start the dev server' });
    expect(tasks.list('s1')).toEqual([
      { id: 'e1', kind: 'command', title: 'Start the dev server', command: 'npm run dev', sessionId: null, background: false, loop: null, startedAt: 1000, endedAt: null, status: 'running', exitCode: null },
    ]);
    expect(tasks.running('s1')).toBe(1);
    expect(tasks.list('other')).toEqual([]);

    await tasks.check();
    expect(tasks.list('s1')[0]!.status).toBe('running');
    Object.assign(execs.get('e1')!, { running: false, exitCode: 1 });
    tick(5000);
    await tasks.check();
    expect(tasks.list('s1')[0]).toMatchObject({ status: 'failed', exitCode: 1, endedAt: 6000 });
    expect(tasks.running('s1')).toBe(0);
    expect(changes).toHaveLength(2);
    tasks.dispose();
  });

  it('reads a command’s output from where the reader left off', async () => {
    const { ws, execs, tasks } = setup();
    execs.set('e1', { output: 'one\ntwo\n', running: true, exitCode: null });
    tasks.addCommand('s1', ws, { execId: 'e1', command: 'tail -f log' });
    expect(tasks.list('s1')[0]!.title).toBe('tail -f log');
    expect(await tasks.output('s1', 'e1', 0)).toEqual({ output: 'one\ntwo\n', offset: 8, truncated: false, running: true, exitCode: null });
    expect((await tasks.output('s1', 'e1', 4)).output).toBe('two\n');
    await expect(tasks.output('s2', 'e1', 0)).rejects.toThrow('There is no such background command.');
    tasks.dispose();
  });

  it('stops a command with the runner, and a sub-agent through its session', async () => {
    const { ws, execs, tasks, stopAgent } = setup();
    execs.set('e1', { output: '', running: true, exitCode: null });
    tasks.addCommand('s1', ws, { execId: 'e1', command: 'sleep 100' });
    await tasks.stop('s1', 'e1');
    expect(ws.runner.call).toHaveBeenCalledWith('shell.kill', { execId: 'e1' });
    expect(tasks.list('s1')[0]).toMatchObject({ status: 'stopped', exitCode: null, endedAt: 1000 });

    const agent = tasks.addAgent('s1', { childSessionId: 'child', description: 'Search the codebase' });
    expect(tasks.list('s1')[1]).toMatchObject({ id: agent, kind: 'agent', title: 'Search the codebase', sessionId: 'child', status: 'running' });
    await expect(tasks.output('s1', agent, 0)).rejects.toThrow('There is no such background command.');
    await tasks.stop('s1', agent);
    expect(stopAgent).toHaveBeenCalledWith('child');
    tasks.endAgent('s1', agent, 'stopped');
    expect(tasks.list('s1')[1]!.status).toBe('stopped');
    // An ended task stays as it ended, and stopping it again does nothing.
    tasks.endAgent('s1', agent, 'done');
    expect(tasks.list('s1')[1]!.status).toBe('stopped');
    await tasks.stop('s1', agent);
    expect(stopAgent).toHaveBeenCalledOnce();
    await expect(tasks.stop('s1', 'nope')).rejects.toThrow('There is no such background task.');
    tasks.dispose();
  });

  it('marks a command the model killed, and one whose runner forgot it', async () => {
    const { ws, execs, tasks } = setup();
    execs.set('e1', { output: '', running: true, exitCode: null });
    execs.set('e2', { output: '', running: true, exitCode: null });
    tasks.addCommand('s1', ws, { execId: 'e1', command: 'a' });
    tasks.addCommand('s1', ws, { execId: 'e2', command: 'b' });
    tasks.commandKilled('s1', 'e1');
    execs.delete('e2');
    await tasks.check();
    expect(tasks.list('s1').map((t) => t.status)).toEqual(['stopped', 'stopped']);
    tasks.dispose();
  });

  it('clears finished tasks and keeps running ones', () => {
    const { tasks, changes } = setup();
    tasks.endAgent('s1', tasks.addAgent('s1', { childSessionId: 'a', description: 'done one' }), 'done');
    tasks.addAgent('s1', { childSessionId: 'b', description: 'still going' });
    const before = changes.length;
    tasks.clearFinished('s1');
    expect(tasks.list('s1').map((t) => t.title)).toEqual(['still going']);
    expect(changes).toHaveLength(before + 1);
    // Nothing finished: nothing to tell.
    tasks.clearFinished('s1');
    tasks.clearFinished('unknown');
    expect(changes).toHaveLength(before + 1);
  });

  it('keeps the newest finished tasks and forgets a deleted session', () => {
    const { tasks } = setup();
    for (let i = 0; i < 25; i++) tasks.endAgent('s1', tasks.addAgent('s1', { childSessionId: `c${i}`, description: `task ${i}` }), 'done');
    tasks.addAgent('s1', { childSessionId: 'live', description: 'still going' });
    const list = tasks.list('s1');
    expect(list.filter((t) => t.status === 'done')).toHaveLength(20);
    expect(list.at(-1)!.title).toBe('still going');
    tasks.forget('s1');
    expect(tasks.list('s1')).toEqual([]);
  });
});
