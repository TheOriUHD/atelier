import { describe, expect, it } from 'vitest';
import { formatInterval, LOOP_DEFAULT_INTERVAL_MS, parseInterval, parseLoopCommand } from './loops.ts';

describe('/loop', () => {
  it('reads intervals in seconds, minutes, hours and days, alone or combined', () => {
    expect(['30s', '5m', '2h', '1d', '1h30m', '90M', '1d2h3m4s'].map(parseInterval)).toEqual([30_000, 300_000, 7_200_000, 86_400_000, 5_400_000, 5_400_000, 93_784_000]);
    expect(['', '5', 'm', '5min', '1m1h', 'five'].map(parseInterval)).toEqual([null, null, null, null, null, null]);
  });

  it('formats intervals the way people type them', () => {
    expect([45_000, 300_000, 7_200_000, 5_400_000, 86_400_000, 0].map(formatInterval)).toEqual(['45s', '5m', '2h', '1h 30m', '1d', '0s']);
  });

  it('starts a loop with an interval, or every ten minutes without one', () => {
    expect(parseLoopCommand('5m check the deploy')).toEqual({ action: 'start', intervalMs: 300_000, prompt: 'check the deploy' });
    expect(parseLoopCommand('  2h  /review  the PR ')).toEqual({ action: 'start', intervalMs: 7_200_000, prompt: '/review  the PR' });
    expect(parseLoopCommand('check the deploy')).toEqual({ action: 'start', intervalMs: LOOP_DEFAULT_INTERVAL_MS, prompt: 'check the deploy' });
    // Below the shortest interval is still a start: the backend rounds it up.
    expect(parseLoopCommand('30s ping')).toEqual({ action: 'start', intervalMs: 30_000, prompt: 'ping' });
    // A prompt that only begins like "stop" is a prompt.
    expect(parseLoopCommand('stop the build if it is red')).toMatchObject({ action: 'start', prompt: 'stop the build if it is red' });
  });

  it('lists without arguments and stops all loops or one', () => {
    expect(parseLoopCommand('')).toEqual({ action: 'list' });
    expect(parseLoopCommand('  list ')).toEqual({ action: 'list' });
    expect(parseLoopCommand('stop')).toEqual({ action: 'stop', target: null });
    expect(parseLoopCommand('STOP 2')).toEqual({ action: 'stop', target: '2' });
    expect(parseLoopCommand('stop loop:abc')).toEqual({ action: 'stop', target: 'loop:abc' });
  });

  it('explains what is missing or out of range', () => {
    expect(parseLoopCommand('5m')).toEqual({ action: 'error', message: 'Add what to send every 5m, like “/loop 5m check the deploy”.' });
    expect(parseLoopCommand('0m ping')).toEqual({ action: 'error', message: 'The interval has to be longer than zero.' });
    expect(parseLoopCommand('2d ping')).toEqual({ action: 'error', message: 'The longest interval is 1d.' });
  });
});
