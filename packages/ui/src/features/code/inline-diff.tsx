/**
 * InlineDiff (design/components.md › Transcript): mono 13/19 rows with a line number, a +/− gutter in the diff colors
 * and highlighted code. Rows come from an Edit or Write call, or from `git diff` output (the Diff tab).
 */
import { useState, type ReactNode } from 'react';
import { cn } from '../../components/ui/index.ts';
import { LineView, useHighlightedLines } from '../chat/code-block.tsx';
import type { Line } from '../chat/highlighter.ts';

export { editRows, numberRows, placedEditRows, writeRows, parseUnifiedDiff, hunkPatch, type DiffRow, type FileDiff } from '@atelier/client/diff.ts';
import type { DiffRow } from '@atelier/client/diff.ts';

const ROW_CLASS: Record<DiffRow['kind'], string> = {
  context: '',
  add: 'bg-diff-added-bg',
  remove: 'bg-diff-removed-bg',
  hunk: 'bg-fill-ghost-hover text-fg-muted',
};
/** The sign and the color of the gutter (and the line number), as in Settings › Code's preview. */
const GUTTER: Record<DiffRow['kind'], [sign: string, className: string]> = {
  context: ['', 'text-fg-muted'],
  add: ['+', 'text-diff-added-text'],
  remove: ['-', 'text-diff-removed-text'],
  hunk: ['', ''],
};

/** One column of the gutter's line numbers. */
function LineNumber({ value, digits, className }: { value: number | undefined; digits: number; className: string }) {
  return (
    <span className={cn('w-[38px] shrink-0 text-right select-none', className)} style={digits > 4 ? { width: `${digits + 1}ch` } : undefined}>
      {value}
    </span>
  );
}

export function InlineDiff({
  rows,
  language,
  lineNumbers = false,
  hunkAction,
  className,
}: {
  rows: DiffRow[];
  language: string;
  lineNumbers?: boolean;
  /** Ends each `@@` row, shown while its hunk is hovered or focused (the Diff tab's Reject). */
  hunkAction?: (hunk: number) => ReactNode;
  className?: string;
}) {
  // Each side is highlighted as one document, so tokens spanning lines (strings, comments) keep their colors.
  const side = (kind: DiffRow['kind']) => rows.filter((r) => r.kind === 'context' || r.kind === kind).map((r) => r.text).join('\n');
  const oldSide = useHighlightedLines(side('remove'), language, true);
  const newSide = useHighlightedLines(side('add'), language, true);
  // A group per hunk (its @@ row and the rows under it); rows before any @@ (an Edit's) form one of their own.
  const groups: { hunk: number | null; rows: { row: DiffRow; tokens: Line | undefined }[] }[] = [];
  let hunks = 0;
  let o = 0;
  let n = 0;
  for (const row of rows) {
    if (row.kind === 'hunk') groups.push({ hunk: hunks++, rows: [] });
    else if (!groups.length) groups.push({ hunk: null, rows: [] });
    const shown = groups.at(-1)!.rows;
    if (row.kind === 'remove') shown.push({ row, tokens: oldSide[o++] });
    else if (row.kind === 'add') shown.push({ row, tokens: newSide[n++] });
    else if (row.kind === 'context') {
      o++;
      shown.push({ row, tokens: newSide[n++] });
    } else shown.push({ row, tokens: undefined });
  }
  // Two columns only once the sides disagree: until then one number names the line in both.
  const split = lineNumbers && rows.some((r) => r.oldLine !== undefined && r.oldLine !== r.line);
  const digits = lineNumbers ? String(rows.reduce((top, r) => Math.max(top, r.line ?? 0, r.oldLine ?? 0), 0)).length : 0;

  return (
    <div className={cn('at-code overflow-x-auto py-2 font-mono text-code text-fg [font-variant-ligatures:none] [tab-size:4]', className)}>
      <div className="w-max min-w-full">
        {groups.map((group, g) => (
          <div key={g} className="group/hunk">
            {group.rows.map(({ row, tokens }, i) => (
              <div key={i} data-kind={row.kind} className={cn('flex pr-3 whitespace-pre', ROW_CLASS[row.kind], row.kind === 'hunk' && hunkAction && 'items-center')}>
                {split && <LineNumber value={row.kind === 'add' ? undefined : (row.oldLine ?? row.line)} digits={digits} className={GUTTER[row.kind][1]} />}
                {lineNumbers && <LineNumber value={split && row.kind === 'remove' ? undefined : row.line} digits={digits} className={GUTTER[row.kind][1]} />}
                <span aria-hidden className={cn('w-6 shrink-0 pl-2.5 select-none', GUTTER[row.kind][1])}>
                  {GUTTER[row.kind][0]}
                </span>
                <span>{tokens ? <LineView line={tokens} /> : row.text}</span>
                {row.kind === 'hunk' && hunkAction && group.hunk !== null && (
                  // Pinned to the visible right edge when long lines scroll sideways.
                  <span className="sticky right-2 ml-auto pl-3 font-sans opacity-0 group-focus-within/hunk:opacity-100 group-hover/hunk:opacity-100">
                    {hunkAction(group.hunk)}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A diff in a bordered card. Long ones show their first `limit` rows until opened in full. `action` sits in the top
 * right corner while the card is hovered or has focus (always on a touch screen), as a code block's buttons do.
 */
export function DiffCard({ rows, language, lineNumbers, limit, action }: { rows: DiffRow[]; language: string; lineNumbers?: boolean; limit?: number; action?: ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all || !limit ? rows : rows.slice(0, limit);
  return (
    <div className="group/diff relative overflow-hidden rounded-xl bg-code-background inset-ring inset-ring-line">
      <InlineDiff rows={shown} language={language} lineNumbers={lineNumbers} />
      {action && (
        <div className="absolute top-1.5 right-1.5 rounded-md bg-code-background opacity-0 transition-opacity duration-(--at-duration-snap) ease-out group-focus-within/diff:opacity-100 group-hover/diff:opacity-100 [@media(hover:none)]:opacity-100">
          {action}
        </div>
      )}
      {shown.length < rows.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="h-8 w-full border-t border-line text-footnote text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg"
        >
          Show {rows.length - shown.length} more {rows.length - shown.length === 1 ? 'line' : 'lines'}
        </button>
      )}
    </div>
  );
}
