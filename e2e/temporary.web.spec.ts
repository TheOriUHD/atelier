import { expect, test } from '@playwright/test';

test('a temporary chat stays out of the sidebar and search, and is gone once left', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Temporary chat' }).click();
  await expect(page.getByRole('heading', { name: 'You’re in a temporary chat' })).toBeVisible();
  await expect(page.getByText(/deleted when you leave them/)).toBeVisible();

  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('zebracorn temporary question');
  await box.press('Enter');
  await expect(page).toHaveURL(/#\/chat\//);
  const chat = page.url();
  const id = chat.split('/chat/')[1]!;
  await expect(page.getByRole('button', { name: 'Leave temporary chat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 20_000 });

  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.locator(`a[href$="/chat/${id}"]`)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await palette.getByRole('combobox').fill('zebracorn');
  await expect(palette.getByText('No chats match “zebracorn”.')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Leave temporary chat' }).click();
  await expect(page.getByRole('button', { name: 'Temporary chat' })).toBeVisible();
  // The leave goes out a moment after the page lets go of the chat.
  await page.waitForTimeout(1_500);
  await page.goto(chat);
  await expect(page.getByRole('alert')).toHaveText('That conversation no longer exists.');
});
