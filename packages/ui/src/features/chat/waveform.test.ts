import { describe, expect, it } from 'vitest';
import { peaksFrom, placeholderPeaks, resample } from './waveform.ts';

describe('a waveform', () => {
  it('takes the loudest moment of each slice, scaled so the loudest is one', () => {
    const data = new Float32Array([0, 0.5, 0, -0.25, 0, 0, 0, -0.1]);
    const peaks = peaksFrom([data], 4);
    expect(peaks).toHaveLength(4);
    expect(peaks[0]).toBe(1);
    expect(peaks[1]).toBeCloseTo(Math.pow(0.5, 0.7));
    expect(peaks[2]).toBe(0);
    expect(peaks[3]).toBeCloseTo(Math.pow(0.2, 0.7));
  });

  it('keeps the loudest of what each bar covers when there are fewer bars', () => {
    expect(resample([0.1, 0.9, 0.2, 0.3], 2)).toEqual([0.9, 0.3]);
    expect(resample([], 3)).toEqual([]);
  });

  it('makes the same calm shape for the same call every time', () => {
    const a = placeholderPeaks('call-1', 30);
    expect(a).toEqual(placeholderPeaks('call-1', 30));
    expect(a).not.toEqual(placeholderPeaks('call-2', 30));
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0.12);
    expect(Math.max(...a)).toBeLessThanOrEqual(1);
  });
});
