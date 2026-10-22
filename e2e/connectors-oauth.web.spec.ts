import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { expect, test, type Page } from '@playwright/test';

// The mock MCP server from core's tests behind its own OAuth authorization server, which approves every sign-in at once.
let mock: ChildProcess;
let url: string;

test.beforeAll(async () => {
  mock = spawn(process.execPath, ['packages/core/src/mcp/__fixtures__/http-server.ts'], { env: { ...process.env, MOCK_OAUTH: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  url = await new Promise<string>((resolve, reject) => {
    createInterface({ input: mock.stdout! }).once('line', resolve);
    mock.once('exit', (code) => reject(new Error(`The mock MCP server exited (${code}).`)));
  });
});

test.afterAll(() => {
  mock.kill();
});

/** Adds the mock as a custom connector that signs in with OAuth; adding it opens the sign-in page in a new tab. */
async function addConnector(page: Page): Promise<Page> {
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Add connector' }).click();
  await page.getByRole('dialog', { name: 'Add connector' }).getByRole('button', { name: /^Custom/ }).click();
  const form = page.getByRole('dialog', { name: 'Add a custom connector' });
  await form.getByLabel('Name').fill('e2e-oauth');
  await form.getByLabel('URL').fill(url);
  await form.getByRole('switch', { name: 'Sign in with OAuth' }).click();
  const tab = page.context().waitForEvent('page');
  await form.getByRole('button', { name: 'Add connector' }).click();
  return tab;
}

async function remove(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'e2e-oauth options' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('alertdialog', { name: 'Remove e2e-oauth?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByRole('button', { name: 'e2e-oauth' })).toHaveCount(0);
}

test('an admin signs a connector in with OAuth, and removing it forgets the sign-in', async ({ page }) => {
  await page.goto('/#/?settings=connectors');
  const dialog = page.getByRole('dialog', { name: 'Settings' });

  // The authorization server approves at once and sends the tab back to Atelier, which says it can be closed.
  const tab = await addConnector(page);
  await expect(tab.getByRole('heading', { name: 'Signed in' })).toBeVisible();
  await expect(tab.getByText('You can close this tab and go back to Atelier.')).toBeVisible();
  expect(new URL(tab.url()).pathname).toBe('/oauth/callback');
  await tab.close();

  // The connector connects with what the sign-in gave it and lists the mock's tools.
  await expect(dialog.getByRole('heading', { name: 'e2e-oauth' })).toBeVisible();
  await expect(dialog.getByText('Ready', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Tools of e2e-oauth' }).getByRole('listitem').filter({ hasText: 'Echoes its input.' })).toContainText('Read-only');
  await remove(page);

  // Added again under the same name, it has no sign-in left to use, so it waits for a new one (which never comes back).
  await page.context().route(`${new URL(url).origin}/authorize**`, (route) => route.abort());
  const again = await addConnector(page);
  await expect(dialog.getByText('Waiting for you to sign in in the other tab…')).toBeVisible();
  await expect(dialog.getByText('Waiting for sign-in', { exact: true })).toBeVisible();
  await again.close();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(dialog.getByText('Not signed in', { exact: true })).toBeVisible();
  await remove(page);
});
