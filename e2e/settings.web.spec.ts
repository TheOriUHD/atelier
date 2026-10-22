import { expect, test } from '@playwright/test';

test('the web provider wizard offers ChatGPT Plan sign-in', async ({ page }) => {
  await page.goto('/#/?settings=providers');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Add provider' }).click();
  await page.getByRole('dialog', { name: 'Add provider' }).getByRole('button', { name: /^ChatGPT Plan/ }).click();
  const signIn = page.getByRole('dialog', { name: 'Add ChatGPT Plan' });
  await expect(signIn.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeVisible();
  await expect(signIn).toContainText('Everyone who can use this provider uses your plan.');
  await expect(signIn).not.toContainText('It only works in the desktop app');
  await signIn.getByRole('button', { name: 'Cancel' }).click();
  await expect(signIn).toBeHidden();
});

test('personality custom modes can be created and persist across reload', async ({ page }) => {
  await page.goto('/#/?settings=account');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Add custom mode', exact: true }).click();
  const mode = page.getByRole('dialog', { name: 'Add custom mode', exact: true });
  await mode.getByRole('textbox', { name: 'Mode name', exact: true }).fill('Patient tutor');
  await mode.getByRole('textbox', { name: 'Style instructions', exact: true }).fill('Use calm, practical explanations and one guiding question.');
  await mode.getByRole('button', { name: /save/i }).click();
  await expect(mode).toBeHidden();
  await expect(settings.getByRole('button', { name: 'Edit mode', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Edit mode', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit custom mode', exact: true });
  await expect(edit.getByRole('textbox', { name: 'Mode name', exact: true })).toHaveValue('Patient tutor');
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Delete mode', exact: true }).click();
});

test('settings search jumps to the row and highlights it; changes apply live', async ({ page }) => {
  await page.goto('/');
  // The shortcut works once the sign-in check has let the app in.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('searchbox', { name: 'Search settings' }).or(dialog.getByRole('textbox', { name: 'Search settings' })).fill('chat font');
  // The highlight lasts a couple of frames, too short to catch on a busy machine: record which rows get it.
  await page.evaluate(() => {
    const flashed: string[] = [];
    (window as unknown as { flashed: string[] }).flashed = flashed;
    new MutationObserver((records) => {
      for (const r of records) if (r.target instanceof HTMLElement && r.target.hasAttribute('data-flash')) flashed.push(r.target.textContent ?? '');
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-flash'] });
  });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/settings=general/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { flashed: string[] }).flashed.join('|'))).toContain('Chat font');

  // Theme applies to the whole app immediately.
  await dialog.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
