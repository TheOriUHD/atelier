import type { Display, Rectangle } from 'electron';
import { describe, expect, it } from 'vitest';
import { displayFor, moveAway, moveBack, type MovingWindow, type ScreenLike } from './move-away.ts';

const display = (id: number, x: number, width: number, height: number): Display =>
  ({ id, bounds: { x, y: 0, width, height }, workArea: { x, y: 0, width, height: height - 40 } }) as unknown as Display;
const LEFT = display(1, 0, 2560, 1440);
const RIGHT = display(2, 2560, 1920, 1080);

const fakeScreen = (displays: Display[]): ScreenLike => {
  const under = (x: number) => displays.find((d) => x >= d.bounds.x && x < d.bounds.x + d.bounds.width) ?? displays[0]!;
  return {
    getAllDisplays: () => displays,
    getDisplayMatching: (r: Rectangle) => under(r.x + r.width / 2),
    getDisplayNearestPoint: (p) => under(p.x),
    // Windows: the helper's physical pixels at 150%.
    screenToDipPoint: (p) => ({ x: p.x / 1.5, y: p.y / 1.5 }),
  };
};

class FakeWindow implements MovingWindow {
  constructor(
    public bounds: Rectangle,
    public maximized = false,
  ) {}
  isDestroyed = () => false;
  getBounds = () => this.bounds;
  getNormalBounds = () => this.bounds;
  isMaximized = () => this.maximized;
  maximize = () => void (this.maximized = true);
  unmaximize = () => void (this.maximized = false);
  setBounds = (b: Partial<Rectangle>) => void (this.bounds = { ...this.bounds, ...b });
  isMinimized = () => false;
  restore = () => {};
  isFullScreen = () => false;
}

describe('moving Atelier to another monitor', () => {
  it('moves the windows on the monitor it works on to the other one, fitting them in, and back as they were', () => {
    const screen = fakeScreen([LEFT, RIGHT]);
    const main = new FakeWindow({ x: 100, y: 50, width: 2200, height: 1300 }, true);
    const elsewhere = new FakeWindow({ x: 2700, y: 100, width: 800, height: 600 });
    const moved = moveAway(screen, [main, elsewhere], LEFT)!;
    expect(moved).toHaveLength(1);
    // Fitted into the smaller monitor's work area and maximized there again; the window already there didn't move.
    expect(main.bounds).toEqual({ x: 2560, y: 0, width: 1920, height: 1040 });
    expect(main.maximized).toBe(true);
    expect(elsewhere.bounds).toEqual({ x: 2700, y: 100, width: 800, height: 600 });
    moveBack(moved);
    expect(main.bounds).toEqual({ x: 100, y: 50, width: 2200, height: 1300 });
    expect(main.maximized).toBe(true);
  });

  it('moves nothing with one monitor', () => {
    const win = new FakeWindow({ x: 100, y: 50, width: 800, height: 600 });
    expect(moveAway(fakeScreen([LEFT]), [win], LEFT)).toBeNull();
    expect(win.bounds.x).toBe(100);
  });

  it('finds the helper’s monitor in Electron’s units, which differ on Windows', () => {
    const screen = fakeScreen([LEFT, RIGHT]);
    // The right monitor in physical pixels at 150%: its middle is at 4560, Electron's 3040.
    expect(displayFor(screen, { x: 3840, y: 0, width: 1440, height: 810 }, 'win32').id).toBe(2);
    expect(displayFor(screen, { x: 2560, y: 0, width: 1920, height: 1080 }, 'darwin').id).toBe(2);
  });
});
