/**
 * Unified diffs in `git diff`'s format for changes git can't describe: a session's own edits since it began, between
 * the content its checkpoints kept and the file now. Lines are compared with Myers' algorithm; a change too large to
 * work out quickly shows as the whole middle of the file replaced.
 */

interface Op {
  kind: ' ' | '-' | '+';
  text: string;
}

/** Edit distance beyond which the middle of the file is shown as replaced rather than worked out line by line. */
const MAX_EDITS = 2000;
const CONTEXT = 3;

/** Marks a last line with no newline after it, so it never matches the same text with one (content with NULs is binary). */
const NO_NEWLINE = '\0';

/** A file's lines; the last carries NO_NEWLINE when the file doesn't end with a newline. */
function lines(text: string): string[] {
  if (text === '') return [];
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  else all[all.length - 1] += NO_NEWLINE;
  return all;
}

/** A line of a hunk; one without a newline is followed by git's marker. */
const hunkLine = (op: Op) => (op.text.endsWith(NO_NEWLINE) ? `${op.kind}${op.text.slice(0, -1)}\n\\ No newline at end of file\n` : `${op.kind}${op.text}\n`);

/** The shortest edit script from `a` to `b`, or null when it needs more than `limit` insertions and deletions. */
function myers(a: readonly string[], b: readonly string[], limit: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[-d..d] as it was when round d began: all that round d (and backtracking through it) reads.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, limit); d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: readonly string[], b: readonly string[]): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const at = (k: number) => v[k + d]!;
    const k = x - y;
    let prevX = 0;
    let prevY = 0;
    if (d > 0) {
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      prevX = at(prevK);
      prevY = prevX - prevK;
    }
    while (x > prevX && y > prevY) {
      y--;
      ops.push({ kind: ' ', text: a[--x]! });
    }
    if (d > 0) ops.push(x === prevX ? { kind: '+', text: b[--y]! } : { kind: '-', text: a[--x]! });
  }
  return ops.reverse();
}

function editScript(a: readonly string[], b: readonly string[]): Op[] {
  // The common start and end need no search.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const middle = myers(midA, midB, MAX_EDITS) ?? [...midA.map((text): Op => ({ kind: '-', text })), ...midB.map((text): Op => ({ kind: '+', text }))];
  return [...a.slice(0, head).map((text): Op => ({ kind: ' ', text })), ...middle, ...a.slice(a.length - tail).map((text): Op => ({ kind: ' ', text }))];
}

/** The hunks of an edit script with `context` unchanged lines around each change, as `@@` blocks. */
function hunks(ops: readonly Op[], context: number): string[] {
  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]));
  if (!changed.length) return [];
  // Old and new line numbers before each op.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(n);
    if (op.kind !== '+') o++;
    if (op.kind !== '-') n++;
  }
  const out: string[] = [];
  let i = 0;
  while (i < changed.length) {
    const start = Math.max(0, changed[i]! - context);
    let last = changed[i]!;
    while (i + 1 < changed.length && changed[i + 1]! - last <= 2 * context) last = changed[++i]!;
    const end = Math.min(ops.length, last + context + 1);
    const body = ops.slice(start, end);
    const oldLen = body.filter((op) => op.kind !== '+').length;
    const newLen = body.filter((op) => op.kind !== '-').length;
    // An empty side starts at the line before (0 for an empty file), as git writes it.
    const oldStart = oldLen ? oldAt[start]! : oldAt[start]! - 1;
    const newStart = newLen ? newAt[start]! : newAt[start]! - 1;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@\n${body.map(hunkLine).join('')}`);
    i++;
  }
  return out;
}

/**
 * One file's diff from `before` to `after` (null: the file didn't exist, or doesn't any more). Empty when they are the
 * same. A last line without a newline gets git's "\ No newline at end of file", so `git apply` takes the patch both
 * ways (Reject). Content with NUL bytes is reported as a binary change.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = CONTEXT): string {
  if (before === after) return '';
  const header = [`diff --git a/${path} b/${path}`];
  if (before === null) header.push('new file mode 100644');
  if (after === null) header.push('deleted file mode 100644');
  const from = before === null ? '/dev/null' : `a/${path}`;
  const to = after === null ? '/dev/null' : `b/${path}`;
  if ((before ?? '').includes('\0') || (after ?? '').includes('\0')) return `${header.join('\n')}\nBinary files ${from} and ${to} differ\n`;
  const body = hunks(editScript(lines(before ?? ''), lines(after ?? '')), context);
  // An empty file created or deleted: the header says it all, as git writes it.
  if (!body.length) return `${header.join('\n')}\n`;
  return `${header.join('\n')}\n--- ${from}\n+++ ${to}\n${body.join('')}`;
}
