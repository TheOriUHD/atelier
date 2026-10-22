import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

test('desktop: this computer has no password, and its optional screen lock hides the app until the PIN is entered', async () => {
  const configDir = await tempConfigDir();
  let app = await launchDesktop(configDir);
  try {
    let page = await app.firstWindow();
    await setUpLocal(page, 'Ada');
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

    await page.evaluate(() => (location.hash = '#/?settings=account'));
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByRole('heading', { name: 'Screen lock' })).toBeVisible();
    await expect(settings.getByText('Active sessions')).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Change password' })).toHaveCount(0);

    await settings.getByRole('button', { name: 'Set up' }).click();
    const setUp = page.getByRole('dialog', { name: 'Set up a screen lock' });
    await setUp.getByLabel('New PIN').fill('2468');
    await setUp.getByLabel('Confirm PIN').fill('2468');
    await setUp.getByRole('button', { name: 'Turn on' }).click();
    await expect(settings.getByText('On, with a PIN.')).toBeVisible();

    await settings.getByRole('button', { name: 'Lock now' }).click();
    await expect(page.getByRole('heading', { name: 'Atelier is locked' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
    await page.getByLabel('PIN').fill('1357');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('That PIN is wrong.')).toBeVisible();
    await page.getByLabel('PIN').fill('2468');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('heading', { name: 'Atelier is locked' })).toHaveCount(0);

    // The next launch starts locked, and nobody is asked for a password.
    await app.close();
    app = await launchDesktop(configDir);
    page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Atelier is locked' })).toBeVisible();
    await page.getByLabel('PIN').fill('2468');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
