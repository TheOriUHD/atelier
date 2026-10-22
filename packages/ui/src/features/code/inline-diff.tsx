/**
 * InlineDiff (design/components.md › Transcript): mono 13/19 rows with a line number, a +/− gutter in the diff colors
 * and highlighted code. Rows come from an Edit or Write call, or from `git diff` output (the Diff tab).
 */
import { useState, type ReactNode } from 'react';
import { cn } from '../../components/ui/index.ts';
import { LineView, useHighlightedLines } from '../chat/code-block.tsx';
import type { Line } from '../chat/highlighter.ts';

export interface DiffRow {
  kind: 'context' | 'add' | 'remove' | 'hunk';
  text: string;
  /** Line number on the row's side (the old file for removals, the new one otherwise), when known. */
  line?: number;
}

export interface FileDiff {
  path: string;
  binary: boolean;
  added: number;
  removed: number;
  rows: DiffRow[];
  /** The raw lines before the first hunk (`diff --git`, `index`, `---`, `+++`), each ending in a newline. */
  header: string;
  /** Each hunk's raw text, from its `@@` line on. */
  hunks: string[];
}

const splitLines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** An Edit: the lines both strings share at the start and the end stay as context around the change. */
export function editRows(oldText: string, newText: string): DiffRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return [
    ...a.slice(0, head).map((text): DiffRow => ({ kind: 'context', text })),
    ...a.slice(head, a.length - tail).map((text): DiffRow => ({ kind: 'remove', text })),
    ...b.slice(head, b.length - tail).map((text): DiffRow => ({ kind: 'add', text })),
    ...a.slice(a.length - tail).map((text): DiffRow => ({ kind: 'context', text })),
  ];
}

/** A Write: every line of the new contents is added. */
export function writeRows(content: string): DiffRow[] {
  return splitLines(content).map((text, i) => ({ kind: 'add', text, line: i + 1 }));
}

/** `git diff` output, one entry per file in the order git printed them. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let oldLine = 0;
  let newLine = 0;
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      file = { path: line.slice(line.lastIndexOf(' b/') + 3), binary: false, added: 0, removed: 0, rows: [], header: '', hunks: [] };
      files.push(file);
    } else if (!file) {
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldLine = Number(m?.[1] ?? 0);
      newLine = Number(m?.[2] ?? 0);
      file.rows.push({ kind: 'hunk', text: line });
      file.hunks.push('');
    } else if (file.hunks.length === 0) {
      // Header lines before the first hunk: the path git settled on, and binary files (which have no hunks).
      if (line.startsWith('+++ b/')) file.path = line.slice(6);
      else if (line.startsWith('rename to ')) file.path = line.slice(10);
      else if (line.startsWith('Binary files ')) file.binary = true;
      file.header += `${line}\n`;
      continue;
    } else if (line.startsWith('+')) {
      file.rows.push({ kind: 'add', text: line.slice(1), line: newLine++ });
      file.added++;
    } else if (line.startsWith('-')) {
      file.rows.push({ kind: 'remove', text: line.slice(1), line: oldLine++ });
      file.removed++;
    } else if (line.startsWith(' ')) {
      oldLine++;
      file.rows.push({ kind: 'context', text: line.slice(1), line: newLine++ });
    }
    file.hunks[file.hunks.length - 1] += `${line}\n`;
  }
  return files;
}

/** What `git.revertHunk` takes to reject one change: the file's header lines and that hunk. */
export function hunkPatch(file: FileDiff, index: number): string {
  return file.header + file.hunks[index]!;
}

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

export function InlineDiff({
  rows,
  language,
  lineNumbers = false,
  hunkAction,
}: {
  rows: DiffRow[];
  language: string;
  lineNumbers?: boolean;
  /** Ends each `@@` row, shown while its hunk is hovered or focused (the Diff tab's Reject). */
  hunkAction?: (hunk: number) => ReactNode;
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

  return (
    <div className="at-code overflow-x-auto py-2 font-mono text-code text-fg [font-variant-ligatures:none] [tab-size:4]">
      <div className="w-max min-w-full">
        {groups.map((group, g) => (
          <div key={g} className="group/hunk">
            {group.rows.map(({ row, tokens }, i) => (
              <div key={i} data-kind={row.kind} className={cn('flex pr-3 whitespace-pre', ROW_CLASS[row.kind], row.kind === 'hunk' && hunkAction && 'items-center')}>
                {lineNumbers && <span className={cn('w-[38px] shrink-0 text-right select-none', GUTTER[row.kind][1])}>{row.line}</span>}
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

/** A diff in a bordered card. Long ones show their first `limit` rows until opened in full. */
export function DiffCard({ rows, language, lineNumbers, limit }: { rows: DiffRow[]; language: string; lineNumbers?: boolean; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all || !limit ? rows : rows.slice(0, limit);
  return (
    <div className="overflow-hidden rounded-xl bg-code-background inset-ring inset-ring-line">
      <InlineDiff rows={shown} language={language} lineNumbers={lineNumbers} />
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
