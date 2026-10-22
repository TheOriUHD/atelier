import { expect, test } from '@playwright/test';

test('selecting text offers Reply, which quotes it in the next message', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Name a fruit');
  await box.press('Enter');
  const answer = page.getByText('You said: Name a fruit', { exact: true });
  await expect(answer).toBeVisible();

  // A triple click selects the paragraph, and the pill appears over it.
  await answer.click({ clickCount: 3 });
  const pill = page.getByRole('button', { name: 'Reply to the selected text' });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(pill).toHaveCount(0);

  // The passage waits in the message box as a card, and the box has focus.
  const composerQuote = page.getByRole('group', { name: 'Quoted text' });
  await expect(composerQuote).toHaveText('You said: Name a fruit');
  await expect(box).toBeFocused();
  await box.fill('Why that one?');
  await box.press('Enter');

  // Sent: the card leaves the box and sits above the person's message, which is answered as usual (what the model is
  // told is the backend's, covered by its tests).
  await expect(page.getByText('Why that one?', { exact: true })).toBeVisible();
  await expect(page.getByText('You said: Why that one?', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Quoted text' })).toHaveCount(1);
  await expect(page.getByRole('group', { name: 'Quoted text' })).toHaveText('You said: Name a fruit');
});

test('a quoted passage can be removed before sending', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Name a colour');
  await box.press('Enter');
  const answer = page.getByText('You said: Name a colour', { exact: true });
  await expect(answer).toBeVisible();
  await answer.click({ clickCount: 3 });
  await page.getByRole('button', { name: 'Reply to the selected text' }).click();
  await expect(page.getByRole('group', { name: 'Quoted text' })).toHaveCount(1);
  await page.getByRole('group', { name: 'Quoted text' }).hover();
  await page.getByRole('button', { name: 'Remove quoted text' }).click();
  await expect(page.getByRole('group', { name: 'Quoted text' })).toHaveCount(0);
});

test('the Reply pill keeps its solid background when hovered, so the text under it never shows through', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Name a tree');
  await box.press('Enter');
  const answer = page.getByText('You said: Name a tree', { exact: true });
  await expect(answer).toBeVisible();
  await answer.click({ clickCount: 3 });
  const pill = page.getByRole('button', { name: 'Reply to the selected text' });
  await expect(pill).toBeVisible();
  await pill.hover();
  // A tint laid over a see-through fill would leave an alpha below 1.
  const alpha = await pill.evaluate((el) => {
    const match = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor);
    const parts = match?.[1]?.split(/[ ,/]+/) ?? [];
    return parts.length > 3 ? Number(parts[3]) : 1;
  });
  expect(alpha).toBe(1);
});

test('a finished message says how long ago it was sent, and the exact date and time after a click', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Name a river');
  await box.press('Enter');
  await expect(page.getByText('You said: Name a river', { exact: true })).toBeVisible();
  // One on the person's message, one on the reply.
  const ages = page.getByRole('button', { name: 'just now' });
  await expect(ages).toHaveCount(2);
  await ages.last().click();
  await expect(page.getByRole('button', { name: /20\d\d/ })).toHaveCount(1);
  await page.getByRole('button', { name: /20\d\d/ }).click();
  await expect(page.getByRole('button', { name: 'just now' })).toHaveCount(2);
});
