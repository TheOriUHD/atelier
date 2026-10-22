import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOOP_MAX_AGE_MS, LOOP_MAX_PER_SESSION, LOOP_MAX_PER_USER, LOOP_MAX_RUNS } from '@atelier/protocol';
import { BackgroundTasks } from './background-tasks.ts';
import { LoopLimitError, Loops, type LoopTick } from './loops.ts';

const MIN = 60_000;

function setup(minIntervalMs?: number) {
  const sent: { sessionId: string; tick: LoopTick }[] = [];
  const busy = new Set<string>();
  const tasks = new BackgroundTasks({ changed: () => {}, stopAgent: async () => {} });
  const loops = new Loops({ tasks, busy: (id) => busy.has(id), send: (sessionId, tick) => void sent.push({ sessionId, tick }), ...(minIntervalMs ? { minIntervalMs } : {}) });
  return { sent, busy, tasks, loops, prompts: () => sent.map((s) => `${s.tick.prompt}#${s.tick.run}`) };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Loops', () => {
  it('sends at once, then every interval, and lists itself as a Loop task with its schedule', () => {
    const { loops, tasks, prompts } = setup();
    const { taskId, intervalMs } = loops.start('s1', 'check the deploy', 5 * MIN);
    expect(intervalMs).toBe(5 * MIN);
    expect(prompts()).toEqual(['check the deploy#1']);
    expect(tasks.list('s1')).toEqual([
      {
        id: taskId,
        kind: 'loop',
        title: 'check the deploy',
        command: null,
        sessionId: null,
        background: false,
        loop: { intervalMs: 5 * MIN, runs: 1, nextAt: 1_000_000 + 5 * MIN, waiting: false },
        startedAt: 1_000_000,
        endedAt: null,
        status: 'running',
        exitCode: null,
      },
    ]);
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(prompts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(5 * MIN);
    expect(prompts()).toEqual(['check the deploy#1', 'check the deploy#2', 'check the deploy#3']);
    expect(tasks.list('s1')[0]!.loop).toMatchObject({ runs: 3, nextAt: Date.now() + 5 * MIN });
    loops.dispose();
  });

  it('rounds intervals up to the shortest one, which tests may lower', () => {
    expect(setup().loops.start('s1', 'ping', 30_000).intervalMs).toBe(MIN);
    const fast = setup(2000);
    expect(fast.loops.start('s1', 'ping', 2000).intervalMs).toBe(2000);
    expect(fast.loops.start('s1', 'pong', 500).intervalMs).toBe(2000);
  });

  it('waits while the session is busy and then sends once, however many intervals passed', () => {
    const { loops, busy, tasks, prompts } = setup();
    busy.add('s1');
    loops.start('s1', 'ping', MIN);
    // Due at once, but a turn is running.
    expect(prompts()).toEqual([]);
    expect(tasks.list('s1')[0]!.loop).toMatchObject({ runs: 0, waiting: true });
    vi.advanceTimersByTime(10 * MIN);
    expect(prompts()).toEqual([]);
    busy.delete('s1');
    expect(loops.idle('s1')).toBe(true);
    expect(prompts()).toEqual(['ping#1']);
    // The next one counts from that send.
    expect(tasks.list('s1')[0]!.loop).toMatchObject({ runs: 1, waiting: false, nextAt: Date.now() + MIN });
    expect(loops.idle('s1')).toBe(false);
    vi.advanceTimersByTime(MIN);
    expect(prompts()).toEqual(['ping#1', 'ping#2']);
    loops.dispose();
  });

  it('sends one waiting loop per idle moment: the next waits for the turn that one starts', () => {
    const { loops, busy, prompts } = setup();
    busy.add('s1');
    loops.start('s1', 'a', MIN);
    loops.start('s1', 'b', MIN);
    busy.delete('s1');
    expect(loops.idle('s1')).toBe(true);
    expect(prompts()).toEqual(['a#1']);
    expect(loops.idle('s1')).toBe(true);
    expect(prompts()).toEqual(['a#1', 'b#1']);
    loops.dispose();
  });

  it('skips the send that waited when the person stopped the turn, and goes on from then', () => {
    const { loops, busy, tasks, prompts } = setup();
    loops.start('s1', 'ping', MIN);
    busy.add('s1');
    vi.advanceTimersByTime(MIN);
    expect(tasks.list('s1')[0]!.loop!.waiting).toBe(true);
    loops.stopped('s1');
    busy.delete('s1');
    expect(loops.idle('s1')).toBe(false);
    expect(prompts()).toEqual(['ping#1']);
    expect(tasks.list('s1')[0]!.loop).toMatchObject({ waiting: false, nextAt: Date.now() + MIN });
    vi.advanceTimersByTime(MIN);
    expect(prompts()).toEqual(['ping#1', 'ping#2']);
    loops.dispose();
  });

  it('sends nothing right after the person’s Stop: the next send comes a full interval later', () => {
    const { loops, tasks, prompts } = setup();
    loops.start('s1', 'ping', 10 * MIN);
    loops.start('s2', 'other', 10 * MIN);
    // Stop a few seconds before the next send was due.
    vi.advanceTimersByTime(10 * MIN - 5000);
    loops.stopped('s1');
    expect(tasks.list('s1')[0]!.loop).toMatchObject({ waiting: false, nextAt: Date.now() + 10 * MIN });
    vi.advanceTimersByTime(5000);
    expect(prompts()).toEqual(['ping#1', 'other#1', 'other#2']);
    vi.advanceTimersByTime(10 * MIN - 5000);
    expect(prompts()).toEqual(['ping#1', 'other#1', 'other#2', 'ping#2']);
    loops.dispose();
  });

  it(`starts ${LOOP_MAX_PER_SESSION} loops in a session at most, and ${LOOP_MAX_PER_USER} of one person’s`, () => {
    const { loops } = setup();
    for (let i = 0; i < LOOP_MAX_PER_SESSION; i++) loops.start('s1', `ping ${i}`, MIN, 'ada');
    expect(() => loops.start('s1', 'one more', MIN, 'ada')).toThrow(new LoopLimitError(`This session already has ${LOOP_MAX_PER_SESSION} loops running, the most one session may have. Stop one first with /loop stop.`));
    for (let s = 2; s <= LOOP_MAX_PER_USER / LOOP_MAX_PER_SESSION; s++) for (let i = 0; i < LOOP_MAX_PER_SESSION; i++) loops.start(`s${s}`, 'ping', MIN, 'ada');
    expect(() => loops.start('s9', 'one more', MIN, 'ada')).toThrow(/^You already have 20 loops running across your sessions/);
    // Someone else's loops count apart, and a stopped loop frees its place.
    expect(loops.start('s10', 'mine', MIN, 'bob').taskId).toMatch(/^loop:/);
    loops.stop('s1', '1');
    expect(loops.start('s1', 'again', MIN, 'ada').taskId).toMatch(/^loop:/);
    loops.dispose();
  });

  it(`ends after ${LOOP_MAX_RUNS} runs, or a week after it started`, () => {
    const runs = setup();
    runs.loops.start('s1', 'ping', MIN);
    vi.advanceTimersByTime(LOOP_MAX_RUNS * MIN);
    expect(runs.sent).toHaveLength(LOOP_MAX_RUNS);
    expect(runs.tasks.list('s1')[0]).toMatchObject({ status: 'done', loop: { runs: LOOP_MAX_RUNS, nextAt: null } });

    const age = setup();
    age.loops.start('s1', 'ping', 24 * 60 * MIN);
    vi.advanceTimersByTime(LOOP_MAX_AGE_MS);
    expect(age.sent).toHaveLength(7);
    expect(age.tasks.list('s1')[0]).toMatchObject({ status: 'done', loop: { runs: 7 } });
  });

  it('stops all of a session’s loops, one by its number or id, or from Background tasks', async () => {
    const { loops, tasks, sent } = setup();
    const a = loops.start('s1', 'a', MIN).taskId;
    loops.start('s1', 'b', MIN);
    loops.start('s1', 'c', MIN);
    loops.start('s2', 'other', MIN);
    expect(loops.stop('s1', '2')).toBe(1);
    expect(loops.stop('s1', a)).toBe(1);
    expect(loops.stop('s1', 'nope')).toBe(0);
    expect(loops.list('s1').map((l) => l.prompt)).toEqual(['c']);
    expect(loops.stop('s1')).toBe(1);
    expect(tasks.list('s1').map((t) => t.status)).toEqual(['stopped', 'stopped', 'stopped']);
    await tasks.stop('s2', tasks.list('s2')[0]!.id);
    expect(tasks.list('s2')[0]).toMatchObject({ status: 'stopped', loop: { nextAt: null } });
    vi.advanceTimersByTime(10 * MIN);
    expect(sent).toHaveLength(4);
  });

  it('forgets a deleted session’s loops', () => {
    const { loops, sent } = setup();
    loops.start('s1', 'ping', MIN);
    loops.forget('s1');
    vi.advanceTimersByTime(10 * MIN);
    expect(sent).toHaveLength(1);
    expect(loops.list('s1')).toEqual([]);
  });
});
