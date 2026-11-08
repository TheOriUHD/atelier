import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Paint, palette } from '../style.ts';
import type { WheelListener } from './mouse.ts';
import { Scroller } from './scroller.tsx';

const paint = new Paint(palette('dark', 0));
/** Until the screen satisfies `check` (the layout settles over a couple of renders), at most three seconds. */
async function until(frame: () => string, check: (f: string) => boolean): Promise<string> {
  for (let i = 0; i < 150 && !check(frame()); i++) await new Promise((r) => setTimeout(r, 20));
  return frame();
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => <Text key={i}>{`line ${i + 1}`}</Text>);

function setup(count: number, follow = 0) {
  const listeners = new Set<WheelListener>();
  const wheel = { on: (fn: WheelListener) => (listeners.add(fn), () => void listeners.delete(fn)) };
  const view = (f: number, n: number) => (
    <Box flexDirection="column" height={8}>
      <Scroller paint={paint} wheel={wheel} active follow={f}>
        {lines(n)}
      </Scroller>
      <Box flexShrink={0}>
        <Text>› message box</Text>
      </Box>
    </Box>
  );
  const ui = render(view(follow, count));
  return { ui, turn: (n: number) => listeners.forEach((fn) => fn(n)), rerender: (f: number, n: number) => ui.rerender(view(f, n)) };
}

describe('the fullscreen conversation', () => {
  it('starts at the top when it fits, with the message box at the bottom', async () => {
    const { ui } = setup(3);
    await until(() => ui.lastFrame()!, (x) => x.includes('message box'));
    const frame = ui.lastFrame()!.split('\n');
    expect(frame[0]).toBe('line 1');
    expect(frame.at(-1)).toBe('› message box');
  });

  it('follows the newest lines, scrolls with the wheel and holds its place, and comes back down', async () => {
    const { ui, turn, rerender } = setup(30);
    const f = () => ui.lastFrame()!;
    await until(f, (x) => x.includes('line 30'));
    expect(f()).not.toContain('line 20\n');
    turn(-3);
    turn(-3);
    await until(f, (x) => x.includes('more lines below'));
    // Six lines up: the window's six rows show lines 19 to 24, and the row below it says what is left.
    expect(ui.lastFrame()!.split('\n').slice(0, 2)).toEqual(['line 19', 'line 20']);
    expect(ui.lastFrame()).not.toContain('line 30');
    expect(ui.lastFrame()).toMatch(/↓ 6 more lines below/);
    // A reply goes on while scrolled up: the view stays where it is.
    rerender(0, 40);
    await until(f, (x) => x.includes('16 more lines'));
    expect(ui.lastFrame()!.split('\n')[0]).toBe('line 19');
    // Page Down to the bottom, and it follows again.
    for (let i = 0; i < 8; i++) ui.stdin.write('\x1b[6~');
    await until(f, (x) => x.includes('line 40'));
    expect(ui.lastFrame()).toContain('line 40');
    expect(ui.lastFrame()).not.toContain('more lines below');
    rerender(0, 45);
    await until(f, (x) => x.includes('line 45'));
    expect(ui.lastFrame()).toContain('line 45');
  });

  it('goes back to the bottom when a message is sent', async () => {
    const { ui, turn, rerender } = setup(30);
    const f = () => ui.lastFrame()!;
    await until(f, (x) => x.includes('line 30'));
    turn(-9);
    await until(f, (x) => !x.includes('line 30'));
    expect(f()).not.toContain('line 30');
    rerender(1, 31);
    await until(f, (x) => x.includes('line 31'));
    expect(f()).toContain('line 31');
  });
});
