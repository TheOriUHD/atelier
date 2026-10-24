import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type Ref } from 'react';
import { cn } from './cn.ts';
import { Tooltip } from './tooltip.tsx';

export type SplitterOrientation = 'vertical' | 'horizontal';

/** Arrow keys move the line 2% of its track, 10% with Shift. */
const STEP = 0.02;
const BIG_STEP = 0.1;

/**
 * The value a key press moves a splitter to, or null for keys it doesn't handle. A vertical line moves with ← →,
 * a horizontal one with ↑ ↓; Home and End go to the ends.
 */
export function splitterKey(key: string, shift: boolean, { value, min, max, orientation }: { value: number; min: number; max: number; orientation: SplitterOrientation }): number | null {
  const step = shift ? BIG_STEP : STEP;
  const [back, forward] = orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  let next: number;
  if (key === back) next = value - step;
  else if (key === forward) next = value + step;
  else if (key === 'Home') next = min;
  else if (key === 'End') next = max;
  else return null;
  return Math.min(Math.max(next, min), Math.max(min, max));
}

export interface SplitterProps {
  /** `vertical`: a line between panels side by side; `horizontal`: between stacked panels. */
  orientation: SplitterOrientation;
  /** Accessible name ("Resize the panes"). */
  label: string;
  /** Where the line sits in its track: the share of the panel before it, 0–1. */
  value: number;
  min?: number;
  max?: number;
  /** The track's length in px (both panels), read when a drag starts. */
  measure(): number;
  /** While dragging: the value to show now, at most once a frame. Nothing is kept until `onCommit`. */
  onPreview?(value: number): void;
  /** The value to keep: at the end of a drag, or on a key press. */
  onCommit(value: number): void;
  /** Double-click: back to even sizes. */
  onReset(): void;
  /** The id of the panel before the line. */
  controls?: string;
  id?: string;
  /** Positions it (`absolute` with `style`, or `relative` in a flex row). */
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}

/**
 * A line between two panels that resizes them: drag it (the pointer is captured, so it keeps up over iframes),
 * use the arrow keys when it has focus, or double-click it for even sizes. It is the gap between the panels;
 * a 2px bar shows on hover, focus and while dragging, with a "Resize" tooltip.
 */
export function Splitter({ orientation, label, value, min = 0, max = 1, measure, onPreview, onCommit, onReset, controls, id, className, style, ref }: SplitterProps) {
  const drag = useRef<{ from: number; value: number; size: number; next: number; frame: number } | null>(null);
  const vertical = orientation === 'vertical';
  const clamp = (v: number) => Math.min(Math.max(v, min), Math.max(min, max));

  const end = (e: PointerEvent<HTMLDivElement>, keep: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    delete document.documentElement.dataset.resizing;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (keep && d.next !== d.value) onCommit(d.next);
    else onPreview?.(d.value);
  };

  return (
    <Tooltip content="Resize" side={vertical ? 'right' : 'top'}>
      {/* A focusable separator is a widget (WAI-ARIA window splitter), which the lint rules don't know. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={ref}
        id={id}
        role="separator"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={label}
        aria-orientation={orientation}
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-controls={controls}
        data-orientation={orientation}
        style={style}
        className={cn(
          'group/splitter z-[1] flex touch-none items-center justify-center outline-none select-none',
          vertical ? 'cursor-col-resize' : 'cursor-row-resize',
          className,
        )}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus({ preventScroll: true });
          drag.current = { from: vertical ? e.clientX : e.clientY, value, size: Math.max(1, measure()), next: value, frame: 0 };
          // Page-wide resize cursor; frames under the pointer stop taking it (see styles.css).
          document.documentElement.dataset.resizing = orientation;
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          d.next = clamp(d.value + ((vertical ? e.clientX : e.clientY) - d.from) / d.size);
          cancelAnimationFrame(d.frame);
          d.frame = requestAnimationFrame(() => onPreview?.(d.next));
        }}
        onPointerUp={(e) => end(e, true)}
        onPointerCancel={(e) => end(e, false)}
        onLostPointerCapture={(e) => end(e, true)}
        onDoubleClick={onReset}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          const next = splitterKey(e.key, e.shiftKey, { value, min, max, orientation });
          if (next === null) return;
          e.preventDefault();
          if (next !== value) onCommit(next);
        }}
      >
        <span
          aria-hidden
          className={cn(
            'rounded-full bg-transparent transition-colors duration-(--at-duration-fast)',
            'group-hover/splitter:bg-line-stronger [:root[data-focus=tab]_&]:group-focus-visible/splitter:bg-interactive group-active/splitter:bg-interactive',
            vertical ? 'h-10 max-h-[50%] w-0.5' : 'h-0.5 w-10 max-w-[50%]',
          )}
        />
      </div>
    </Tooltip>
  );
}
