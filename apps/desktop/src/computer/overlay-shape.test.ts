import { describe, expect, it } from 'vitest';
import { frameShape, roundedShape, type Rectangle } from './overlay-shape.ts';

/** The pixels a shape covers, to count and probe them. */
function covered(rects: Rectangle[], width: number, height: number): boolean[][] {
  const grid = Array.from({ length: height }, () => Array<boolean>(width).fill(false));
  for (const r of rects) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) grid[y]![x] = true;
  return grid;
}

describe('the overlay frame on Linux', () => {
  it('covers the edges and nothing inside, without covering a corner twice', () => {
    const grid = covered(frameShape(100, 60, 5), 100, 60);
    expect(grid[0]![0]).toBe(true);
    expect(grid[59]![99]).toBe(true);
    expect(grid[30]![2]).toBe(true);
    expect(grid[30]![97]).toBe(true);
    expect(grid[30]![50]).toBe(false);
    expect(grid[10]![50]).toBe(false);
    const area = frameShape(100, 60, 5).reduce((sum, r) => sum + r.width * r.height, 0);
    expect(area).toBe(100 * 60 - 90 * 50);
  });
});

describe('the pill on Linux', () => {
  it('is a rectangle with its corners cut, in few rectangles', () => {
    const rects = roundedShape(300, 56, 12);
    const grid = covered(rects, 300, 56);
    expect(grid[0]![0]).toBe(false);
    expect(grid[55]![299]).toBe(false);
    expect(grid[0]![150]).toBe(true);
    expect(grid[28]![0]).toBe(true);
    expect(grid[28]![299]).toBe(true);
    expect(rects.length).toBeLessThan(30);
    // Nothing leaves the window.
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(300);
    }
  });

  it('never has a negative width, even for a radius larger than the window', () => {
    for (const r of roundedShape(20, 10, 40)) expect(r.width).toBeGreaterThan(0);
  });
});
