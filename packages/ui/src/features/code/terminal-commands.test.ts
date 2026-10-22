import { describe, expect, it, vi } from 'vitest';
import { TerminalCommands } from './terminal-pane.tsx';
import { keystrokes } from './terminal-keys.ts';

describe('commands waiting for the terminal', () => {
  it('keep their order until a shell takes them, once, and tell listeners', () => {
    const queue = new TerminalCommands();
    const heard = vi.fn();
    const stop = queue.subscribe(heard);
    queue.push('pip install rich');
    queue.push('python3 demo.py');
    expect(heard).toHaveBeenCalledTimes(2);
    expect(queue.take()).toEqual(['pip install rich', 'python3 demo.py']);
    expect(queue.take()).toEqual([]);
    stop();
    queue.push('ls');
    expect(heard).toHaveBeenCalledTimes(2);
    expect(queue.take()).toEqual(['ls']);
  });
});

describe('keystrokes', () => {
  it('end every line with Enter and drop the block’s trailing blank lines', () => {
    expect(keystrokes('npm test')).toBe('npm test\r');
    expect(keystrokes('pip install rich\npython3 demo.py\n\n')).toBe('pip install rich\rpython3 demo.py\r');
    expect(keystrokes('a\r\nb')).toBe('a\rb\r');
  });
});
