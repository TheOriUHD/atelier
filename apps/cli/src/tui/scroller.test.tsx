import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Paint, palette } from '../style.ts';
import type { ClickListener, WheelListener } from './mouse.ts';
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
  const mouse = { onWheel: (fn: WheelListener) => (listeners.add(fn), () => void listeners.delete(fn)), onClick: (_fn: ClickListener) => () => undefined };
  const view = (f: number, n: number) => (
    <Box flexDirection="column" height={8}>
      <Scroller paint={paint} mouse={mouse} active follow={f}>
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

describe('clicks in the fullscreen conversation', () => {
  it('tells which row was clicked, through the scrolling', async () => {
    const { Clickable } = await import('./scroller.tsx');
    const wheels = new Set<WheelListener>();
    const clicks = new Set<ClickListener>();
    const mouse = { onWheel: (fn: WheelListener) => (wheels.add(fn), () => void wheels.delete(fn)), onClick: (fn: ClickListener) => (clicks.add(fn), () => void clicks.delete(fn)) };
    const hit: string[] = [];
    const ui = render(
      <Box flexDirection="column" height={8}>
        <Scroller paint={paint} mouse={mouse} active follow={0} onClick={(id) => hit.push(id)}>
          <Text>header</Text>
          {Array.from({ length: 10 }, (_, i) => (
            <Clickable key={i} id={`row ${i + 1}`}>
              <Text>{`row ${i + 1}\nits second line`}</Text>
            </Clickable>
          ))}
        </Scroller>
        <Box flexShrink={0}>
          <Text>› message box</Text>
        </Box>
      </Box>,
    );
    const f = () => ui.lastFrame()!;
    // What is drawn, and a moment for the rows to be registered after it.
    const settled = async (check: (x: string) => boolean) => (await until(f, check), await new Promise((r) => setTimeout(r, 50)), f());
    await settled((x) => x.includes('row 10'));
    const click = (y: number) => clicks.forEach((fn) => fn({ x: 1, y }));
    // Following the bottom: the window's six rows are rows 8 to 10, two lines each.
    const screen = f().split('\n');
    click(screen.indexOf('row 9'));
    click(screen.indexOf('row 9') + 1);
    expect(hit).toEqual(['row 9', 'row 9']);
    // Scrolled to the top: the header, then row 1.
    wheels.forEach((fn) => fn(-30));
    click((await settled((x) => x.includes('header'))).split('\n').indexOf('row 1'));
    // The message box and the line below the window are not the conversation.
    click(7);
    click(6);
    expect(hit).toEqual(['row 9', 'row 9', 'row 1']);
  });
});
