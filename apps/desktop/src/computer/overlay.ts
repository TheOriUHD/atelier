/**
 * While Atelier has the mouse and keyboard: a soft glow along the edges of every display (no hard line, so it suits
 * rounded and square screens alike), and on the main one, below the menu bar, a small "Atelier is using your
 * computer · Hold Esc to stop" with a ring that fills while Esc is held. The windows take no
 * clicks and no focus, sit above everything (full-screen apps too), and are left out of screenshots.
 *
 * Linux (X11) draws it differently, for two reasons that have no other answer there. A transparent window needs a
 * compositing manager, and many X sessions run without one (a transparent window is then drawn black and would cover the
 * screen), so the windows are opaque and cut to their shape: a thin frame along the edges instead of a soft glow, and a
 * pill with rounded corners. And X11 has no way to keep a window out of a screenshot, so the windows are cut down to a
 * single pixel for the moment a screenshot is taken (`capturing`).
 */
import { BrowserWindow, screen } from 'electron';
import type { Rectangle } from './overlay-shape.ts';
import type { Overlay } from './controller.ts';
import { frameShape, roundedShape } from './overlay-shape.ts';

/** What the popup's page does: shows that it waits for the person, and the Esc hold filling its ring. */
const POPUP_SCRIPT = `let timer = null;
function paused(on) {
  const title = document.getElementById('title');
  if (!title || title.textContent === 'Stopped') return;
  title.textContent = on ? 'Waiting while you use your computer' : 'Atelier is using your computer';
}
function esc(phase) {
  const ring = document.getElementById('ring');
  if (!ring) return;
  clearInterval(timer);
  if (phase === 'down') {
    const start = Date.now();
    timer = setInterval(() => ring.style.setProperty('--p', Math.min(100, (Date.now() - start) / 10) + '%'), 30);
  } else if (phase === 'up') {
    ring.style.setProperty('--p', '0%');
  } else {
    ring.style.setProperty('--p', '100%');
    document.getElementById('title').textContent = 'Stopped';
    document.getElementById('hint').textContent = 'You have your computer back';
  }
}
`;

