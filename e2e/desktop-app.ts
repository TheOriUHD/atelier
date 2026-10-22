import { join } from 'node:path';
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
  await page.getByRole('button', { name: 'Run on this computer' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
}
