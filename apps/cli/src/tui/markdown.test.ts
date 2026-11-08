import { describe, expect, it } from 'vitest';
import { Paint, palette, strip } from '../style.ts';
import { renderMarkdown } from './markdown.ts';
import { highlight } from './highlight.ts';

const plain = new Paint(palette('dark', 0));
const colour = new Paint(palette('dark', 3));

describe('markdown in the terminal', () => {
  it('draws headings, lists, task lists, quotes and code', () => {
    const out = renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- [x] done\n\n> quoted\n\n```ts\nconst x = 1;\n```', plain, 80);
    expect(out).toBe(['Title', '', 'Some bold and code.', '', '• one', '☒ done', '', '▎ quoted', '', '╭ ts', '│ const x = 1;'].join('\n'));
  });

  it('draws tables in box drawing, cut to the width', () => {
    const out = renderMarkdown('| Algorithm | Stable |\n| --- | --- |\n| Mergesort | Yes |', plain, 80).split('\n');
    expect(out[0]).toBe('┌───────────┬────────┐');
    expect(out[3]).toBe('│ Mergesort │ Yes    │');
  });

  it('colours with the app’s colours, and the colour comes off cleanly', () => {
    const out = renderMarkdown('Run `npm test` now', colour, 80);
    expect(out).toContain('\x1b[38;2;');
    expect(strip(out)).toBe('Run npm test now');
  });

  it('colours code by language without changing it', () => {
    const code = 'export function f(x: number) { return "s" + 1; } // done';
    const [line] = highlight(code, 'ts', colour);
    expect(strip(line!)).toBe(code);
    expect(line).not.toBe(code);
    expect(highlight(code, 'unknown-lang', colour)[0]).toBe(code);
  });
});
