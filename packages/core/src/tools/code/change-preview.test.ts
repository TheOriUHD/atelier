import { RpcError, RunnerErrorCode } from '@atelier/protocol';
import { describe, expect, it } from 'vitest';
import type { RunnerCalls } from '../../workspaces/workspace.ts';
import { applyEdit, createFileTools, editPlace, withChangeReason } from './files.ts';
import { changePreview, changeRows, editPosition, editedPreview, unapplyEdit } from './change-preview.ts';
import type { DescribeContext, Tool } from '../types.ts';
import type { Workspace } from '../../workspaces/workspace.ts';

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
    expect(applyEdit(FILE, { file_path: 'a', old_string: 'three', new_string: '3' })).toEqual({
      updated: 'one\ntwo\n3\nfour\n',
      place: { line: 3, matches: 1, prefix: '', suffix: '', before: ['one', 'two'], after: ['four'] },
    });
  });

  it('takes the first match of a replace_all and says how many there are', () => {
    expect(applyEdit('x\ny\nx\n', { file_path: 'a', old_string: 'x', new_string: 'z', replace_all: true })?.place).toMatchObject({ line: 1, matches: 2 });
  });

  it('matches through CRLF line endings, as the tool does', () => {
    expect(applyEdit('a\r\nb\r\nc\r\n', { file_path: 'a', old_string: 'b\nc', new_string: 'd' })).toEqual({
      updated: 'a\r\nd\r\n',
      place: { line: 2, matches: 1, prefix: '', suffix: '', before: ['a'], after: [] },
    });
  });

  it('undoes the tag escaping of what the model read', () => {
    expect(applyEdit('<env>\n', { file_path: 'a', old_string: '‹env>', new_string: 'x' })?.place).toMatchObject({ line: 1 });
  });

  it('finds text sent with Read’s line prefixes, as the tool does', () => {
    expect(applyEdit(FILE, { file_path: 'a', old_string: '     2\ttwo', new_string: '     2\tTWO' })).toMatchObject({ place: { line: 2 }, updated: 'one\nTWO\nthree\nfour\n' });
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
    await expect(editPosition(runnerWith(FILE), { file_path: 'a', old_string: 'four', new_string: '4' }, signal)).resolves.toEqual({ line: 4, matches: 1, prefix: '', suffix: '', before: ['one', 'two', 'three'], after: [] });
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

describe('the place an Edit keeps', () => {
  const place = (content: string, text: string) => editPlace(content, content.indexOf(text), text.length, 1);

  it('has the rest of the lines it starts and ends in, and up to three lines either side', () => {
    const file = 'a\nb\nc\nd\n  x = foo(a) + 1\ne\nf\ng\nh\n';
    expect(place(file, 'foo(a)')).toEqual({ line: 5, matches: 1, prefix: '  x = ', suffix: ' + 1', before: ['b', 'c', 'd'], after: ['e', 'f', 'g'] });
  });

  it('has fewer lines at the top and the end of a file, and none past a final newline', () => {
    expect(place('one\ntwo\n', 'one')).toEqual({ line: 1, matches: 1, prefix: '', suffix: '', before: [], after: ['two'] });
    expect(place('one\ntwo', 'two')).toEqual({ line: 2, matches: 1, prefix: '', suffix: '', before: ['one'], after: [] });
  });

  it('counts an empty first line above it', () => {
    expect(place('\nx\n', 'x')).toMatchObject({ line: 2, before: [''] });
  });

  it('takes the whole next line when the text ends with a newline', () => {
    expect(place('a\nb\nc\nd\n', 'b\n')).toEqual({ line: 2, matches: 1, prefix: '', suffix: 'c', before: ['a'], after: ['d'] });
  });

  it('keeps carriage returns out, and cuts off a line of megabytes', () => {
    expect(place('a\r\nb x\r\nc\r\n', 'b')).toEqual({ line: 2, matches: 1, prefix: '', suffix: ' x', before: ['a'], after: ['c'] });
    const long = `${'p'.repeat(3000)}X${'s'.repeat(3000)}`;
    const { prefix, suffix } = place(long, 'X');
    expect([prefix!.length, prefix!.startsWith('…'), suffix!.length, suffix!.endsWith('…')]).toEqual([2001, true, 2001, true]);
  });

  it('comes with the Edit’s result', async () => {
    const tools = new Map(createFileTools({ runner: { call: async (method: string) => (method === 'fs.read' ? { content: FILE, binary: false, truncated: false, sha256: 'x' } : { created: false }), on: () => () => {} } } as unknown as Workspace).map((t) => [t.name, t]));
    const ctx = { sessionId: 's', messageId: 'm', callId: 'c', signal, emit: () => {} };
    const output = await tools.get('Edit')!.run({ file_path: 'a', old_string: 'three', new_string: '3' }, ctx);
    expect(output.edit).toEqual({ line: 3, matches: 1, prefix: '', suffix: '', before: ['one', 'two'], after: ['four'] });
  });
});

describe('an Edit put back in the file as it is now', () => {
  const made = (content: string, input: { old_string: string; new_string: string; replace_all?: boolean }) => {
    const change = applyEdit(content, { file_path: 'a', ...input })!;
    return { after: change.updated, place: change.place, edit: { file_path: 'a', ...input } };
  };

  it('is the file before it', () => {
    const { after, place, edit } = made(FILE, { old_string: 'three', new_string: '3' });
    expect(unapplyEdit(after, edit, place)).toBe(FILE);
  });

  it('finds it where later changes moved it', () => {
    const { after, place, edit } = made(FILE, { old_string: 'three', new_string: '3' });
    expect(unapplyEdit(`zero\nzero\n${after}`, edit, place)).toBe(`zero\nzero\n${FILE}`);
  });

  it('picks the copy on a line that starts and ends as it did, then the one nearest its line', () => {
    const file = 'x = 1\ny = 1\nz = 1\n';
    const { after, place, edit } = made(file, { old_string: 'y = 1', new_string: 'y = 2' });
    // A later line now reads the same as what the edit wrote: the one at the edit's line is undone.
    expect(unapplyEdit(`${after}y = 2\n`, edit, place)).toBe(`${file}y = 2\n`);
    // A line added above reads like what the edit wrote and is nearer its line, but doesn't start and end as it did.
    const call = made('f(b(1))\nx\n', { old_string: 'b(1)', new_string: 'b(2)' });
    expect(unapplyEdit(`b(2)\n${call.after}`, call.edit, call.place)).toBe('b(2)\nf(b(1))\nx\n');
  });

  it('undoes every copy of a replace_all that are all still there', () => {
    const { after, place, edit } = made('x\ny\nx\n', { old_string: 'x', new_string: 'z', replace_all: true });
    expect(unapplyEdit(after, edit, place)).toBe('x\ny\nx\n');
  });

  it('puts back text that was only removed, at the line it left', () => {
    const { after, place, edit } = made('a\nline2\nb\n', { old_string: 'line2\n', new_string: '' });
    expect(after).toBe('a\nb\n');
    expect(unapplyEdit(after, edit, place)).toBe('a\nline2\nb\n');
  });

  it('works through CRLF line endings', () => {
    const { after, place, edit } = made('a\r\nb\r\nc\r\n', { old_string: 'b\nc', new_string: 'd\ne' });
    expect(unapplyEdit(after, edit, place)).toBe('a\r\nb\r\nc\r\n');
  });

  it('without a place (an Edit from before 0.4.2), takes the first copy of what it wrote', () => {
    expect(unapplyEdit('one\n3\nfour\n', { file_path: 'a', old_string: 'three', new_string: '3' })).toBe('one\nthree\nfour\n');
  });

  it.each([
    ['what it wrote is gone', 'one\nTHREE\n', { old_string: 'three', new_string: '3' }],
    ['it only removed text and nothing says where', 'a\nb\n', { old_string: 'line2\n', new_string: '' }],
  ])('can’t be told when %s', (_why, content, input) => {
    expect(unapplyEdit(content, { file_path: 'a', ...input })).toBeNull();
  });

  it('shows the whole file with the change, or says why not', async () => {
    const { after, place, edit } = made(FILE, { old_string: 'three', new_string: '3' });
    const { state, rows } = await editedPreview(runnerWith(after), edit, place);
    expect(state).toBe('ready');
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ['context', 'one'],
      ['context', 'two'],
      ['remove', 'three'],
      ['add', '3'],
      ['context', 'four'],
    ]);
    await expect(editedPreview(runnerWith(ENOENT), edit, place)).resolves.toEqual({ state: 'missing', rows: [] });
    await expect(editedPreview(runnerWith('one\nTHREE\n'), edit, place)).resolves.toEqual({ state: 'stale', rows: [] });
    await expect(editedPreview(runnerWith(FILE), { file_path: 'a' }, place)).resolves.toEqual({ state: 'unreadable', rows: [] });
  });
});

