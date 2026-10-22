import type { ReactNode } from 'react';
import { cn } from '../../components/ui/index.ts';
import { useNarrow } from '../../lib/narrow.ts';

export interface Column {
  label: string;
  /** Header and cell width or alignment, e.g. `w-28` or `text-right`. */
  className?: string;
  /** Read by screen readers only (action columns). */
  hidden?: boolean;
}

/**
 * Settings table: 13px muted headers (34 tall), 44px rows, subtle dividers. Rows are `TableRow`s.
 * Narrow screens keep its columns readable and scroll it sideways.
 */
export function DataTable({ label, columns, children }: { label: string; columns: Column[]; children: ReactNode }) {
  const narrow = useNarrow();
  return (
    // Focusable while it may scroll, so the keyboard can scroll it too (WCAG 2.1.1).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div tabIndex={narrow ? 0 : undefined} className="rounded-xs outline-none focus-ring max-md:overflow-x-auto">
      <table aria-label={label} className="w-full table-fixed border-collapse text-left max-md:min-w-160">
        <thead>
          <tr className="h-[34px] border-b border-line-subtle text-footnote text-fg-muted">
            {columns.map((c) => (
              <th key={c.label} scope="col" className={cn('pr-3 font-normal last:pr-0', c.className)}>
                {c.hidden ? <span className="sr-only">{c.label}</span> : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function TableRow({ className, children }: { className?: string; children: ReactNode }) {
  return <tr className={cn('h-11 border-b border-line-subtle text-body text-fg-secondary last:border-b-0', className)}>{children}</tr>;
}

export function Cell({ className, title, children }: { className?: string; title?: string; children?: ReactNode }) {
  return (
    <td title={title} className={cn('py-1.5 pr-3 last:pr-0', className)}>
      {children}
    </td>
  );
}
