/**
 * While Atelier has the mouse and keyboard: a glow around the edges of every display, and on the main one a small
 * "Atelier is using your computer · Hold Esc to stop" with a ring that fills while Esc is held. The windows take no
 * clicks and no focus, sit above everything (full-screen apps too), and are left out of screenshots.
 */
import { BrowserWindow, screen } from 'electron';
import type { Overlay } from './controller.ts';

const page = (withPopup: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-user-select:none;cursor:default}
.glow{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 3px rgba(217,119,87,.85),inset 0 0 26px 6px rgba(217,119,87,.4);animation:breathe 2.4s ease-in-out infinite}
@keyframes breathe{50%{box-shadow:inset 0 0 0 3px rgba(217,119,87,1),inset 0 0 40px 12px rgba(217,119,87,.55)}}
.pill{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:8px 16px 8px 12px;border-radius:12px;background:rgba(28,28,27,.88);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.28);-webkit-backdrop-filter:blur(14px)}
.pill b{display:block;font-size:14px;line-height:20px;font-weight:600}
.pill span{display:block;font-size:12px;line-height:16px;opacity:.72}
.ring{width:18px;height:18px;flex:none;border-radius:50%;background:conic-gradient(#D97757 var(--p,0%),rgba(255,255,255,.22) 0)}
@media (prefers-reduced-motion: reduce){.glow{animation:none}}
</style></head><body>
<div class="glow"></div>
${withPopup ? '<div class="pill" role="status"><div class="ring" id="ring"></div><div><b id="title">Atelier is using your computer</b><span id="hint">Hold Esc to stop</span></div></div>' : ''}
<script>
let timer = null;
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
</script></body></html>`;

export function createOverlay(): Overlay {
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
    show() {
      if (closing) close();
      if (windows.length) return;
      const primary = screen.getPrimaryDisplay().id;
      for (const display of screen.getAllDisplays()) {
        const win = new BrowserWindow({
          ...display.bounds,
          transparent: true,
          frame: false,
          focusable: false,
          skipTaskbar: true,
          hasShadow: false,
          resizable: false,
          movable: false,
          show: false,
          alwaysOnTop: true,
          enableLargerThanScreen: true,
          ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        win.setIgnoreMouseEvents(true);
        win.setAlwaysOnTop(true, 'screen-saver');
        // Without skipTransformProcessType, Electron turns the whole app into a UIElement app (no Dock icon, no menu,
        // its windows gone) and never turns it back.
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        win.setContentProtection(true);
        win.once('ready-to-show', () => win.showInactive());
        void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(display.id === primary))}`);
        windows.push(win);
      }
    },
    hide() {
      if (!closing) close();
    },
    esc(phase) {
      for (const win of windows) if (!win.isDestroyed()) void win.webContents.executeJavaScript(`esc(${JSON.stringify(phase)})`).catch(() => undefined);
      if (phase === 'stopped' && windows.length && !closing) closing = setTimeout(close, 1500);
    },
  };
}
