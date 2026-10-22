import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '../../components/ui/index.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { loopCommand } from './session-view.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

let stopped = 2;
beforeEach(() => {
  vi.restoreAllMocks();
  stopped = 2;
  resetBackend({
    // The backend rounds 30s up to its shortest interval.
    'loops.start': ({ intervalMs }: { intervalMs: number }) => ({ taskId: 'loop:1', intervalMs: Math.max(intervalMs, 60_000) }),
    'loops.stop': () => ({ stopped }),
  });
});

describe('/loop', () => {
  it('is offered with its arguments and starts a loop at the interval given, or every ten minutes', async () => {
    const success = vi.spyOn(toast, 'success');
    const command = loopCommand('s1', () => {});
    expect(command).toMatchObject({ name: 'loop', argumentHint: '[interval] <prompt>' });
    command.run!('5m check the deploy');
    command.run!('/review the open PR');
    command.run!('30s ping');
    await vi.waitFor(() => expect(success).toHaveBeenCalledTimes(3));
    expect(callsTo('loops.start')).toEqual([
      { sessionId: 's1', prompt: 'check the deploy', intervalMs: 300_000 },
      { sessionId: 's1', prompt: '/review the open PR', intervalMs: 600_000 },
      { sessionId: 's1', prompt: 'ping', intervalMs: 30_000 },
    ]);
    expect(success.mock.calls.map((c) => c[0])).toEqual(['Loop started: every 5m', 'Loop started: every 10m', 'Loop started: every 1m (the shortest interval)']);
  });

  it('lists without arguments, stops all or one, and explains a mistake without asking the backend', async () => {
    const success = vi.spyOn(toast, 'success');
    const error = vi.spyOn(toast, 'error');
    const list = vi.fn();
    const command = loopCommand('s1', list);
    command.run!('');
    expect(list).toHaveBeenCalledOnce();
    command.run!('stop');
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('Stopped 2 loops.'));
    stopped = 0;
    command.run!('stop 3');
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('There is no loop “3” in this session.'));
    expect(callsTo('loops.stop')).toEqual([
      { sessionId: 's1', target: null },
      { sessionId: 's1', target: '3' },
    ]);
    command.run!('5m');
    expect(error).toHaveBeenLastCalledWith('Add what to send every 5m, like “/loop 5m check the deploy”.');
    expect(callsTo('loops.start')).toEqual([]);
  });
});
