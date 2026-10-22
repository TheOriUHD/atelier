import type { ComponentPropsWithRef } from 'react';
import { cn } from './cn.ts';

export type KbdProps = ComponentPropsWithRef<'kbd'>;

/** Key cap: 18 tall, pad 0 4, r4, 11px muted text with a 1px ring at 22% of the text color. */
export function Kbd({ className, ...props }: KbdProps) {
  return (
    <kbd
      {...props}
      className={cn(
        'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[4px] px-1 font-sans text-[11px]/[18px] text-fg-muted',
        '[box-shadow:inset_0_0_0_1px_color-mix(in_srgb,currentColor_22%,transparent)]',
        className,
      )}
    />
  );
}
