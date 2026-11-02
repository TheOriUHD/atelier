/** The sums behind the Lightbox's zoom and pan: a picture centered on a stage, scaled and moved by a `transform`. */

export interface ZoomView {
  /** 1 is the picture fitted to the window. */
  scale: number;
  /** How far its center is from the stage's center, in px. */
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const FITTED: ZoomView = { scale: 1, x: 0, y: 0 };
export const MAX_SCALE = 8;
/** One press of a zoom key or button. */
export const ZOOM_STEP = 1.5;
/** One arrow key press while zoomed in, in px. */
export const PAN_STEP = 80;
/** How much of a drag past the edge the picture follows. */
const OVERDRAG = 0.25;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** How far the picture can move each way at this scale: until its edge reaches the stage's, never leaving an empty side. */
export function panLimits(scale: number, picture: Size, stage: Size): Size {
  return { width: Math.max(0, (picture.width * scale - stage.width) / 2), height: Math.max(0, (picture.height * scale - stage.height) / 2) };
}

/** The view moved back inside its limits. At the fitted size there is nothing to pan, so it stays centered. */
export function settle(view: ZoomView, picture: Size, stage: Size): ZoomView {
  const scale = clamp(view.scale, 1, MAX_SCALE);
  const limits = panLimits(scale, picture, stage);
  return { scale, x: clamp(view.x, -limits.width, limits.width), y: clamp(view.y, -limits.height, limits.height) };
}

/** Past `limit` the movement slows down, like pulling on something, instead of stopping at an invisible wall. */
function damped(value: number, limit: number): number {
  const past = Math.abs(value) - limit;
  return past <= 0 ? value : Math.sign(value) * (limit + past * OVERDRAG);
}

/** A drag's view: it follows the pointer freely inside the limits and with resistance past them. */
export function dragged(view: ZoomView, picture: Size, stage: Size): ZoomView {
  const limits = panLimits(view.scale, picture, stage);
  return { scale: view.scale, x: damped(view.x, limits.width), y: damped(view.y, limits.height) };
}

/** Zooms to `scale`, keeping the spot under `at` (relative to the stage's center) where it is. */
export function zoomAt(view: ZoomView, scale: number, at: Point): ZoomView {
  const next = clamp(scale, 1, MAX_SCALE);
  const ratio = next / view.scale;
  return { scale: next, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio };
}

/** A scale for one wheel event: a pinch on a trackpad arrives as small `ctrlKey` deltas, a mouse wheel as big ones. */
export function wheelScale(scale: number, deltaY: number, pinch: boolean): number {
  return scale * Math.exp(-deltaY * (pinch ? 0.01 : 0.002));
}

/** What a double-click zooms to: actual pixels when that is a real change, else twice the fitted size. `fitted` is the share of them shown. */
export function doubleClickScale(fitted: number): number {
  const actual = fitted > 0 ? 1 / fitted : 0;
  return actual >= 1.25 ? Math.min(MAX_SCALE, actual) : 2;
}

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
