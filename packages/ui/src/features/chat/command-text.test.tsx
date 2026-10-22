import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CommandText, leadingCommand } from './command-text.tsx';

describe('commands in text', () => {
  it('finds the command a text starts with, and nothing in paths or later words', () => {
    expect(leadingCommand('/compact')).toEqual({ command: '/compact', rest: '' });
    expect(leadingCommand('/loop 5m check CI')).toEqual({ command: '/loop', rest: ' 5m check CI' });
    expect(leadingCommand('/frontend-design:polish the hero')).toEqual({ command: '/frontend-design:polish', rest: ' the hero' });
    expect(leadingCommand('/Users/ada/notes.md is the file')).toBeNull();
    expect(leadingCommand('run /compact now')).toBeNull();
    expect(leadingCommand('/ ')).toBeNull();
  });

  it('colors only the command, and leaves other text as it is', () => {
    const { container } = render(
      <p>
        <CommandText text="/compact decisions" />
      </p>,
    );
    const blue = container.querySelector('.text-interactive-text')!;
    expect(blue.textContent).toBe('/compact');
    expect(container.textContent).toBe('/compact decisions');
    const plain = render(<CommandText text="hello" />);
    expect(plain.container.querySelector('.text-interactive-text')).toBeNull();
  });
});
