import type { ComponentPropsWithRef } from 'react';
import { cn } from './cn.ts';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  tone?: BadgeTone;
}

/** Tinted background with the matching text role. `accent` uses the interactive (blue) pair. */
const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-badge-bg text-fg-secondary',
  accent: 'bg-interactive-subtle text-interactive-text',
  success: 'bg-success-subtle text-success-text',
  warning: 'bg-warning-subtle text-warning-text',
  danger: 'bg-danger-subtle text-danger-text',
};

/** Small label: 18 tall, pad 0 6, r4.5, 11/14 medium. */
export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center whitespace-nowrap rounded-xs px-1.5 font-sans text-badge',
        TONE_CLASS[tone],
        className,
      )}
    />
  );
}