describe('the reason an edit tool asks for', () => {
  const tools = new Map(createFileTools({ runner: runnerWith(FILE) } as unknown as Workspace).map((t) => [t.name, t]));
  const describeIn = (tool: Tool, tier: DescribeContext['tier']) => (tool.description as (ctx: DescribeContext) => string)({ tier, mode: 'code', has: () => true });

  it.each(['Edit', 'Write'])('%s gets an optional `reason` and is told to fill it in', (name) => {
    const plain = tools.get(name)!;
    const wrapped = withChangeReason(plain);
    expect((wrapped.inputSchema.properties as Record<string, unknown>).reason).toMatchObject({ type: 'string' });
    expect(wrapped.inputSchema.required).toEqual(plain.inputSchema.required);
    expect(wrapped.inputSchema.additionalProperties).toBe(false);
    expect(describeIn(wrapped, 'full')).toBe(`${describeIn(plain, 'full')}\n- Fill in \`reason\` on every call: one short sentence on why this change is needed. The person reads it when they are asked to approve the change.`);
    expect(describeIn(wrapped, 'compact')).toContain(describeIn(plain, 'compact'));
    expect(wrapped.compactExample).toMatchObject({ ...plain.compactExample, reason: '<why, in one short sentence>' });
  });

  it('leaves the tool itself as it was: a workspace’s sessions share it', () => {
    const plain = tools.get('Edit')!;
    const before = JSON.stringify([plain.inputSchema, plain.compactExample]);
    withChangeReason(plain);
    expect(JSON.stringify([plain.inputSchema, plain.compactExample])).toBe(before);
    expect((plain.inputSchema.properties as Record<string, unknown>).reason).toBeUndefined();
  });
});
