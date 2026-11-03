/**
 * The maths of "Change an area" apart from any element, so it can be tested without a canvas: what a stroke is,
 * how big the brush is, where the keyboard moves it and how a painted layer becomes the mask the backend wants
 * (opaque, pure black and white, white = change; packages/core/src/images/mask.ts).
 */

export interface Point {
  x: number;
  y: number;
}

/** One press-drag-release (or one tap, or one key press): painted, or erased from what was painted. */
export interface Stroke {
  erase: boolean;
  /** Natural pixels. */
  diameter: number;
  points: Point[];
}

/** The longest side of the mask canvas. A larger picture gets a smaller mask; the backend resizes it to the picture anyway. */
export const MAX_MASK_SIDE = 4096;

/** The brush slider runs from 1 to 100. */
export const BRUSH_MIN = 1;
export const BRUSH_MAX = 100;
export const BRUSH_DEFAULT = 12;
/** At 100 the brush is this share of the picture's shorter side across. */
const BRUSH_MAX_SHARE = 0.4;
const BRUSH_MIN_PX = 4;

/** The size of the mask canvas for a picture: its own size, unless a side would pass `MAX_MASK_SIDE`. */
export function maskSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_MASK_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The brush's width in natural pixels. It follows the picture's size, so the same setting covers the same share of any picture. */
export function brushDiameter(size: number, width: number, height: number): number {
  const clamped = Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, size));
  return Math.max(BRUSH_MIN_PX, (clamped / BRUSH_MAX) * Math.min(width, height) * BRUSH_MAX_SHARE);
}

/** A screen position as a position on the mask canvas, whatever size the picture is shown at. */
export function toCanvas(client: Point, box: { left: number; top: number; width: number; height: number }, canvas: { width: number; height: number }): Point {
  if (box.width === 0 || box.height === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(canvas.width, Math.max(0, ((client.x - box.left) / box.width) * canvas.width)),
    y: Math.min(canvas.height, Math.max(0, ((client.y - box.top) / box.height) * canvas.height)),
  };
}

/** The 2D drawing calls a stroke needs. */
export type Pen = Pick<CanvasRenderingContext2D, 'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'fill' | 'stroke' | 'save' | 'restore'> & {
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalCompositeOperation: GlobalCompositeOperation;
};

/** Draws a stroke in white; an erasing one takes the white away again. A single point is a round dab. */
export function drawStroke(pen: Pen, stroke: Stroke): void {
  const [first, ...rest] = stroke.points;
  if (!first) return;
  pen.save();
  pen.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  pen.strokeStyle = '#fff';
  pen.fillStyle = '#fff';
  pen.lineWidth = stroke.diameter;
  pen.lineCap = 'round';
  pen.lineJoin = 'round';
  pen.beginPath();
  if (rest.length === 0) {
    pen.arc(first.x, first.y, stroke.diameter / 2, 0, Math.PI * 2);
    pen.fill();
  } else {
    pen.moveTo(first.x, first.y);
    for (const point of rest) pen.lineTo(point.x, point.y);
    pen.stroke();
  }
  pen.restore();
}

/** Where an arrow key moves the keyboard brush: a step of a fraction of its width, kept on the picture. Null for any other key. */
export function moveCursor(at: Point, key: string, step: number, bounds: { width: number; height: number }): Point | null {
  const delta = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[key];
  if (!delta) return null;
  return { x: Math.min(bounds.width, Math.max(0, at.x + delta[0])), y: Math.min(bounds.height, Math.max(0, at.y + delta[1])) };
}

/** How far one arrow press moves the keyboard brush, as a share of its width: overlapping, so a held key paints a continuous line. */
export const KEY_STEP_SHARE = 0.5;

/**
 * White painted on black (or on nothing) becomes the mask the backend takes: each pixel pure white if it is at least
 * half white, else pure black, all opaque. Round brush edges are soft on a canvas; a mask must not be.
 * Returns the share of the picture that is white.
 */
export function binarise(data: Uint8ClampedArray): number {
  let white = 0;
  for (let i = 0; i < data.length; i += 4) {
    // Painted pixels are white with some alpha over nothing; seen over black, that is their brightness.
    const level = (((data[i]! + data[i + 1]! + data[i + 2]!) / 3) * data[i + 3]!) / 255;
    const on = level >= 128;
    data[i] = data[i + 1] = data[i + 2] = on ? 255 : 0;
    data[i + 3] = 255;
    if (on) white++;
  }
  return data.length === 0 ? 0 : white / (data.length / 4);
}

/** Strokes kept to undo; older ones are baked into the picture of the mask and stay. */
export const UNDO_DEPTH = 100;

/** The mask as a see-through tint: each pixel's brightness becomes the tint's opacity, in the colour the editor marks with. */
export function tintFromMask(data: Uint8ClampedArray, [r, g, b]: readonly [number, number, number] = [244, 63, 94], opacity = 0.55): void {
  for (let i = 0; i < data.length; i += 4) {
    const level = ((data[i]! + data[i + 1]! + data[i + 2]!) / 3) * (data[i + 3]! / 255);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = Math.round(level * opacity);
  }
}
