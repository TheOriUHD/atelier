// The app that computer-linux.desktop.spec.ts controls: an Electron window covering the whole screen with one text field,
// so that a click anywhere lands in it whatever the screenshot's scale. The spec gives it a desktop entry (by its window class) so that it is an app of its own.
import { app, BrowserWindow, screen } from 'electron';

app.whenReady().then(() => {
  const { width, height } = screen.getPrimaryDisplay().size;
  const win = new BrowserWindow({ x: 0, y: 0, width, height, frame: false, title: 'E2E target', webPreferences: { sandbox: true } });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>E2E target</title><input id="field" aria-label="Field" style="position:fixed;inset:0;width:100%;height:100%;font-size:40px;box-sizing:border-box">'));
});
app.on('window-all-closed', () => app.quit());
