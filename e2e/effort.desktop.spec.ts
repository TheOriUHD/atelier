import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { sendWhenIdle, tempConfigDir, tempRepo } from './fixtures.ts';

test('desktop Code: Ultracode from the composer reaches the model, and effort changes mid-conversation', async () => {
  test.setTimeout(120_000);
  // Code runs on the fake model with think levels, given the full prompt tier so Ultracode is offered.
  const think = 'fake/fake-think:14b';
  const configDir = await tempConfigDir({ models: { defaults: { code: think }, overrides: { [think]: { promptTier: 'full' } } } });
  const repo = await tempRepo();
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    await page.getByRole('button', { name: 'No folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open folder…' }).click();
    // A folder is asked about once: trust it to work in it.
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();

    // Every level, Low to Max (the model's own go to High; Extra and Max ask for more in words), plus Ultracode,
    // starting at the Recommended one.
    await page.getByRole('button', { name: 'Effort: Medium' }).click();
    const slider = page.getByRole('slider', { name: 'Effort' });
    await expect(slider).toHaveAttribute('aria-valuetext', 'Medium (Recommended)');
    await expect(slider).toHaveAttribute('aria-valuemax', '5');
    await slider.press('End');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Ultracode');
    // The popover says the level, with the usage mark beside it (its text is the hover), and nothing else.
    await expect(page.getByRole('dialog')).toContainText('Ultracode');
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Ultracode Usage, consumes far more Tokens/ })).toBeVisible();
    await expect(page.getByRole('dialog')).not.toContainText('Uses far more tokens');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Effort: Ultracode, high usage' })).toBeFocused();

    // The first request asks for the model's highest think level and carries the Ultracode note; the next one doesn't
    // repeat it.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill('request?');
    await box.press('Enter');
    await expect(page.getByText('think="high" ultracode=yes', { exact: true })).toBeVisible();
    await box.fill('request? still');
    await sendWhenIdle(page);
    await expect(page.getByText('think="high" ultracode=no', { exact: true })).toBeVisible();

    // In the session, a new level applies from the next message.
    await page.getByRole('button', { name: 'Effort: Ultracode, high usage' }).click();
    await expect(slider).toBeVisible();
    await slider.press('Home');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Effort: Low' })).toBeVisible();
    // The model hears once that Ultracode is off.
    await box.fill('request? again');
    await sendWhenIdle(page);
    await expect(page.getByText('think="low" ultracode=off', { exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
