import { expect, test, type Page } from '@playwright/test';

const COUNT = 'Counting slowly: ' + Array.from({ length: 60 }, (_, i) => i + 1).join(', ') + '.';

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

test('a first message creates a chat, streams the reply and titles it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Tester · / })).toBeVisible();
  await send(page, 'Show me some markdown');
  await expect(page).toHaveURL(/#\/chat\//);
  await expect(page.getByText('Sorting at a glance')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByText('Sorting algorithms compared')).toBeVisible();
});

test('reloading mid-stream resumes the reply without losing or repeating text', async ({ page }) => {
  await page.goto('/');
  await send(page, 'count slow');
  await expect(page.getByText(/Counting slowly: 1, 2, 3/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(COUNT, { exact: true })).toBeVisible({ timeout: 30_000 });
});

test('stop keeps the partial reply and retry adds a second version', async ({ page }) => {
  await page.goto('/');
  await send(page, 'slow please');
  await expect(page.getByText(/Counting slowly: 1, 2, 3, 4, 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  const partial = await page.getByText(/^Counting slowly:/).innerText();
  expect(partial.length).toBeLessThan(COUNT.length);

  // The retried reply streams as a second version; actions (and the ‹ 2/2 › switcher) show once it ends.
  await page.getByRole('button', { name: 'Retry' }).last().click();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('2/2')).toBeVisible();
  await page.getByRole('button', { name: 'Previous version' }).click();
  await expect(page.getByText('1/2')).toBeVisible();
  await expect(page.getByText(/^Counting slowly:/)).toHaveText(partial);
});
