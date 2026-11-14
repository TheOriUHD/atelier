import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button.tsx';

/** Every .tsx file of the app but its tests. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') && !name.includes('.test.') ? [path] : [];
  });
}

describe('controls over content', () => {
  it('lay the see-through fills over the opaque popover surface', () => {
    render(
      <Button variant="secondary" floating>
        Comment
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Comment' });
    expect(button.className).toContain('bg-popover');
    expect(button.className).not.toMatch(/(^| )bg-fill-secondary( |$)/);
  });

  // The secondary and ghost fills are tints; a button placed over text with them shows the text through (the selection's
  // Reply, then the plan's Comment). Such a button says `floating`.
  it('are never a see-through button placed over content', () => {
    const root = join(import.meta.dirname, '..', '..');
    const found: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/<(Button|IconButton)\b[^>]*?>/gs)) {
        const tag = match[0];
        // Placed itself, or by the element just around it when that has no opaque fill of its own.
        // An element closed on its own line (a badge beside the button) wraps nothing.
        const before = text.slice(0, match.index).split('\n').slice(-4).filter((line) => !/\/>|<\//.test(line)).join('\n');
        const wrapper = [...before.matchAll(/className="([^"]*)"/g)].at(-1)?.[1] ?? '';
        const opaque = /\bbg-(popover|raised|bg|code-background|surface[\w-]*)(?![\w/-])/.test(wrapper);
        const positioned = /className="[^"]*\b(absolute|fixed)\b/.test(tag) || (/\b(absolute|fixed)\b/.test(wrapper) && !opaque);
        const solid = /variant="(primary|danger|brand)"/.test(tag);
        // A dialog's Close sits in the dialog's own opaque header, over nothing else.
        const dialogClose = file.endsWith('dialog.tsx') && /label="Close"/.test(tag);
        if (positioned && !solid && !/\bfloating\b/.test(tag) && !dialogClose) found.push(`${relative(root, file)}: ${tag.slice(0, 80)}`);
      }
    }
    expect(found).toEqual([]);
  });
});
