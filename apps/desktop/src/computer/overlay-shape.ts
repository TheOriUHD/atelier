/**
 * The shapes of the overlay's windows on Linux, where a window is cut to its shape instead of drawn with transparency (a
 * transparent window needs a compositing manager, which many X sessions run without). A shape is a set of rectangles in
 * window coordinates, as `BrowserWindow.setShape` takes them.
 */
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame along a display's edges, in window coordinates: four bars, `edge` DIPs thick. */
export function frameShape(width: number, height: number, edge: number): Rectangle[] {
  return [
    { x: 0, y: 0, width, height: edge },
    { x: 0, y: height - edge, width, height: edge },
    { x: 0, y: edge, width: edge, height: Math.max(0, height - 2 * edge) },
    { x: width - edge, y: edge, width: edge, height: Math.max(0, height - 2 * edge) },
  ];
}

/** A rounded rectangle as rows of rectangles (a window shape is a set of rectangles), the corners cut by `radius`. */
export function roundedShape(width: number, height: number, wanted: number): Rectangle[] {
  const radius = Math.min(wanted, width / 2, height / 2);
  const rects: Rectangle[] = [];
  for (let y = 0; y < height; y++) {
    const fromEdge = Math.min(y, height - 1 - y);
    const inset = fromEdge >= radius ? 0 : Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - (radius - fromEdge - 0.5) ** 2)));
    const last = rects[rects.length - 1];
    if (last && last.x === inset && last.y + last.height === y) last.height++;
    else rects.push({ x: inset, y, width: width - 2 * inset, height: 1 });
  }
  return rects;
}
