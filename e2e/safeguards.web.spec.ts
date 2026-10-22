import { expect, test, type Page } from '@playwright/test';

/** A new chat asking the fake model whether the optional content settings block reached its system prompt. */
async function ask(page: Page) {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('safeguards?');
  await box.press('Enter');
  await expect(page).toHaveURL(/#\/chat\//);
}

async function setOwnSafeguards(page: Page, option: RegExp) {
  await page.goto('/#/?settings=users');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const select = dialog.getByRole('combobox', { name: 'Safeguards for Tester' });
  await select.click();
  await page.getByRole('option', { name: option }).click();
  await expect(select).toContainText(option);
  await page.keyboard.press('Escape');
}

test('extra safeguards add nothing by default, and an admin turns them on for one person', async ({ page }) => {
  await ask(page);
  await expect(page.getByText('Content settings block: absent.')).toBeVisible();

  // Admin › Capabilities lists the categories; the switch for everyone stays off.
  await page.goto('/#/?settings=capabilities');
  const capabilities = page.getByRole('dialog', { name: 'Settings' });
  await expect(capabilities.getByRole('switch', { name: 'Extra safeguards for everyone' })).toHaveAttribute('aria-checked', 'false');
  await expect(capabilities.getByRole('switch', { name: 'Explicit sexual content' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await setOwnSafeguards(page, /^On$/);
  await ask(page);
  await expect(page.getByText('Content settings block: present.')).toBeVisible();

  await setOwnSafeguards(page, /^Default \(off\)$/);
  await ask(page);
  await expect(page.getByText('Content settings block: absent.')).toBeVisible();
});
