import { describe, expect, it, vi } from 'vitest';
import { createTaskStopTool } from './task-stop.ts';
import type { ToolContext } from './types.ts';

const ctx = { sessionId: 's1' } as ToolContext;
const text = (r: Awaited<ReturnType<ReturnType<typeof createTaskStopTool>['run']>>) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

describe('TaskStop', () => {
  it('stops a running task by its id and says what it was', async () => {
    const stop = vi.fn(async () => ({ title: 'Start the dev server', wasRunning: true }));
    const tool = createTaskStopTool({ stop, running: async () => [] });
    expect(text(await tool.run({ task_id: ' exec-3 ' }, ctx))).toBe('Stopped Start the dev server.');
    expect(stop).toHaveBeenCalledWith('s1', 'exec-3');
  });

  it('says so when the task had already ended, and names the running ones for a wrong id', async () => {
    const ended = createTaskStopTool({ stop: async () => ({ title: 'Run the build', wasRunning: false }), running: async () => [] });
    expect(text(await ended.run({ task_id: 'exec-1' }, ctx))).toBe('Run the build had already ended.');

    const unknown = createTaskStopTool({ stop: async () => null, running: async () => ['exec-2', 'agent:abc'] });
    const refused = await unknown.run({ task_id: 'exec-9' }, ctx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('There is no background task exec-9. Running: exec-2, agent:abc.');
    const none = createTaskStopTool({ stop: async () => null, running: async () => [] });
    expect(text(await none.run({ task_id: 'x' }, ctx))).toBe('There is no background task x. None is running.');
  });

  it('stops several tasks, or every running one, in a single call', async () => {
    const titles: Record<string, string> = { 'exec-1': 'Start the dev server', 'agent:a': 'Review French', 'agent:b': 'Review Spanish' };
    const stop = vi.fn(async (_s: string, id: string) => (titles[id] ? { title: titles[id]!, wasRunning: id !== 'agent:b' } : null));
    const tool = createTaskStopTool({ stop, running: async () => ['exec-1', 'agent:a'] });

    expect(text(await tool.run({ task_ids: ['exec-1', ' agent:b ', 'exec-1'] }, ctx))).toBe('Stopped Start the dev server.\nReview Spanish had already ended.');
    expect(stop).toHaveBeenCalledTimes(2);

    stop.mockClear();
    expect(text(await tool.run({ all: true }, ctx))).toBe('Stopped Start the dev server.\nStopped Review French.');
    expect(stop.mock.calls.map((c) => c[1])).toEqual(['exec-1', 'agent:a']);
  });

  it('says so when `all` finds nothing running, and asks for a task when none is named', async () => {
    const tool = createTaskStopTool({ stop: async () => null, running: async () => [] });
    const idle = await tool.run({ all: true }, ctx);
    expect(idle.isError).toBeFalsy();
    expect(text(idle)).toBe('No background task is running.');
    const empty = await tool.run({}, ctx);
    expect(empty.isError).toBe(true);
    expect(text(empty)).toMatch(/`task_id`.*`all: true`/);
  });
});
