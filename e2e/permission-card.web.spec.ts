import { expect, test } from '@playwright/test';
import { call } from './fixtures.ts';
import { startMcpMock } from './server-mode.ts';
import type { ChildProcess } from 'node:child_process';

// The browser against a real server: a connector's tool asks on a card, with nothing of the desktop in between.
const TOKEN = 'test-token-123';
let mock: ChildProcess;
let url: string;

test.beforeAll(async () => {
  ({ url, process: mock } = await startMcpMock({ MOCK_TOKEN: TOKEN }));
});

test.afterAll(() => {
  mock.kill();
});

test('in a browser, a Deny with a reason goes through the server to the model', async ({ page }) => {
  await page.goto('/#/?settings=connectors');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add connector' }).click();
  await page.getByRole('dialog', { name: 'Add connector' }).getByRole('button', { name: /^Custom/ }).click();
  const form = page.getByRole('dialog', { name: 'Add a custom connector' });
  await form.getByLabel('Name').fill('cardmock');
  await form.getByLabel('URL').fill(url);
  await form.getByRole('button', { name: 'Add header' }).click();
  await form.getByLabel('Header 1 name').fill('Authorization');
  await form.getByLabel('Header 1 value').fill(`Bearer ${TOKEN}`);
  await form.getByRole('button', { name: 'Add connector' }).click();
  await expect(dialog.getByText('Ready', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).first().click();

  await page.goto('/#/');
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(call('mcp__cardmock__echo', { text: 'hello' }));
  await box.press('Enter');
  const card = page.getByRole('region', { name: 'Allow Atelier to use mcp__cardmock__echo?' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Deny with reason…' }).click();
  const reason = card.getByRole('textbox', { name: 'Why not' });
  await reason.fill('not with this connector');
  await reason.press('Enter');
  await expect(card).toBeHidden();
  await expect(page.getByText(/Tool result: Error: The person declined and said: not with this connector/)).toBeVisible();
});
