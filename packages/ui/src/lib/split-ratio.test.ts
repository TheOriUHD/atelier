import { describe, expect, it } from 'vitest';
import { dividerLimits, evenShares, moveDivider, normalizeShares, recalledShares, rememberShares } from './split-ratio.ts';

const store = () => {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('split shares', () => {
  it('start even and are checked before use', () => {
    expect(evenShares(3).map((s) => +s.toFixed(3))).toEqual([0.333, 0.333, 0.333]);
    expect(normalizeShares([0.7, 0.3], 2)).toEqual([0.7, 0.3]);
    expect(normalizeShares([0.7, 0.3], 3)).toEqual(evenShares(3));
    expect(normalizeShares([0.9, 0.9], 2)).toEqual(evenShares(2));
    expect(normalizeShares([0, 1], 2)).toEqual(evenShares(2));
    expect(normalizeShares(undefined, 2)).toEqual([0.5, 0.5]);
  });

  it('moves a divider between two neighbours and leaves the rest', () => {
    const next = moveDivider([0.25, 0.25, 0.5], 0, 0.8);
    expect(next[0]).toBeCloseTo(0.4);
    expect(next[1]).toBeCloseTo(0.1);
    expect(next[2]).toBe(0.5);
  });

  it('keeps 360px for each neighbour, and goes even where the window is too narrow for two', () => {
    expect(dividerLimits(1440, 1)).toEqual({ min: 0.25, max: 0.75 });
    // Two of three cells: the pair is two thirds of 1440 = 960px.
    expect(dividerLimits(1440, 2 / 3).min).toBeCloseTo(0.375);
    expect(dividerLimits(600, 1)).toEqual({ min: 0.5, max: 0.5 });
    expect(dividerLimits(0, 1)).toEqual({ min: 0.05, max: 0.95 });
  });

  it('are kept for each number of cells, and anything unusable falls back to even', () => {
    const s = store();
    expect(recalledShares(2, s)).toEqual([0.5, 0.5]);
    rememberShares([0.6, 0.4], s);
    rememberShares([0.5, 0.25, 0.25], s);
    expect(recalledShares(2, s)).toEqual([0.6, 0.4]);
    expect(recalledShares(3, s)).toEqual([0.5, 0.25, 0.25]);
    expect(recalledShares(4, s)).toEqual(evenShares(4));
    s.data.set('atelier.splitShares', 'garbage');
    expect(recalledShares(2, s)).toEqual([0.5, 0.5]);
    expect(recalledShares(2, { getItem: () => { throw new Error('blocked'); } })).toEqual([0.5, 0.5]);
  });
});
