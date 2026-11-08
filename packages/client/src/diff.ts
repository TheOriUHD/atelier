/** Diff rows for an edit, a new file and a unified diff, as the app and the terminal draw them. */
import type { EditPlace } from '@atelier/protocol';

export interface DiffRow {
  kind: 'context' | 'add' | 'remove' | 'hunk';
  text: string;
  /** Line number on the row's side (the old file for removals, the new one otherwise), when known. */
  line?: number;
  /** A context row's line in the old file, when known: a change above it may have moved it. */
  oldLine?: number;
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

/** An Edit's rows numbered from the line its text starts at in the file, both before and after the change. */
export function numberRows(rows: DiffRow[], start: number): DiffRow[] {
  let oldLine = start;
  let newLine = start;
  return rows.map((row): DiffRow => {
    if (row.kind === 'remove') return { ...row, line: oldLine++ };
    if (row.kind === 'add') return { ...row, line: newLine++ };
    return row.kind === 'context' ? { ...row, line: newLine++, oldLine: oldLine++ } : row;
  });
}

/**
 * An Edit's rows once it is known where it lands (`place`): whole lines (the text around old_string on its first and
 * last line put back), the unchanged lines above and below, and the file's line numbers. Without a place, the strings
 * alone; from a backend that only said the line, those numbered.
 */
export function placedEditRows(oldText: string, newText: string, place: EditPlace | undefined): DiffRow[] {
  if (!place) return editRows(oldText, newText);
  const [prefix, suffix, before] = [place.prefix ?? '', place.suffix ?? '', place.before ?? []];
  const rows = [
    ...before.map((text): DiffRow => ({ kind: 'context', text })),
    ...editRows(prefix + oldText + suffix, prefix + newText + suffix),
    ...(place.after ?? []).map((text): DiffRow => ({ kind: 'context', text })),
  ];
  return numberRows(rows, place.line - before.length);
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

