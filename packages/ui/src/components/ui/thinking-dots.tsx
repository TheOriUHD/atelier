import type { ComponentPropsWithRef } from 'react';
import { cn } from './cn.ts';
import { reducedMotionClass } from './styles.ts';
import './thinking-dots.css';

const DOT_DELAYS_MS = [0, 150, 300];

export interface ThinkingDotsProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  /** Accessible name. Without it the indicator is decorative (pair it with visible text). */
  label?: string;
}

/** The running indicator: three 3px clay dots pulsing in sequence inside a 14px box. */
export function ThinkingDots({ label, className, ...props }: ThinkingDotsProps) {
  return (
    <span
      {...props}
      data-thinking-dots=""
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('inline-flex size-3.5 shrink-0 items-center justify-center gap-0.5', className)}
    >
      {DOT_DELAYS_MS.map((delay) => (
        <span
          key={delay}
          style={{ animationDelay: `${delay}ms` }}
          className={cn(
            'size-[3px] rounded-full bg-brand-mark animate-[at-thinking-dot_1.2s_ease-in-out_infinite]',
            reducedMotionClass,
          )}
        />
      ))}
    </span>
  );
}
