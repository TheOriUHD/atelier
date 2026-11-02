import { describe, expect, it } from 'vitest';
import { FITTED, MAX_SCALE, distance, doubleClickScale, dragged, middle, panLimits, settle, wheelScale, zoomAt } from './lightbox-zoom.ts';

const picture = { width: 800, height: 400 };
const stage = { width: 1000, height: 600 };

describe('zoomAt', () => {
  it('keeps the spot under the pointer where it is', () => {
    const at = { x: 200, y: -100 };
    const zoomed = zoomAt(FITTED, 2, at);
    expect(zoomed).toEqual({ scale: 2, x: -200, y: 100 });
    // A spot of the picture at `at`: its offset from the picture's center, scaled, plus where the center went.
    expect((at.x - FITTED.x) * 2 + zoomed.x).toBe(at.x);
    expect((at.y - FITTED.y) * 2 + zoomed.y).toBe(at.y);
  });

  it('stays between the fitted size and the most it zooms', () => {
    expect(zoomAt(FITTED, 0.5, { x: 0, y: 0 }).scale).toBe(1);
    expect(zoomAt(FITTED, 100, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
  });
});

describe('panLimits and settle', () => {
  it('has nothing to pan while the picture fits', () => {
    expect(panLimits(1, picture, stage)).toEqual({ width: 0, height: 0 });
  });

  it('lets the picture move until its edge meets the stage’s', () => {
    expect(panLimits(2, picture, stage)).toEqual({ width: 300, height: 100 });
  });

  it('brings a view back inside its limits', () => {
    expect(settle({ scale: 2, x: 500, y: -500 }, picture, stage)).toEqual({ scale: 2, x: 300, y: -100 });
    expect(settle({ scale: 1, x: 50, y: 50 }, picture, stage)).toEqual(FITTED);
  });
});

describe('dragged', () => {
  it('follows the pointer inside the limits, and slows down past them', () => {
    expect(dragged({ scale: 2, x: 200, y: 50 }, picture, stage)).toEqual({ scale: 2, x: 200, y: 50 });
    expect(dragged({ scale: 2, x: 400, y: -200 }, picture, stage)).toEqual({ scale: 2, x: 325, y: -125 });
  });
});

describe('wheelScale', () => {
  it('zooms in on a wheel up and out on a wheel down', () => {
    expect(wheelScale(1, -100, false)).toBeGreaterThan(1);
    expect(wheelScale(2, 100, false)).toBeLessThan(2);
  });

  it('treats a trackpad pinch’s small deltas as about the same amount as a wheel’s big ones', () => {
    expect(wheelScale(1, -20, true)).toBeCloseTo(wheelScale(1, -100, false), 5);
  });
});

describe('doubleClickScale', () => {
  it('goes to actual pixels when the image is shown well below them', () => {
    expect(doubleClickScale(0.5)).toBe(2);
    expect(doubleClickScale(0.25)).toBe(4);
    expect(doubleClickScale(0.1)).toBe(MAX_SCALE);
  });

  it('else doubles, so a small image still zooms', () => {
    expect(doubleClickScale(1)).toBe(2);
    expect(doubleClickScale(0.9)).toBe(2);
    expect(doubleClickScale(0)).toBe(2);
  });
});

describe('distance and middle', () => {
  it('are of two fingers', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(middle({ x: 0, y: 2 }, { x: 4, y: 6 })).toEqual({ x: 2, y: 4 });
  });
});
