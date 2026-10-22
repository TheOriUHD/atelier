import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { expect, test } from '@playwright/test';

// The mock MCP server from core's tests, over Streamable HTTP; it only answers with this bearer token.
const TOKEN = 'test-token-123';
let mock: ChildProcess;
let url: string;

test.beforeAll(async () => {
  mock = spawn(process.execPath, ['packages/core/src/mcp/__fixtures__/http-server.ts'], { env: { ...process.env, MOCK_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'inherit'] });
  url = await new Promise<string>((resolve, reject) => {
    createInterface({ input: mock.stdout! }).once('line', resolve);
    mock.once('exit', (code) => reject(new Error(`The mock MCP server exited (${code}).`)));
  });
});

test.afterAll(() => {
  mock.kill();
});

test('an admin adds a custom connector, turns a tool off, and removes it and its secret', async ({ page }) => {
  await page.goto('/#/?settings=connectors');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const nav = dialog.getByRole('navigation', { name: 'Settings pages' });
  await dialog.getByRole('button', { name: 'Add connector' }).click();
  await page.getByRole('dialog', { name: 'Add connector' }).getByRole('button', { name: /^Custom/ }).click();
  const form = page.getByRole('dialog', { name: 'Add a custom connector' });
  await form.getByLabel('Name').fill('e2e-mock');
  await form.getByLabel('URL').fill(url);
  await form.getByRole('button', { name: 'Add header' }).click();
  await form.getByLabel('Header 1 name').fill('Authorization');
  await form.getByLabel('Header 1 value').fill(`Bearer ${TOKEN}`);
  await expect(form.getByRole('button', { name: 'Keep header 1 as a secret' })).toHaveAttribute('aria-pressed', 'true');
  await form.getByRole('button', { name: 'Add connector' }).click();

  // It opens on the new connector, which connects with the stored token and lists the mock's tools.
  await expect(dialog.getByRole('heading', { name: 'e2e-mock' })).toBeVisible();
  await expect(dialog.getByText('Ready', { exact: true })).toBeVisible();
  const tools = dialog.getByRole('list', { name: 'Tools of e2e-mock' }).getByRole('listitem');
  await expect(tools.filter({ hasText: 'Echoes its input.' })).toContainText('Read-only');
  const picture = tools.filter({ hasText: 'Returns a picture.' }).getByRole('switch', { name: 'Use picture' });
  await expect(picture).toBeChecked();
  await picture.click();
  await expect(picture).not.toBeChecked();

  // The server reconnects without it, and the list counts it out.
  await page.reload();
  const row = dialog.getByRole('table', { name: 'Connectors' }).getByRole('row').filter({ hasText: 'e2e-mock' });
  await expect(row).toContainText('Ready');
  await expect(row).toContainText('11 of 12');

  // The token went to the secret store, which knows the connector uses it.
  await nav.getByRole('button', { name: 'Keys & secrets' }).click();
  const secret = dialog.getByRole('table', { name: 'Keys and secrets' }).getByRole('row').filter({ hasText: 'Authorization for e2e-mock' });
  await expect(secret).toContainText('Connector e2e-mock');
  await expect(secret).not.toContainText(TOKEN);
  await expect(secret.getByRole('button', { name: 'Delete Authorization for e2e-mock' })).toHaveAttribute('aria-disabled', 'true');

  await nav.getByRole('button', { name: 'Connectors' }).click();
  await row.getByRole('button', { name: 'e2e-mock' }).click();
  await dialog.getByRole('button', { name: 'e2e-mock options' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('alertdialog', { name: 'Remove e2e-mock?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByText('No connectors yet. Add one to give sessions tools from other services.')).toBeVisible();

  // Now nothing uses the secret, so it can go too.
  await nav.getByRole('button', { name: 'Keys & secrets' }).click();
  await expect(secret).toContainText('Not used');
  await secret.getByRole('button', { name: 'Delete Authorization for e2e-mock' }).click();
  await page.getByRole('alertdialog', { name: 'Delete Authorization for e2e-mock?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(secret).toHaveCount(0);
});
