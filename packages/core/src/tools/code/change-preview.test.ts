import { RpcError, RunnerErrorCode } from '@atelier/protocol';
import { describe, expect, it } from 'vitest';
import type { RunnerCalls } from '../../workspaces/workspace.ts';
import { applyEdit } from './files.ts';
import { changePreview, changeRows, editPosition } from './change-preview.ts';

const ENOENT = new RpcError(RunnerErrorCode.IO, 'no such file', { code: 'ENOENT' });
const OUTSIDE = new RpcError(RunnerErrorCode.PathOutsideWorkspace, 'outside the workspace');

/** A runner whose `fs.read` answers with `file`: its text, or what reading it throws. */
const runnerWith = (file: string | Error | { content?: string; binary?: boolean; truncated?: boolean }) =>
  ({
    call: async () => {
      if (file instanceof Error) throw file;
      return typeof file === 'string' ? { content: file, binary: false, truncated: false } : { content: '', binary: false, truncated: false, ...file };
    },
    on: () => () => {},
  }) as unknown as RunnerCalls;

const signal = new AbortController().signal;
const FILE = 'one\ntwo\nthree\nfour\n';

describe('where an Edit lands', () => {
  it('finds the line of its text, with the file as Edit reads it', () => {
    expect(applyEdit(FILE, { file_path: 'a', old_string: 'three', new_string: '3' })).toEqual({ updated: 'one\ntwo\n3\nfour\n', line: 3, matches: 1 });
  });

  it('takes the first match of a replace_all and says how many there are', () => {
    expect(applyEdit('x\ny\nx\n', { file_path: 'a', old_string: 'x', new_string: 'z', replace_all: true })).toMatchObject({ line: 1, matches: 2 });
  });

  it('matches through CRLF line endings, as the tool does', () => {
    expect(applyEdit('a\r\nb\r\nc\r\n', { file_path: 'a', old_string: 'b\nc', new_string: 'd' })).toEqual({ updated: 'a\r\nd\r\n', line: 2, matches: 1 });
  });

  it('undoes the tag escaping of what the model read', () => {
    expect(applyEdit('<env>\n', { file_path: 'a', old_string: '‹env>', new_string: 'x' })).toMatchObject({ line: 1 });
  });

  it('finds text sent with Read’s line prefixes, as the tool does', () => {
    expect(applyEdit(FILE, { file_path: 'a', old_string: '     2\ttwo', new_string: '     2\tTWO' })).toMatchObject({ line: 2, updated: 'one\nTWO\nthree\nfour\n' });
  });

  it.each([
    ['it isn’t in the file', { old_string: 'nine', new_string: 'x' }],
    ['it matches twice without replace_all', { old_string: 'o', new_string: 'x' }],
    ['it is empty', { old_string: '', new_string: 'x' }],
    ['it changes nothing', { old_string: 'two', new_string: 'two' }],
  ])('has no place where the tool would refuse: %s', (_why, input) => {
    expect(applyEdit('foo\ntwo\n', { file_path: 'a', ...input })).toBeNull();
  });

  it('reads the position through the runner', async () => {
    await expect(editPosition(runnerWith(FILE), { file_path: 'a', old_string: 'four', new_string: '4' }, signal)).resolves.toEqual({ line: 4, matches: 1 });
  });

  it.each([
    ['the file is gone', ENOENT],
    ['the file is outside the workspace', OUTSIDE],
    ['the file is binary', { binary: true }],
    ['the file is cut off at the runner’s limit', { content: FILE, truncated: true }],
  ])('fails soft when %s', async (_why, file) => {
    await expect(editPosition(runnerWith(file), { file_path: 'a', old_string: 'four', new_string: '4' }, signal)).resolves.toBeNull();
  });

  it('asks nothing of an input that isn’t an Edit’s', async () => {
    await expect(editPosition(runnerWith(FILE), { file_path: 'a' }, signal)).resolves.toBeNull();
  });
});

