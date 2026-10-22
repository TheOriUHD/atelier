import { describe, expect, it, vi } from 'vitest';
import { KeepAwake } from './keep-awake.ts';

function setup() {
  let next = 1;
  const power = { start: vi.fn(() => next++), stop: vi.fn() };
  return { power, keepAwake: new KeepAwake(power) };
}

describe('KeepAwake', () => {
  it('holds one blocker while any window has a running session to keep awake', () => {
    const { power, keepAwake } = setup();
    keepAwake.set(1, ['s1']);
    expect(power.start).toHaveBeenCalledWith('prevent-app-suspension');
    keepAwake.set(1, ['s1', 's2']);
    keepAwake.set(2, ['s3']);
    expect(power.start).toHaveBeenCalledTimes(1);
    expect(keepAwake.awake).toBe(true);

    keepAwake.set(1, []);
    expect(power.stop).not.toHaveBeenCalled();
    keepAwake.set(2, []);
    expect(power.stop).toHaveBeenCalledWith(1);
    expect(keepAwake.awake).toBe(false);
  });

  it('takes a new blocker when a run starts again', () => {
    const { power, keepAwake } = setup();
    keepAwake.set(1, ['s1']);
    keepAwake.set(1, []);
    keepAwake.set(1, ['s1']);
    expect(power.start).toHaveBeenCalledTimes(2);
    expect(power.stop).toHaveBeenCalledTimes(1);
  });

  it('lets go when the window goes away or the app quits', () => {
    const { power, keepAwake } = setup();
    keepAwake.set(1, ['s1']);
    keepAwake.release(1);
    expect(power.stop).toHaveBeenCalledTimes(1);

    keepAwake.set(1, ['s1']);
    keepAwake.set(2, ['s2']);
    keepAwake.stop();
    expect(power.stop).toHaveBeenCalledTimes(2);
    expect(keepAwake.awake).toBe(false);
    // Nothing to let go of twice.
    keepAwake.stop();
    keepAwake.release(3);
    expect(power.stop).toHaveBeenCalledTimes(2);
  });
});
