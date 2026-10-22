import type { ComponentPropsWithRef } from 'react';
import { cn } from './cn.ts';
import type { IconSize } from './icon.tsx';
import { reducedMotionClass } from './styles.ts';

const SPINNER_PX: Record<IconSize, number> = { sm: 16, md: 20, lg: 24 };

export interface SpinnerProps extends Omit<ComponentPropsWithRef<'svg'>, 'children'> {
  size?: IconSize;
  /** Accessible name. Without it the spinner is decorative (the owner should set `aria-busy`). */
  label?: string;
}

/** Indeterminate activity ring in the current text color. Static under reduced motion. */
export function Spinner({ size = 'sm', label, className, ...props }: SpinnerProps) {
  const px = SPINNER_PX[size];
  return (
    <svg
      {...props}
      width={px}
      height={px}
      viewBox="0 0 16 16"
      fill="none"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('shrink-0 animate-spin', reducedMotionClass, className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
