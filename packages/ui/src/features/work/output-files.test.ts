import { describe, expect, it } from 'vitest';
import type { Message, Part, WorkspaceSummary } from '@atelier/protocol';
import { absolutePath, fileKind, inFolder, latestRun, openAction, outputFiles } from './output-files.ts';

const ROOT = '/home/ada/reports';
let n = 0;
const message = (role: Message['role'], parts: Part[]): Message =>
  ({ id: `m${++n}`, role, parts, parentId: null, createdAt: n, kind: 'normal' }) as unknown as Message;
const call = (id: string, name: string, input: object): Part => ({ type: 'tool_call', id, name, input }) as Part;
const result = (callId: string, isError = false): Part => ({ type: 'tool_result', callId, content: [{ type: 'text', text: 'ok' }], isError }) as Part;
const text = (t: string): Part => ({ type: 'text', text: t });

describe('outputFiles', () => {
  it('lists files Write and Edit changed in the folder, once each, newest last', () => {
    const messages = [
      message('user', [text('Write the report')]),
      message('assistant', [call('a', 'Write', { file_path: `${ROOT}/report.md`, content: '#' }), call('b', 'Write', { file_path: `${ROOT}/data/q3.csv`, content: 'x' })]),
      message('tool', [result('a'), result('b')]),
      message('assistant', [call('c', 'Edit', { file_path: `${ROOT}/report.md`, old_string: '#', new_string: '# Q3' }), call('d', 'Read', { file_path: `${ROOT}/notes.txt` })]),
      message('tool', [result('c'), result('d')]),
    ];
    expect(outputFiles(messages, ROOT)).toEqual([
      { path: 'data/q3.csv', name: 'q3.csv' },
      { path: 'report.md', name: 'report.md' },
    ]);
  });

  it('leaves out failed and unanswered calls and files outside the folder', () => {
    const messages = [
      message('assistant', [
        call('a', 'Write', { file_path: `${ROOT}/denied.md`, content: '' }),
        call('b', 'Write', { file_path: '/tmp/scratch.txt', content: '' }),
        call('c', 'Write', { file_path: `${ROOT}-old/sibling.md`, content: '' }),
        call('d', 'Write', { file_path: 'out/relative.md', content: '' }),
        call('e', 'Write', { file_path: '../escape.md', content: '' }),
        call('f', 'Write', { file_path: `${ROOT}/pending.md`, content: '' }),
      ]),
      message('tool', [result('a', true), result('b'), result('c'), result('d'), result('e')]),
    ];
    expect(outputFiles(messages, ROOT)).toEqual([{ path: 'out/relative.md', name: 'relative.md' }]);
  });

  it('only counts the latest request for the cards at the end of a task', () => {
    const messages = [
      message('user', [text('First')]),
      message('assistant', [call('a', 'Write', { file_path: `${ROOT}/first.md`, content: '' })]),
      message('tool', [result('a')]),
      message('user', [text('Second')]),
      message('assistant', [call('b', 'Write', { file_path: `${ROOT}/second.md`, content: '' })]),
      message('tool', [result('b')]),
      // A Stop hook's hidden feedback continues the same run.
      message('user', [{ type: 'context', text: 'Keep going' } as Part]),
      message('assistant', [call('c', 'Write', { file_path: `${ROOT}/third.md`, content: '' })]),
      message('tool', [result('c')]),
    ];
    expect(outputFiles(latestRun(messages), ROOT).map((f) => f.path)).toEqual(['second.md', 'third.md']);
    expect(outputFiles(messages, ROOT).map((f) => f.path)).toEqual(['first.md', 'second.md', 'third.md']);
  });
});

describe('inFolder', () => {
  it('handles Windows paths', () => {
    expect(inFolder('C:\\work\\site\\out\\a.md', 'C:\\work\\site')).toBe('out/a.md');
    expect(inFolder('C:\\work\\other\\a.md', 'C:\\work\\site')).toBeNull();
  });
});

describe('opening a file', () => {
  const workspace: WorkspaceSummary = { id: 'w', kind: 'local', name: 'reports', root: ROOT, host: null, deviceId: null, available: true, scratch: false, lastUsedAt: 0 };

  it('previews images, Markdown and text, and downloads documents in the browser', () => {
    expect(['chart.png', 'report.md', 'q3.csv', 'build.py', 'Makefile', 'deck.pptx', 'memo.docx'].map(fileKind)).toEqual([
      'image',
      'markdown',
      'text',
      'text',
      'text',
      'other',
      'other',
    ]);
    expect(openAction({ path: 'report.md', name: 'report.md' }, workspace)).toBe('preview');
    // No desktop bridge in the browser: documents download.
    expect(openAction({ path: 'memo.docx', name: 'memo.docx' }, workspace)).toBe('download');
  });

  it('builds the absolute path with the folder’s separator', () => {
    expect(absolutePath(workspace, 'out/a.docx')).toBe(`${ROOT}/out/a.docx`);
    expect(absolutePath({ ...workspace, root: 'C:\\work\\site' }, 'out/a.docx')).toBe('C:\\work\\site\\out\\a.docx');
  });
});
