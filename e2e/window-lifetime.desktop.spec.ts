import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

/** A window like the ChatGPT Chat browser: hidden, kept open by closing to hidden, and focused once, as a sign-in does. */
const addHiddenWindow = (app: ElectronApplication) =>
  app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const hidden = new BrowserWindow({ show: false, title: 'hidden' });
    hidden.on('close', (event) => event.preventDefault());
    electronApp.once('before-quit', () => hidden.destroy());
    electronApp.emit('browser-window-focus', {}, hidden);
  });

const windows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible() })));

test('desktop: a hidden window never stands in for Atelier’s own', async () => {
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    await app.firstWindow();
    await addHiddenWindow(app);
    const closed = app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'hidden')?.close());
    if (process.platform === 'darwin') {
      await closed;
      await expect.poll(async () => (await windows(app)).length).toBe(1);
      // The Dock icon, then opening the app again: there is one new real window, and the hidden one stays hidden.
      await app.evaluate(({ app: electronApp }) => void electronApp.emit('activate'));
      await expect.poll(async () => (await windows(app)).filter((w) => w.title !== 'hidden').length).toBe(1);
      // As a second copy hands over: its arguments come along (an `atelier://` link among them, on Windows and Linux).
      await app.evaluate(({ app: electronApp }) => void electronApp.emit('second-instance', {}, ['Atelier'], ''));
      expect((await windows(app)).filter((w) => w.title !== 'hidden')).toHaveLength(1);
      expect((await windows(app)).find((w) => w.title === 'hidden')?.visible).toBe(false);
    } else {
      // With its last real window gone Atelier quits, however many hidden ones are left.
      const gone = app.waitForEvent('close');
      await closed.catch(() => undefined);
      await gone;
    }
  } finally {
    await app.close().catch(() => undefined);
    await rm(configDir, { recursive: true, force: true });
  }
});
