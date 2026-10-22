import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { settled, tempConfigDir } from './fixtures.ts';

test('the desktop app boots its backend and streams a reply over IPC', async () => {
  const configDir = await tempConfigDir();
  let app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Tester · / })).toBeVisible();
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('hello from the desktop');
    await box.press('Enter');
    await expect(page.getByText('You said: hello from the desktop')).toBeVisible();

    // The sign-in survives a restart: main keeps the token in safeStorage and hands it to the backend.
    await app.close();
    app = await launchDesktop(configDir);
    await expect((await app.firstWindow()).getByRole('textbox', { name: 'Message' })).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('desktop: an artifact runs in the panel from the atelier-artifact scheme', async () => {
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('make an artifact');
    await box.press('Enter');
    await page.getByRole('button', { name: 'Open' }).click();
    // The preview stays hidden behind a skeleton until the runtime reports it rendered.
    await expect(page.locator('[aria-busy="false"]:has(iframe[title="Artifact preview"])')).toBeVisible();
    // Clicks inside a frame are only checked for stability within the frame: wait until the sliding panel settles.
    await settled(page.locator('iframe[title="Artifact preview"]'));
    const frame = page.frameLocator('iframe[title="Artifact preview"]');
    await frame.getByRole('button', { name: 'Clicked 0 times' }).click();
    await expect(frame.getByRole('button', { name: 'Clicked 1 times' })).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
