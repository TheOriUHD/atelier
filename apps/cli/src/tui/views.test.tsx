import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { ToolCallPart, ToolResultPart } from '@atelier/protocol';
import { Paint, palette, strip } from '../style.ts';
import { ThinkingRow, ToolRow, type ViewContext } from './views.tsx';

const paint = new Paint(palette('dark', 0));
const ctx = (over: Partial<ViewContext> = {}): ViewContext => ({ paint, columns: 100, root: '/repo', view: 'normal', reveal: 'click', ...over });
const shown = (el: React.ReactElement) => strip(render(el).lastFrame() ?? '');

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const edit: ToolCallPart = { type: 'tool_call', id: 'e', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'x', new_string: lines(60) } };
const edited: ToolResultPart = { type: 'tool_result', callId: 'e', content: [{ type: 'text', text: 'Edited /repo/a.ts' }] };
const write: ToolCallPart = { type: 'tool_call', id: 'w', name: 'Write', input: { file_path: '/repo/b.ts', content: lines(12) } };
const wrote: ToolResultPart = { type: 'tool_result', callId: 'w', content: [{ type: 'text', text: 'Wrote /repo/b.ts' }] };
const bash: ToolCallPart = { type: 'tool_call', id: 'b', name: 'Bash', input: { command: 'pnpm test' } };
const ran: ToolResultPart = { type: 'tool_result', callId: 'b', content: [{ type: 'text', text: lines(20) }] };

describe('cut-short rows say how to see the rest', () => {
  it('a thought: one line with the hint, its text once opened', () => {
    expect(shown(<ThinkingRow text="Check the parser first." seconds={4} ctx={ctx()} />)).toBe('∴ Thought for 4s · click to show');
    expect(shown(<ThinkingRow text="Check the parser first." seconds={4} ctx={ctx({ reveal: 'keys' })} />)).toBe('∴ Thought for 4s · ctrl+o to show');
    const open = shown(<ThinkingRow text="Check the parser first." seconds={4} ctx={ctx()} open />);
    expect(open).toContain('Thought for 4s · click to hide');
    expect(open).toContain('Check the parser first.');
  });

  it('an edit: 40 lines, then how many more and how; all of it once opened', () => {
    const short = shown(<ToolRow call={edit} result={edited} ctx={ctx()} />);
    expect(short).toMatch(/… 21 more lines · click to show/);
    expect(short).not.toContain('line 60');
    expect(shown(<ToolRow call={edit} result={edited} ctx={ctx({ reveal: 'keys' })} />)).toMatch(/· ctrl\+o twice to show/);
    expect(shown(<ToolRow call={edit} result={edited} ctx={ctx({ reveal: 'keys', view: 'thinking' })} />)).toMatch(/· ctrl\+o to show/);
    const open = shown(<ToolRow call={edit} result={edited} ctx={ctx()} open />);
    expect(open).toContain('line 60');
    expect(open).not.toContain('more lines');
  });

  it('a new file: its length, its lines once opened', () => {
    expect(shown(<ToolRow call={write} result={wrote} ctx={ctx()} />)).toContain('12 lines · click to show');
    expect(shown(<ToolRow call={write} result={wrote} ctx={ctx()} open />)).toContain('line 12');
  });

  it('a command: its last lines under how many came before; all of them once opened', () => {
    const short = shown(<ToolRow call={bash} result={ran} ctx={ctx()} />);
    expect(short).toContain('… 17 more lines above · click to show');
    expect(short).toContain('line 20');
    expect(short).not.toContain('line 2\n');
    expect(shown(<ToolRow call={bash} result={ran} ctx={ctx()} open />)).toContain('line 1\n');
  });
});
