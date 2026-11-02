import { describe, expect, it } from 'vitest';
import { AppWindows } from './app-windows.ts';

const window = (destroyed = false) => ({ isDestroyed: () => destroyed });

describe('AppWindows', () => {
  it('puts the window used last first', () => {
    const windows = new AppWindows<ReturnType<typeof window>>();
    const [a, b] = [window(), window()];
    windows.add(a);
    windows.add(b);
    windows.focused(b);
    expect(windows.list()).toEqual([b, a]);
  });

  it('never picks a window that is not one of its own, even after it had focus', () => {
    const windows = new AppWindows<ReturnType<typeof window>>();
    const main = window();
    windows.add(main);
    windows.focused(window());
    expect(windows.list()).toEqual([main]);
  });

  it('has nothing to offer once its windows closed, whatever else is open', () => {
    const windows = new AppWindows<ReturnType<typeof window>>();
    const main = window();
    windows.add(main);
    windows.focused(main);
    windows.remove(main);
    expect(windows.list()).toEqual([]);
  });

  it('skips a destroyed window', () => {
    const windows = new AppWindows<ReturnType<typeof window>>();
    windows.add(window(true));
    expect(windows.list()).toEqual([]);
  });
});
