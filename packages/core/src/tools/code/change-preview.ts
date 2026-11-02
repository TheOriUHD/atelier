/**
 * What a permission card shows of a pending Edit or Write beyond the call itself (ARCHITECTURE §8): where the change
 * lands, and the file around it. Everything is read through the workspace's runner, so SSH hosts and folders a desktop
 * lends work like this computer's. None of it may stand in the way of the question: a file that can't be read costs
 * the numbers or the full view, never the card.
 */
import { RpcError, RunnerErrorCode, type ChangePreview, type ChangeRow, type PermissionRequest } from '@atelier/protocol';
import { unescapeTags } from '../../prompts/escape.ts';
import { lineChanges } from '../../workspaces/line-diff.ts';
import type { RunnerCalls } from '../../workspaces/workspace.ts';
import { applyEdit, type EditInput } from './files.ts';

/** The tools a card shows as a change to a file. */
export const CHANGE_TOOLS = new Set(['Edit', 'Write']);

/** Rows one view shows: as much as the Files pane reads of a file. A longer file keeps the part around the change. */
const MAX_ROWS = 5000;
/** As much of a line as Read shows: a minified file has one line of megabytes. */
const MAX_ROW_CHARS = 2000;

const editInput = (input: unknown): EditInput | null => {
  const { file_path, old_string, new_string } = (input ?? {}) as Partial<EditInput>;
  return typeof file_path === 'string' && typeof old_string === 'string' && typeof new_string === 'string' ? (input as EditInput) : null;
};

/** Where an Edit lands in the file as it is now; null when it can't be said (or the Edit would fail). */
export async function editPosition(runner: RunnerCalls, input: unknown, signal: AbortSignal): Promise<NonNullable<PermissionRequest['position']> | null> {
  const edit = editInput(input);
  if (!edit) return null;
  const file = await runner.call('fs.read', { path: edit.file_path }, { signal }).catch(() => null);
  if (!file || file.binary || file.truncated) return null;
  const change = applyEdit(file.content, edit);
  return change && { line: change.line, matches: change.matches };
}

const clip = (text: string) => {
  const line = text.endsWith('\r') ? text.slice(0, -1) : text;
  return line.length > MAX_ROW_CHARS ? `${line.slice(0, MAX_ROW_CHARS)}… [line cut off, ${line.length - MAX_ROW_CHARS} more characters]` : line;
};

/** The whole of `after` with what changed from `before` in place, in at most MAX_ROWS rows. */
export function changeRows(before: string, after: string, maxRows = MAX_ROWS): ChangeRow[] {
  let oldLine = 1;
  let newLine = 1;
  const rows = lineChanges(before, after).map((op): ChangeRow => {
    const text = clip(op.text);
    if (op.kind === '-') return { kind: 'remove', text, line: oldLine++ };
    if (op.kind === '+') return { kind: 'add', text, line: newLine++ };
    return { kind: 'context', text, line: newLine++, oldLine: oldLine++ };
  });
  return rows.length > maxRows ? foldUnchanged(rows, maxRows) : rows;
}

/** `rows` with the unchanged lines farthest from any change left out, each gap as a row that says so. */
function foldUnchanged(rows: ChangeRow[], maxRows: number): ChangeRow[] {
  // Runs of changed rows, as [first, last]; a change takes its share of what is left in lines on both sides.
  const runs: [number, number][] = [];
  rows.forEach((row, i) => {
    if (row.kind === 'context') return;
    const run = runs.at(-1);
    if (run && run[1] === i - 1) run[1] = i;
    else runs.push([i, i]);
  });
  const changed = runs.reduce((sum, [first, last]) => sum + last - first + 1, 0);
  const reach = Math.max(0, Math.floor((maxRows - changed) / (2 * Math.max(runs.length, 1))));
  const keep = new Array<boolean>(rows.length).fill(false);
  // A change too large for the budget shows its start, as the card's own diff does.
  let left = maxRows;
  for (const [first, last] of runs.length ? runs : [[0, 0] as [number, number]]) {
    for (let i = Math.max(0, first - reach); i <= Math.min(rows.length - 1, last + reach) && left > 0; i++) {
      if (keep[i]) continue;
      keep[i] = true;
      left--;
    }
  }
  const out: ChangeRow[] = [];
  let hidden = 0;
  const gap = () => {
    if (hidden) out.push({ kind: 'hunk', text: `${hidden.toLocaleString('en-US')} ${hidden === 1 ? 'line' : 'lines'} not shown` });
    hidden = 0;
  };
  rows.forEach((row, i) => {
    if (!keep[i]) hidden++;
    else {
      gap();
      out.push(row);
    }
  });
  gap();
  return out;
}

/** The file behind a card for an Edit or Write, as it is now. */
export async function changePreview(runner: RunnerCalls, call: { name: string; input: unknown }, signal?: AbortSignal): Promise<ChangePreview> {
  const path = (call.input as { file_path?: unknown } | null)?.file_path;
  if (typeof path !== 'string') return { state: 'unreadable', rows: [] };
  const content = (call.input as { content?: unknown }).content;
  // Over 16 MiB comes back cut off, like everything the runner reads, and an Edit refuses it just the same.
  const file = await runner.call('fs.read', { path }, signal ? { signal } : {}).catch((error: unknown) => (error instanceof RpcError && error.code === RunnerErrorCode.IO && error.data?.code === 'ENOENT' ? 'missing' : null));
  if (file === 'missing') return call.name === 'Write' && typeof content === 'string' ? { state: 'new', rows: changeRows('', unescapeTags(content)) } : { state: 'unreadable', rows: [] };
  if (!file) return { state: 'unreadable', rows: [] };
  if (file.binary) return { state: 'binary', rows: [] };
  if (file.truncated) return { state: 'tooLarge', rows: [] };
  if (call.name === 'Write') return typeof content === 'string' ? { state: 'ready', rows: changeRows(file.content, unescapeTags(content)) } : { state: 'unreadable', rows: [] };
  const edit = editInput(call.input);
  const change = edit && applyEdit(file.content, edit);
  return change ? { state: 'ready', rows: changeRows(file.content, change.updated) } : { state: 'stale', rows: [] };
}
