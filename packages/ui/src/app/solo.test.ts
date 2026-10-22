import { describe, expect, it } from 'vitest';
import { isSoloHash } from './solo.ts';

describe('a window for one session', () => {
  it('is told from its address', () => {
    expect(isSoloHash('#/code/abc?solo=1')).toBe(true);
    expect(isSoloHash('#/code/abc?settings=providers&solo=1')).toBe(true);
    expect(isSoloHash('#/code/abc')).toBe(false);
    expect(isSoloHash('#/code/abc?solo=10')).toBe(false);
    expect(isSoloHash('')).toBe(false);
  });
});
