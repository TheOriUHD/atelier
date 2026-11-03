import type { ComponentPropsWithRef } from 'react';
import { cn } from './cn.ts';

export interface ProgressBarProps extends Omit<ComponentPropsWithRef<'div'>, 'children'> {
  /** Fraction complete, 0–1 (clamped). */
  value: number;
  /** The fill's color: blue, or the warning and danger colors for a limit that is near or reached. */
  tone?: 'default' | 'warning' | 'danger';
}

const FILL: Record<NonNullable<ProgressBarProps['tone']>, string> = { default: 'bg-interactive', warning: 'bg-warning', danger: 'bg-danger' };

export function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 4px rounded track (progress-track) with an interactive-blue fill. Name it with `aria-label` or `aria-labelledby`. */
export function ProgressBar({ value, tone = 'default', className, ...props }: ProgressBarProps) {
  const fraction = clampFraction(value);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      {...props}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-progress-track', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-(--at-duration-base) ease-out', FILL[tone])}
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  );
}
