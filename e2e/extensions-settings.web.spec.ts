import { expect, test } from '@playwright/test';

// The skills and the plugin come from the server's data dir (fixtures in e2e/serve.mjs). Installing hits GitHub,
// so the install flows are covered by the unit tests instead.

test('an admin turns a plugin off, which takes its skills out of every session, and back on', async ({ page }) => {
  await page.goto('/#/?settings=plugins');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const plugin = dialog.getByRole('list', { name: 'Installed plugins' }).getByRole('listitem').filter({ hasText: 'review-kit' });
  await expect(plugin).toContainText('1.0.0 · Reviews changes.');
  await plugin.getByRole('button', { name: '1 skill · 1 command' }).click();
  await expect(plugin.getByRole('list', { name: 'Skills in review-kit' })).toHaveText('review-kit:lint');
  await expect(plugin.getByRole('list', { name: 'Commands in review-kit' })).toHaveText('review-kit:ship');

  const toggle = plugin.getByRole('switch', { name: 'Enable review-kit' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(toggle).not.toBeChecked();

  await dialog.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills' }).click();
  await expect(dialog.getByText('e2e-style', { exact: true })).toBeVisible();
  await expect(dialog.getByText('review-kit:lint')).toHaveCount(0);

  // Back on, as the other specs expect.
  await dialog.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Plugins' }).click();
  await toggle.click();
  await expect(toggle).toBeChecked();
});

test('skills from the server’s folders are listed, and only the ones Atelier installed can be uninstalled', async ({ page }) => {
  await page.goto('/#/?settings=skills');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const skills = dialog.getByRole('list', { name: 'Skills' }).getByRole('listitem');
  await expect(skills).toHaveText([
    /^e2e-notesGlobalfrom atelier-e2e\/skills 0123456 · Takes notes for the E2E suite\./,
    'e2e-styleGlobalOnly by /e2e-styleHouse style, started by hand.',
    'review-kit:lintPluginLints the change.',
  ]);
  // Put there some other way: not Atelier's to remove.
  await expect(dialog.getByRole('button', { name: 'Uninstall e2e-style' })).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Uninstall e2e-notes' }).click();
  await page.getByRole('alertdialog', { name: 'Uninstall e2e-notes?' }).getByRole('button', { name: 'Uninstall' }).click();
  await expect(skills).toHaveCount(2);
  await page.reload();
  await expect(skills).toHaveText([/^e2e-style/, /^review-kit:lint/]);
});

test('folders explain in the browser that they come from the desktop app', async ({ page }) => {
  await page.goto('/#/?settings=folders');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByText('No folders yet. Folders come from the desktop app: open one there and it shows up here.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Open folder/ })).toHaveCount(0);
});
