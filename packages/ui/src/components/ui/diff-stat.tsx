import type { ComponentPropsWithRef } from 'react';
import { cn } from './cn.ts';

const numberFormat = new Intl.NumberFormat('en-US');

/** Formats a line count with thousands separators ("4,143"). */
export function formatCount(value: number): string {
  return numberFormat.format(value);
}

export interface DiffStatProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  added: number;
  removed: number;
}

const lines = (n: number) => `${formatCount(n)} ${n === 1 ? 'line' : 'lines'}`;

const PART_CLASS = 'rounded-[4px] px-1';

/** Inline `+N −N` pair in mono 12 on the diff tints. */
export function DiffStat({ added, removed, className, ...props }: DiffStatProps) {
  return (
    <span
      {...props}
      className={cn('inline-flex shrink-0 items-center gap-1 font-mono text-[12px]/[18px] tabular-nums', className)}
    >
      <span aria-hidden className={cn(PART_CLASS, 'bg-diff-added-bg text-diff-added-text')}>
        +{formatCount(added)}
      </span>
      <span aria-hidden className={cn(PART_CLASS, 'bg-diff-removed-bg text-diff-removed-text')}>
        −{formatCount(removed)}
      </span>
      <span className="sr-only">
        {lines(added)} added, {lines(removed)} removed
      </span>
    </span>
  );
}
