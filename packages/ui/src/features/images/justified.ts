/**
 * Sizes tiles into rows that fill the width, keeping each image's shape, as a photo library does. Unlike CSS columns, the
 * order stays newest first across the page, and tiles added by the next page never move the ones already there.
 */

export interface Size {
  width: number;
  height: number;
}

interface Options {
  /** What a row aims for; a full row ends up a little taller or shorter so that it fits exactly. */
  rowHeight: number;
  gap: number;
}

/** A panorama or a thin strip stays recognizable as a tile: past these shapes it gets cropped. */
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 2.5;

/** Some images have no known size. */
const aspectOf = ({ width, height }: Size) => (width > 0 && height > 0 ? Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, width / height)) : 1);

/**
 * A size for each of `images`, in order. Widths are rounded down, so a row laid out with `flex-wrap` never spills over: it
 * ends up to a few pixels short of the edge instead. The last row keeps `rowHeight`, as it has too few images to fill.
 */
export function justified(images: readonly Size[], width: number, { rowHeight, gap }: Options): Size[] {
  const tiles: Size[] = [];
  let row: number[] = [];
  let sum = 0;
  const close = (height: number) => {
    for (const aspect of row) tiles.push({ width: Math.floor(aspect * height), height: Math.round(height) });
    row = [];
    sum = 0;
  };
  for (const image of images) {
    const aspect = aspectOf(image);
    row.push(aspect);
    sum += aspect;
    const gaps = gap * (row.length - 1);
    if (sum * rowHeight + gaps >= width) close((width - gaps) / sum);
  }
  close(rowHeight);
  return tiles;
}
