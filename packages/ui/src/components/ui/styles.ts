/*
 * Class recipes shared by several primitives. Values come from design/components.md
 * (Overlays › Menu / Popover).
 */

/** Positioner for every anchored popup (menu, popover, select). */
export const positionerClass = 'z-(--at-layout-z-popover) outline-none';

/** Menu / Popover surface: pad 4, r12, popover background and shadow. */
export const popupSurfaceClass = 'rounded-2xl bg-popover p-1 text-body text-fg shadow-popover outline-none';

/** Scroll inside the space the positioner leaves when the list is long. */
export const popupScrollClass = 'max-h-(--available-height) overflow-y-auto';

/**
 * Opens with a fade plus a 4px slide away from the anchor (120ms ease-snap)
 * and closes with a 60ms fade.
 */
export const popupMotionClass = [
  'transition-[opacity,translate] duration-(--at-duration-snap) ease-snap',
  'data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--at-duration-fast)',
  'data-[side=bottom]:data-starting-style:-translate-y-1',
  'data-[side=top]:data-starting-style:translate-y-1',
  'data-[side=left]:data-starting-style:translate-x-1',
  'data-[side=inline-start]:data-starting-style:translate-x-1',
  'data-[side=right]:data-starting-style:-translate-x-1',
  'data-[side=inline-end]:data-starting-style:-translate-x-1',
].join(' ');

/*
 * `cn()` does not resolve conflicts, so recipes that get combined never set the same
 * property twice: rows inherit font and color from the popup, and alignment/vertical
 * padding come from exactly one of the line recipes below.
 */

/** Popup row: min 32 tall, pad 0 10, r8, gap 8, hover/keyboard highlight = ghost hover fill. */
export const itemClass =
  'flex min-h-8 cursor-default select-none gap-2 rounded-lg px-2.5 outline-none data-highlighted:bg-fill-ghost-hover data-disabled:pointer-events-none data-disabled:opacity-40';

/** One-line row: pad 6 vertically (32 tall). */
export const itemOneLineClass = 'items-center py-1.5';

/** Two-line row: pad 6 top / 7 bottom, title 14/20 over 13/17 (50 tall). */
export const itemTwoLineClass = 'items-start pt-1.5 pb-[7px]';

/** Right-aligned shortcut / value hint inside a row. */
export const itemHintClass = 'shrink-0 pl-2 text-footnote text-fg-muted';

/** Stops looping animations for prefers-reduced-motion and the in-app reduced motion setting. */
export const reducedMotionClass = 'motion-reduce:animate-none [:root[data-motion=reduced]_&]:animate-none';

/** Modal backdrop: fades over 200ms. */
export const dialogBackdropClass = [
  'fixed inset-0 z-(--at-layout-z-modal) bg-backdrop',
  'transition-opacity duration-(--at-duration-base) ease-out data-starting-style:opacity-0 data-ending-style:opacity-0',
].join(' ');

/** Centered popup: popover surface, r12, ring + shadow-lg; enters with opacity + scale(.96→1) + blur over 200ms ease-out. */
export const dialogPopupClass = [
  'fixed top-1/2 left-1/2 z-(--at-layout-z-modal) max-h-[calc(100dvh-32px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto',
  'rounded-2xl bg-popover text-body text-fg shadow-lg ring-1 ring-line outline-none',
  'transition-[opacity,scale,filter] duration-(--at-duration-base) ease-out',
  'data-starting-style:scale-96 data-starting-style:opacity-0 data-starting-style:blur-[4px]',
  'data-ending-style:scale-96 data-ending-style:opacity-0 data-ending-style:blur-[4px]',
].join(' ');
