import type { BrowserWindow } from 'electron';

export type SteppingWindow = Pick<BrowserWindow, 'hide' | 'isDestroyed' | 'isMinimized' | 'isVisible' | 'minimize' | 'restore' | 'showInactive'>;

/**
 * Moves Atelier's windows out of the way of clicks while it has the computer, and says which it moved. On Windows a
 * hidden window loses its taskbar button, and Atelier has no tray icon, so it would look like it quit: there they
 * minimize. A window the person minimized themselves is left to them.
 */
export function stepAside<W extends SteppingWindow>(windows: W[], platform: NodeJS.Platform): W[] {
  const moved = windows.filter((w) => w.isVisible() && !w.isMinimized());
  for (const win of moved) {
    if (platform === 'win32') win.minimize();
    else win.hide();
  }
  return moved;
}

/** Brings them back as they were: `restore` is what returns a minimized window to maximized, without it they'd come back smaller. */
export function stepBack(windows: SteppingWindow[]): void {
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    if (win.isMinimized()) win.restore();
    else win.showInactive();
  }
}