describe('the file with the change in place', () => {
  it('numbers both sides, and context rows on both once the change moved them', () => {
    expect(changeRows('a\nb\nc\n', 'a\nB\nB2\nc\n')).toEqual([
      { kind: 'context', text: 'a', line: 1, oldLine: 1 },
      { kind: 'remove', text: 'b', line: 2 },
      { kind: 'add', text: 'B', line: 2 },
      { kind: 'add', text: 'B2', line: 3 },
      { kind: 'context', text: 'c', line: 4, oldLine: 3 },
    ]);
  });

  it('keeps CRLF out of the rows and treats a file without a final newline', () => {
    expect(changeRows('a\r\nb', 'a\r\nc').map((r) => [r.kind, r.text])).toEqual([
      ['context', 'a'],
      ['remove', 'b'],
      ['add', 'c'],
    ]);
  });

  it('cuts off a line of megabytes', () => {
    const [row] = changeRows(`${'x'.repeat(5000)}\n`, `${'x'.repeat(5000)}\n`);
    expect(row!.text).toBe(`${'x'.repeat(2000)}… [line cut off, 3000 more characters]`);
  });

  it('shows all of a file that fits', () => {
    const before = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(changeRows(before, before.replace('line 50', 'LINE 50'), 101)).toHaveLength(101);
  });

  it('keeps the part around the change of a long file, and says what it left out', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    const rows = changeRows(before, before.replace('line 500\n', 'LINE 500\n'), 22);
    expect(rows.length).toBeLessThanOrEqual(24);
    expect(rows[0]).toEqual({ kind: 'hunk', text: '489 lines not shown' });
    expect(rows.at(-1)).toEqual({ kind: 'hunk', text: '490 lines not shown' });
    expect(rows.find((r) => r.kind === 'remove')).toEqual({ kind: 'remove', text: 'line 500', line: 500 });
    expect(rows.find((r) => r.kind === 'add')).toEqual({ kind: 'add', text: 'LINE 500', line: 500 });
    // The numbers stay the file's, past what was left out.
    expect(rows.find((r) => r.text === 'line 501')).toMatchObject({ line: 501, oldLine: 501 });
  });

  it('shares what is left between changes far apart', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    const rows = changeRows(before, before.replace('line 10\n', 'LINE 10\n').replace('line 900\n', 'LINE 900\n'), 24);
    expect(rows.filter((r) => r.kind === 'add').map((r) => r.text)).toEqual(['LINE 10', 'LINE 900']);
    expect(rows.filter((r) => r.kind === 'hunk').length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(27);
  });

  it('stays within its budget when the change itself is larger', () => {
    const rows = changeRows('', Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'), 20);
    expect(rows.slice(0, 20).every((r) => r.kind === 'add')).toBe(true);
    expect(rows.at(-1)).toEqual({ kind: 'hunk', text: '980 lines not shown' });
    expect(rows).toHaveLength(21);
  });
});

describe('what the full view gets', () => {
  const edit = { name: 'Edit', input: { file_path: 'a.py', old_string: 'two', new_string: 'TWO' } };
  const write = (content: string) => ({ name: 'Write', input: { file_path: 'a.py', content } });

  it('an Edit: the file with the change', async () => {
    const { state, rows } = await changePreview(runnerWith(FILE), edit);
    expect(state).toBe('ready');
    expect(rows.map((r) => r.kind)).toEqual(['context', 'remove', 'add', 'context', 'context']);
  });

  it('a Write over a file: what changes in it, not every line as new', async () => {
    const { state, rows } = await changePreview(runnerWith(FILE), write('one\ntwo\nTHREE\nfour\n'));
    expect(state).toBe('ready');
    expect(rows.filter((r) => r.kind !== 'context').map((r) => [r.kind, r.text, r.line])).toEqual([
      ['remove', 'three', 3],
      ['add', 'THREE', 3],
    ]);
  });

  it('a Write of a new file: its lines, and that it is new', async () => {
    const { state, rows } = await changePreview(runnerWith(ENOENT), write('a\nb\n'));
    expect(state).toBe('new');
    expect(rows).toEqual([
      { kind: 'add', text: 'a', line: 1 },
      { kind: 'add', text: 'b', line: 2 },
    ]);
  });

  it('undoes the tag escaping of a Write', async () => {
    const { rows } = await changePreview(runnerWith(ENOENT), write('‹env>\n'));
    expect(rows[0]!.text).toBe('<env>');
  });

  it.each([
    ['a binary file', { binary: true }, 'binary'],
    ['a file past the runner’s limit', { truncated: true }, 'tooLarge'],
    ['a file outside the workspace', OUTSIDE, 'unreadable'],
    ['an Edit of a file that is gone', ENOENT, 'unreadable'],
    ['an Edit whose text moved on', 'something else\n', 'stale'],
  ])('%s has no rows, and says why', async (_what, file, state) => {
    await expect(changePreview(runnerWith(file), edit)).resolves.toEqual({ state, rows: [] });
  });

  it('a call without a path can’t be shown', async () => {
    await expect(changePreview(runnerWith(FILE), { name: 'Edit', input: {} })).resolves.toEqual({ state: 'unreadable', rows: [] });
  });
});
