import { describe, expect, it } from 'vitest';
import { stepAside, stepBack, type SteppingWindow } from './step-aside.ts';

/** A window that records what happened to it. */
function fakeWindow({ visible = true, minimized = false, destroyed = false } = {}) {
  const calls: string[] = [];
  const win = {
    calls,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isDestroyed: () => destroyed,
    hide: () => void calls.push('hide'),
    minimize: () => {
      minimized = true;
      calls.push('minimize');
    },
    restore: () => {
      minimized = false;
      calls.push('restore');
    },
    showInactive: () => void calls.push('showInactive'),
  };
  return win as typeof win & SteppingWindow;
}

describe('Atelier stepping aside', () => {
  it('minimizes on Windows, where a hidden window loses its taskbar button', () => {
    const win = fakeWindow();
    expect(stepAside([win], 'win32')).toEqual([win]);
    expect(win.calls).toEqual(['minimize']);
  });

  it('hides on macOS, where the Dock icon stays', () => {
    const win = fakeWindow();
    stepAside([win], 'darwin');
    expect(win.calls).toEqual(['hide']);
  });

  it('leaves alone what the person hid or minimized, and doesn’t bring those back', () => {
    const minimized = fakeWindow({ minimized: true });
    const hidden = fakeWindow({ visible: false });
    expect(stepAside([minimized, hidden], 'win32')).toEqual([]);
    stepBack([]);
    expect([...minimized.calls, ...hidden.calls]).toEqual([]);
  });

  it('brings back a minimized window with restore, so a maximized one stays maximized', () => {
    const win = fakeWindow();
    stepBack(stepAside([win], 'win32'));
    expect(win.calls).toEqual(['minimize', 'restore']);
  });

  it('shows a hidden window again without taking the focus', () => {
    const win = fakeWindow();
    stepBack(stepAside([win], 'darwin'));
    expect(win.calls).toEqual(['hide', 'showInactive']);
  });

  it('skips a window closed meanwhile', () => {
    const win = fakeWindow({ destroyed: true });
    stepBack([win]);
    expect(win.calls).toEqual([]);
  });
});
