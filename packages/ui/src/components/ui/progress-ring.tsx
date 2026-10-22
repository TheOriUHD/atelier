import type { ComponentPropsWithRef } from 'react';
import { cn } from './cn.ts';
import { clampFraction } from './progress-bar.tsx';

export type ProgressRingTone = 'muted' | 'warning' | 'danger';

/** Context-meter thresholds (design/components.md › Composer (Code)): muted below 75%, warning to 90%, danger above. */
export function progressRingTone(value: number): ProgressRingTone {
  const fraction = clampFraction(value);
  if (fraction > 0.9) return 'danger';
  if (fraction >= 0.75) return 'warning';
  return 'muted';
}

const TONE_CLASS: Record<ProgressRingTone, string> = {
  muted: 'text-fg-muted',
  warning: 'text-warning',
  danger: 'text-danger',
};

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ProgressRingProps extends Omit<ComponentPropsWithRef<'svg'>, 'children'> {
  /** Fraction used, 0–1 (clamped). */
  value: number;
}

/** 16px ring for the context meter; its color follows `progressRingTone`. Name it with `aria-label`. */
export function ProgressRing({ value, className, ...props }: ProgressRingProps) {
  const fraction = clampFraction(value);
  const tone = progressRingTone(fraction);
  return (
    <svg
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      {...props}
      data-tone={tone}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      className={cn('shrink-0', TONE_CLASS[tone], className)}
    >
      <circle cx="8" cy="8" r={RADIUS} stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
        transform="rotate(-90 8 8)"
        className="transition-[stroke-dashoffset] duration-(--at-duration-base) ease-out"
      />
    </svg>
  );
}
