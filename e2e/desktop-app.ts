import { basename, join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery staple';

/**
 * Launches the built desktop app on throwaway dirs: `configDir` for the built-in backend and a Chromium
 * profile inside it for userData (connection choice, sign-in token, device id). The mock keychain keeps
 * test tokens out of the real one. ATELIER_E2E_APP points at a packaged executable instead
 * (e.g. release/mac-arm64/Atelier.app/Contents/MacOS/Atelier).
 */
export function launchDesktop(configDir: string, env: Record<string, string> = {}): Promise<ElectronApplication> {
  const packaged = process.env.ATELIER_E2E_APP;
  return electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : ['apps/desktop/dist/main.mjs']), `--user-data-dir=${join(configDir, 'chromium')}`, '--use-mock-keychain'],
    // The window stays hidden: a test run mustn't take the screen or focus from whoever is working here.
    env: { ...process.env, ATELIER_UPDATE_FEED: 'off', ATELIER_CONFIG_DIR: configDir, ATELIER_HIDE_WINDOW: process.env.ATELIER_SHOW_WINDOW ? '' : '1', ...env },
  });
}

/** First run on this computer: choose the built-in backend, then give a name (there is no password). */
export async function setUpLocal(page: Page, name = 'Tester'): Promise<void> {
  // The first screen comes once the app's backend is up, which on a busy build machine can take longer than a click waits.
  await page.getByRole('button', { name: 'Run on this computer' }).click({ timeout: 90_000 });
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
}

/**
 * A new chat that works in `folder` on this computer: + › Add folder › Open folder… from the home page (the app's folder
 * dialog must already be stubbed to pick it). Chat and Cowork are one, so this is how a task in a folder starts.
 */
export async function chatInFolder(page: Page, folder: string): Promise<void> {
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.getByRole('menuitem', { name: 'Add folder' }).click();
  await page.getByRole('menuitem', { name: 'Open folder…' }).click();
  // A folder is asked about once: trust it to work in it.
  await page.getByRole('button', { name: 'Trust workspace' }).click();
  await page.getByText(`In ${basename(folder)}`).waitFor();
}
