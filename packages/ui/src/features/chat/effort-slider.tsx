/**
 * The effort slider (design/components.md › EffortControl): a stop per level with a dot, a tick and a "Recommended"
 * caption under the recommended one, and a white thumb that leans toward the pointer while it is dragged. The value
 * commits on release and on each keyboard step; dragging previews a level (hovering changes nothing).
 */
import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from 'react';
import type { Effort } from '@atelier/protocol';
import { cn } from '../../components/ui/index.ts';
import { prefersReducedMotion } from '../../lib/motion.ts';

/** The thumb's travel ends this far in from each side (half its width); the dots sit a little further in. */
const THUMB_INSET = 8;
const DOT_INSET = 10;
const DOT = 3;

const KEY_STEPS: Record<string, (index: number, last: number) => number> = {
  ArrowLeft: (i) => i - 1,
  ArrowDown: (i) => i - 1,
  ArrowRight: (i) => i + 1,
  ArrowUp: (i) => i + 1,
  Home: () => 0,
  PageDown: () => 0,
  End: (_, last) => last,
  PageUp: (_, last) => last,
};

export interface EffortSliderProps {
  levels: readonly Effort[];
  value: Effort;
  label(level: Effort): string;
  /** Marked with a tick and the "Recommended" caption. */
  recommended: Effort | null;
  /** The level under the pointer while dragging; null once it is released. */
  onPreview(level: Effort | null): void;
  onCommit(level: Effort): void;
  /** Drawn across the whole track, under the thumb and not moving with the fill; `lit` while the slider sits on its last stop. */
  overlay?: (lit: boolean) => ReactNode;
  ref?: Ref<HTMLDivElement>;
}

export function EffortSlider({ levels, value, label, recommended, onPreview, onCommit, overlay, ref }: EffortSliderProps) {
  const [drag, setDrag] = useState<{ index: number; lean: number } | null>(null);
  const last = levels.length - 1;
  const committed = levels.indexOf(value);
  const index = drag?.index ?? committed;
  const mark = recommended ? levels.indexOf(recommended) : -1;
  const at = (i: number) => (last > 0 ? i / last : 0);

  /** The stop nearest the pointer, how far past it the pointer is (in stops), and a stop's width in pixels. */
  const locate = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const travel = Math.max(rect.width - 2 * THUMB_INSET, 1);
    const position = ((e.clientX - rect.left - THUMB_INSET) / travel) * last;
    const i = Math.min(Math.max(Math.round(position), 0), last);
    return { i, past: position - i, stop: travel / Math.max(last, 1) };
  };

  const follow = (e: PointerEvent<HTMLDivElement>) => {
    const { i, past, stop } = locate(e);
    // The thumb leans toward the pointer between stops, at most an eighth of a stop.
    const lean = prefersReducedMotion() ? 0 : Math.sign(past) * Math.min(0.12 * (1 - Math.exp(-Math.abs(past) / 0.12)), 0.48) * stop;
    setDrag({ index: i, lean: Math.round(lean * 2) / 2 });
    onPreview(levels[i]!);
  };

  const release = (commit: boolean) => {
    if (commit && drag && drag.index !== committed) onCommit(levels[drag.index]!);
    setDrag(null);
    onPreview(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[e.key];
    if (!step) return;
    e.preventDefault();
    const next = Math.min(Math.max(step(committed, last), 0), last);
    if (next !== committed) onCommit(levels[next]!);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={index}
        aria-valuetext={`${label(levels[index]!)}${index === mark ? ' (Recommended)' : ''}`}
        data-at-max={index === last ? '' : undefined}
        data-dragging={drag ? '' : undefined}
        className="group @container relative h-6 touch-none outline-none"
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus({ preventScroll: true });
          follow(e);
        }}
        onPointerMove={(e) => {
          if (drag) follow(e);
        }}
        onPointerUp={() => release(true)}
        onPointerCancel={() => release(false)}
        onPointerLeave={() => !drag && onPreview(null)}
      >
        <div className="absolute inset-x-0 inset-y-0.5 overflow-hidden rounded-sm bg-fill-control">
          <div
            data-slider-fill=""
            className="absolute inset-0 bg-slider-fill duration-(--at-duration-snap) ease-snap motion-safe:transition-[translate]"
            style={{ translate: `calc(${at(index) - 1} * (100cqw - ${2 * THUMB_INSET}px) - ${THUMB_INSET}px)` }}
          />
          {/* The whole track, the spot under the thumb at the last stop included, and staying there: leaving it, the overlay fades out in place instead of riding the fill away with the thumb. */}
          {overlay && (
            <div aria-hidden className="pointer-events-none absolute inset-0">
              {overlay(index === last)}
            </div>
          )}
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-x-2.5 inset-y-0 flex items-center justify-between">
          {levels.map((level, i) => (
            <span key={level} data-recommended={i === mark ? '' : undefined} className={cn('w-[3px] rounded-full bg-slider-stop', i === mark ? 'h-[9px]' : 'h-[3px]')} />
          ))}
        </div>
        <span
          aria-hidden
          className="pointer-events-none absolute top-0.5 left-0 h-5 w-4 duration-(--at-duration-snap) ease-snap motion-safe:transition-[translate]"
          style={{ translate: `calc(${at(index)} * (100cqw - ${2 * THUMB_INSET}px) + ${drag?.lean ?? 0}px)` }}
        >
          <span className="absolute inset-0 rounded-sm bg-switch-knob shadow-slider-thumb duration-(--at-duration-snap) ease-overshoot group-data-dragging:scale-[1.12] motion-safe:transition-[scale] group-focus-visible:shadow-focus forced-colors:group-focus-visible:outline-2 forced-colors:group-focus-visible:outline-[Highlight]" />
        </span>
      </div>
      {mark >= 0 && (
        <div className="@container relative h-[17px]">
          <span
            className={cn('absolute top-0 text-footnote whitespace-nowrap', index === mark ? 'text-fg-secondary' : 'text-fg-muted')}
            style={captionPosition(at(mark))}
          >
            Recommended
          </span>
        </div>
      )}
    </div>
  );
}

/** Centered under the tick at `at` (0–1 along the dots), but never past either edge: anchored on the right past the middle. */
function captionPosition(at: number): CSSProperties {
  const from = (f: number) => `(${DOT_INSET + DOT / 2}px + ${f} * (100cqw - ${2 * DOT_INSET + DOT}px))`;
  return at > 0.5
    ? { right: `calc${from(1 - at)}`, translate: `min(50%, ${from(1 - at)}) 0` }
    : { left: `calc${from(at)}`, translate: `max(-50%, -1 * ${from(at)}) 0` };
}
