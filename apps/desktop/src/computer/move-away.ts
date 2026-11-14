/**
 * While the assistant has the mouse and keyboard, Atelier's windows on the monitor it works on move to another monitor,
 * where they stay in view (its progress, a question it asks), and come back as they were when the turn ends (Settings ›
 * Computer use › Move Atelier to another monitor). Windows already on another monitor stay where they are.
 */
import type { BrowserWindow, Display, Point, Rectangle } from 'electron';
import type { HelperDisplay } from '@atelier/protocol';

export type MovingWindow = Pick<BrowserWindow, 'isDestroyed' | 'getBounds' | 'getNormalBounds' | 'isMaximized' | 'maximize' | 'unmaximize' | 'setBounds' | 'isMinimized' | 'restore' | 'isFullScreen'>;

/** The part of Electron's `screen` this needs; `screenToDipPoint` is Windows' (the helper speaks physical pixels there). */
export interface ScreenLike {
  getAllDisplays(): Display[];
  getDisplayMatching(rect: Rectangle): Display;
  getDisplayNearestPoint(point: Point): Display;
  screenToDipPoint?(point: Point): Point;
}

/** A window that moved, and how it was before. */
export interface Moved {
  win: MovingWindow;
  bounds: Rectangle;
  maximized: boolean;
}

/** Electron's display for the helper's: the one under its middle (converted to Electron's units on Windows). */
export function displayFor(screen: ScreenLike, display: Pick<HelperDisplay, 'x' | 'y' | 'width' | 'height'>, platform: NodeJS.Platform): Display {
  const middle = { x: Math.round(display.x + display.width / 2), y: Math.round(display.y + display.height / 2) };
  return screen.getDisplayNearestPoint(platform === 'win32' && screen.screenToDipPoint ? screen.screenToDipPoint(middle) : middle);
}

/** Whether a window is on `display` (most of it, as Electron decides). */
export function isOn(screen: ScreenLike, win: MovingWindow, display: Display): boolean {
  return screen.getDisplayMatching(win.getBounds()).id === display.id;
}

/**
 * Moves the windows on `controlled` to the largest other monitor, centred and no bigger than its work area, keeping a
 * maximized window maximized there; null when there is no other monitor (nothing moves).
 */
export function moveAway<W extends MovingWindow>(screen: ScreenLike, windows: W[], controlled: Display): Moved[] | null {
  const others = screen.getAllDisplays().filter((d) => d.id !== controlled.id);
  if (!others.length) return null;
  const target = others.reduce((a, b) => (b.workArea.width * b.workArea.height > a.workArea.width * a.workArea.height ? b : a));
  const moved: Moved[] = [];
  for (const win of windows) {
    if (win.isDestroyed() || win.isFullScreen() || !isOn(screen, win, controlled)) continue;
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    moved.push({ win, bounds, maximized });
    if (win.isMinimized()) win.restore();
    if (maximized) win.unmaximize();
    const area = target.workArea;
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    win.setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height });
    if (maximized) win.maximize();
  }
  return moved;
}

/** Puts the windows back where they were, maximized again where they had been. */
export function moveBack(moved: Moved[]): void {
  for (const { win, bounds, maximized } of moved) {
    if (win.isDestroyed()) continue;
    if (win.isMaximized()) win.unmaximize();
    win.setBounds(bounds);
    if (maximized) win.maximize();
  }
}