/** `top`: where the popup sits, below the menu bar (and a notch, which sits in it). */
const page = (withPopup: boolean, top: number) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-user-select:none;cursor:default}
.glow{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 36px 6px rgba(217,119,87,.5),inset 0 0 120px 24px rgba(217,119,87,.26);animation:breathe 3s ease-in-out infinite}
@keyframes breathe{50%{box-shadow:inset 0 0 48px 10px rgba(217,119,87,.62),inset 0 0 160px 36px rgba(217,119,87,.34)}}
.pill{position:fixed;top:${top}px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:8px 16px 8px 12px;border-radius:12px;background:rgba(28,28,27,.88);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.28);-webkit-backdrop-filter:blur(14px)}
.pill b{display:block;font-size:14px;line-height:20px;font-weight:600}
.pill span{display:block;font-size:12px;line-height:16px;opacity:.72}
.ring{width:18px;height:18px;flex:none;border-radius:50%;background:conic-gradient(#D97757 var(--p,0%),rgba(255,255,255,.22) 0)}
@media (prefers-reduced-motion: reduce){.glow{animation:none}}
</style></head><body>
<div class="glow"></div>
${withPopup ? '<div class="pill" role="status"><div class="ring" id="ring"></div><div><b id="title">Atelier is using your computer</b><span id="hint">Hold Esc to stop</span></div></div>' : ''}
<script>
${POPUP_SCRIPT}</script></body></html>`;

/** The overlay, and which windows are its (Atelier's own windows are the others). */
export type ScreenOverlay = Overlay & { owns(win: BrowserWindow): boolean };

const linux = process.platform === 'linux';

/** How thick the frame along the edges is on Linux, in DIPs. */
const FRAME_EDGE = 5;
/** How long a screenshot waits after the overlay got out of the way, for the X server and a compositor to draw it. */
const CAPTURE_SETTLE_MS = 60;

/** The popup on Linux, in a window of its own: the same content, solid, filling the window (its corners are cut by the shape). */
const pillPage = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#1c1c1b;color:#fff;font-family:system-ui,"Segoe UI",sans-serif;-webkit-user-select:none;cursor:default}
.pill{display:flex;align-items:center;gap:10px;height:100%;padding:0 16px 0 12px;box-sizing:border-box}
.pill b{display:block;font-size:14px;line-height:20px;font-weight:600}
.pill span{display:block;font-size:12px;line-height:16px;opacity:.72}
.ring{width:18px;height:18px;flex:none;border-radius:50%;background:conic-gradient(#D97757 var(--p,0%),rgba(255,255,255,.22) 0)}
</style></head><body>
<div class="pill" role="status"><div class="ring" id="ring"></div><div><b id="title">Atelier is using your computer</b><span id="hint">Hold Esc to stop</span></div></div>
<script>
${POPUP_SCRIPT}</script></body></html>`;

/** The accent frame of one display, on Linux: a solid page, cut to the frame by the window's shape. */
const framePage = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#D97757;overflow:hidden}</style></head><body><script>function paused(){}function esc(){}</script></body></html>`;

/** What a window of the overlay shows through while a screenshot is taken: one pixel. */
const HIDDEN_SHAPE: Rectangle[] = [{ x: 0, y: 0, width: 1, height: 1 }];

/** The "Atelier is using your computer" pill on Linux: an opaque window with rounded corners, in the middle below the panel. */
function linuxPill(
  display: Electron.Display,
  top: number,
  base: (bounds: Rectangle) => Electron.BrowserWindowConstructorOptions,
  shape: (win: BrowserWindow, rects: Rectangle[]) => void,
  shapes: Map<BrowserWindow, Rectangle[]>,
): BrowserWindow {
  const width = 300;
  const height = 56;
  const win = new BrowserWindow(base({ x: Math.round(display.bounds.x + (display.bounds.width - width) / 2), y: display.bounds.y + top, width, height }));
  shape(win, roundedShape(width, height, 12));
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.once('ready-to-show', () => win.showInactive());
  win.once('closed', () => shapes.delete(win));
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pillPage)}`);
  return win;
}

export function createOverlay(): ScreenOverlay {
  /** The shape each window has on Linux, to put back after a screenshot. */
  const shapes = new Map<BrowserWindow, Rectangle[]>();
  /** The same window options everywhere; on Linux opaque (no compositor is needed), elsewhere transparent. */
  const base = (bounds: Rectangle) => ({
    ...bounds,
    transparent: !linux,
    ...(linux ? { backgroundColor: '#1c1c1b' } : {}),
    frame: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    show: false,
    alwaysOnTop: true,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  /** Shapes the window (Linux), then makes it take no clicks: the helper sees a window with no input area as click-through. */
  const shape = (win: BrowserWindow, rects: Rectangle[]) => {
    if (!linux) return;
    shapes.set(win, rects);
    win.setShape(rects);
    win.setIgnoreMouseEvents(true);
  };
  let windows: BrowserWindow[] = [];
  /** After a stop, "Stopped" stays a moment so the person sees it took. */
  let closing: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    if (closing) clearTimeout(closing);
    closing = null;
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    windows = [];
  };
  return {
    owns: (win) => windows.includes(win),
    show() {
      if (closing) close();
      if (windows.length) return;
      const primary = screen.getPrimaryDisplay().id;
      for (const display of screen.getAllDisplays()) {
        const win = new BrowserWindow({ ...base(display.bounds), enableLargerThanScreen: true });
        win.setIgnoreMouseEvents(true);
        win.setAlwaysOnTop(true, 'screen-saver');
        // Without skipTransformProcessType, Electron turns the whole app into a UIElement app (no Dock icon, no menu,
        // its windows gone) and never turns it back.
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        win.setContentProtection(true);
        win.once('ready-to-show', () => win.showInactive());
        // The menu bar's height (the work area starts below it), plus a little air.
        const top = Math.max(0, display.workArea.y - display.bounds.y) + 10;
        if (linux) {
          // The frame on every display, and the pill in a window of its own on the main one.
          shape(win, frameShape(display.bounds.width, display.bounds.height, FRAME_EDGE));
          void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(framePage)}`);
          win.once('closed', () => shapes.delete(win));
          windows.push(win);
          if (display.id === primary) windows.push(linuxPill(display, top, base, shape, shapes));
          continue;
        }
        void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(display.id === primary, top))}`);
        windows.push(win);
      }
    },
    hide() {
      if (!closing) close();
    },
    // Linux only: the windows shrink to a pixel while a screenshot is taken (the compositor, if any, needs a moment to
    // draw the change), and are cut to their shape again after.
    ...(linux
      ? {
          async capturing(on: boolean) {
            const all = windows.filter((w) => !w.isDestroyed());
            for (const win of all) win.setShape(on ? HIDDEN_SHAPE : (shapes.get(win) ?? HIDDEN_SHAPE));
            if (on && all.length) await new Promise((resolve) => setTimeout(resolve, CAPTURE_SETTLE_MS));
          },
        }
      : {}),
    paused(on) {
      for (const win of windows) if (!win.isDestroyed()) void win.webContents.executeJavaScript(`paused(${on})`).catch(() => undefined);
    },
    esc(phase) {
      for (const win of windows) if (!win.isDestroyed()) void win.webContents.executeJavaScript(`esc(${JSON.stringify(phase)})`).catch(() => undefined);
      if (phase === 'stopped' && windows.length && !closing) closing = setTimeout(close, 1500);
    },
  };
}
