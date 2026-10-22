import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

test('desktop: Change setup… goes back to the first-run choice, and this computer’s chats are still there after choosing it again', async () => {
  const configDir = await tempConfigDir();
  let app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Run on this computer' }).click();
    await page.getByLabel('Your name').fill('Ada');
    await page.getByRole('button', { name: 'Continue' }).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('kept on this computer');
    await box.press('Enter');
    await expect(page.getByText('You said: kept on this computer')).toBeVisible();

    await page.evaluate(() => (location.hash = '#/?settings=account'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Change setup…' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Change setup?' });
    await expect(confirm.getByText('Your chats on this computer stay; choose “Run on this computer” again to get back to them.')).toBeVisible();
    await confirm.getByRole('button', { name: 'Change setup' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome to Atelier' })).toBeVisible();

    // The network search answers within about 3 s (nothing listens on 7340 in a test run, or a dev server does).
    const started = Date.now();
    const found = await page.evaluate(() => (window as unknown as { atelierDesktop: { discovery: { scan(f: () => void): Promise<unknown[]> } } }).atelierDesktop.discovery.scan(() => {}));
    expect(Array.isArray(found)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);

    // It stays that way after a restart.
    await app.close();
    app = await launchDesktop(configDir);
    const next = await app.firstWindow();
    await expect(next.getByRole('heading', { name: 'Welcome to Atelier' })).toBeVisible();
    await next.getByRole('button', { name: 'Run on this computer' }).click();
    await expect(next.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expect(next.getByRole('heading', { name: 'Set up Atelier' })).toHaveCount(0);
    // The fake model titles every chat this way.
    await next.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'Scripted demo chat' }).first().click();
    await expect(next.getByText('You said: kept on this computer')).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
