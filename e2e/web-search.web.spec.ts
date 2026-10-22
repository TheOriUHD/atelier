import { expect, test } from '@playwright/test';

/**
 * The server's search engines are the fake server's result pages (e2e/serve.mjs sets ATELIER_SEARCH_BASE). The engines'
 * rate limits and breakers are the server's, shared by every chat, so these run one after another, and searches wait
 * the few seconds a real DuckDuckGo request would.
 */
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });
const SEEN = { timeout: 25_000 };

async function ask(page: import('@playwright/test').Page, text: string) {
  await page.goto('/#/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

test('web search works in a new chat with nothing set up', async ({ page }) => {
  await ask(page, 'search for atelier notes');
  // DuckDuckGo answers first; once a test has had it blocked, its breaker is open for a while and Brave answers.
  await expect(page.getByText(/Tool result: 1\. (About atelier notes|atelier notes on Brave)/)).toBeVisible(SEEN);
});

test('another engine answers when the first one is blocked', async ({ page }) => {
  await ask(page, 'search for blocked topic');
  await expect(page.getByText(/Tool result: 1\. blocked topic on Brave/)).toBeVisible(SEEN);
});

test('Settings shows search on, with nothing to configure, and tests it', async ({ page }) => {
  await page.goto('/#/?settings=capabilities');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('switch', { name: 'Web search' })).toBeChecked();
  await expect(dialog.getByLabel('SearXNG URL')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Test search' }).click();
  await expect(dialog.getByText(/answered in .* with \d+ results?/)).toBeVisible(SEEN);
});
