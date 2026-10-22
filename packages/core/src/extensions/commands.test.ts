import { describe, expect, it } from 'vitest';
import { discoverCommands, renderCommand } from './commands.ts';
import type { ExtensionFs } from './skills.ts';

function memoryFs(files: Record<string, string>): ExtensionFs {
  return {
    sep: '/',
    list: async (dir) => [...new Set(Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]!))],
    read: async (path) => files[path] ?? null,
    realpath: async (path) => path,
  };
}

describe('commands', () => {
  it('finds commands in folders and subfolders, project first', async () => {
    const project = memoryFs({ '/w/.claude/commands/review.md': '---\ndescription: Review the diff\nargument-hint: <path>\n---\nReview $ARGUMENTS.' });
    const host = memoryFs({
      '/home/.claude/commands/review.md': 'Global review',
      '/home/.claude/commands/git/commit.md': '# Write a commit message\n\nLook at the staged diff.',
      '/home/.claude/commands/notes.txt': 'not a command',
    });
    const commands = await discoverCommands([
      { fs: project, location: 'workspace', scope: 'project', roots: ['/w/.claude/commands'] },
      { fs: host, location: 'host', scope: 'global', roots: ['/home/.claude/commands'] },
    ]);
    expect(commands.map((c) => [c.name, c.description, c.argumentHint ?? '', c.scope])).toEqual([
      ['review', 'Review the diff', '<path>', 'project'],
      ['commit', 'Write a commit message', '', 'global'],
    ]);
  });

  it('fills in $ARGUMENTS and 1-based positions, or appends the arguments', () => {
    expect(renderCommand('---\ndescription: x\n---\nFix #$1 in $2 ($ARGUMENTS)', '42 src/a.ts')).toBe('Fix #42 in src/a.ts (42 src/a.ts)');
    expect(renderCommand('Summarize the diff.', 'briefly')).toBe('Summarize the diff.\n\nARGUMENTS: briefly');
  });
});
