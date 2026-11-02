import { describe, expect, it } from 'vitest';
import { justified } from './justified.ts';

const options = { rowHeight: 200, gap: 6 };
const square = { width: 512, height: 512 };

/** The tiles in rows: the next one starts where a tile no longer fits, as `flex-wrap` does. */
function rows(tiles: { width: number }[], width: number, gap: number) {
  const out: { width: number }[][] = [];
  let used = Infinity;
  for (const tile of tiles) {
    if (used + gap + tile.width > width) {
      out.push([]);
      used = -gap;
    }
    out.at(-1)!.push(tile);
    used += gap + tile.width;
  }
  return out;
}

describe('justified rows', () => {
  it('fills the width with full rows, and never spills over', () => {
    const images = Array.from({ length: 20 }, (_, i) => ({ width: 500 + (i % 5) * 150, height: 512 + (i % 3) * 200 }));
    const tiles = justified(images, 960, options);
    const laid = rows(tiles, 960, 6);
    for (const row of laid.slice(0, -1)) {
      const used = row.reduce((n, t) => n + t.width, 0) + 6 * (row.length - 1);
      expect(used).toBeLessThanOrEqual(960);
      expect(used).toBeGreaterThan(960 - row.length - 1);
    }
  });

  it('keeps each image’s shape', () => {
    const [wide] = justified([{ width: 1024, height: 512 }, square], 960, options);
    expect(wide!.width / wide!.height).toBeCloseTo(2, 1);
  });

  it('leaves a last row that can’t fill at the height asked for', () => {
    expect(justified([square, square], 960, options)).toEqual([
      { width: 200, height: 200 },
      { width: 200, height: 200 },
    ]);
  });

  it('crops extreme shapes rather than making slivers', () => {
    const [panorama] = justified([{ width: 4000, height: 400 }], 2000, options);
    expect(panorama!.width / panorama!.height).toBeCloseTo(2.5, 1);
  });

  it('shows an image of unknown size as a square', () => {
    expect(justified([{ width: 0, height: 0 }], 960, options)).toEqual([{ width: 200, height: 200 }]);
  });

  it('keeps the earlier rows where they are when more images arrive', () => {
    const images = Array.from({ length: 10 }, () => square);
    const before = justified(images, 960, options);
    const after = justified([...images, ...images], 960, options);
    const full = 8; // 960 / 206 rounds down to 4 a row; two rows are settled before the last, partial one.
    expect(after.slice(0, full)).toEqual(before.slice(0, full));
  });

  it('fits one wide image on a phone', () => {
    const [tile] = justified([{ width: 2000, height: 800 }], 300, { rowHeight: 132, gap: 6 });
    expect(tile).toEqual({ width: 300, height: 120 });
  });
});
