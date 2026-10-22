import { expect, test } from '@playwright/test';

test('/btw asks a side question while the chat keeps working, in a panel of its own', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' }).first();
  await box.fill('count slowly for me');
  await box.press('Enter');
  await expect(page).toHaveURL(/#\/chat\//);
  await expect(page.getByText('Counting slowly')).toBeVisible();

  // The command is offered with what it does.
  await box.fill('/bt');
  await expect(page.getByText('Ask a side question without interrupting')).toBeVisible();
  await box.fill('/btw what is this chat about?');
  await box.press('Enter');

  const panel = page.getByRole('region', { name: 'Side chat' });
  await expect(panel.getByRole('group', { name: 'Side chats' }).getByRole('button', { name: 'what is this chat about?', exact: true })).toBeVisible();
  // Asked while the chat runs, which goes on undisturbed; nothing of the side chat joins it. (The fake model server
  // answers one request at a time, so the answer may come after the chat's reply.)
  // Its tab and the person's bubble.
  await expect(panel.getByText('what is this chat about?', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Stop' }).first()).toBeVisible();
  await expect(panel.getByText('You said: what is this chat about?')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Counting slowly: 1, 2, 3, .*, 60\./)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('You said: what is this chat about?')).toHaveCount(1);
  await expect(page.getByText('what is this chat about?', { exact: true })).toHaveCount(2);

  // A follow-up in the side chat's own box.
  await panel.getByRole('textbox', { name: 'Message' }).fill('and one more thing');
  await panel.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(panel.getByText('You said: and one more thing')).toBeVisible({ timeout: 20_000 });

  // + adds another, and the tabs come back after a reload.
  await panel.getByRole('button', { name: 'New side chat' }).click();
  await expect(panel.getByRole('group', { name: 'Side chats' }).getByRole('button', { name: 'Side chat', exact: true })).toBeVisible();
  await page.reload();
  const tabs = page.getByRole('region', { name: 'Side chat' }).getByRole('group', { name: 'Side chats' });
  await expect(tabs.getByRole('button', { name: 'what is this chat about?', exact: true })).toBeVisible();
  await expect(tabs.getByRole('button', { name: 'Side chat', exact: true })).toBeVisible();

  // × closes a side chat; the last one closes the panel.
  await tabs.getByRole('button', { name: 'Close Side chat' }).click();
  await tabs.getByRole('button', { name: 'Close what is this chat about?' }).click();
  await expect(page.getByRole('region', { name: 'Side chat' })).toHaveCount(0);
  await expect(page.getByText('what is this chat about?')).toHaveCount(0);
});
