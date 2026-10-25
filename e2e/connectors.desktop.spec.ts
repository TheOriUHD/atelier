import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, sendWhenIdle, tempConfigDir } from './fixtures.ts';
import { startMcpMock } from './server-mode.ts';

/** The MCP mock server the core tests use, over stdio. */
const MOCK_SERVER = fileURLToPath(new URL('../packages/core/src/mcp/__fixtures__/stdio-server.ts', import.meta.url));

test('desktop Chat: a connector tool asks first, then its server asks for a form and for a link', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir({ mcpServers: { mock: { type: 'stdio', command: process.execPath, args: [MOCK_SERVER] } } });
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });

    await box.fill(call('mcp__mock__ask', {}));
    await box.press('Enter');
    await page.getByRole('region', { name: 'Allow Atelier to use mcp__mock__ask?' }).getByRole('button', { name: 'Allow once' }).click();
    const form = page.getByRole('region', { name: 'mock asks for information' });
    await expect(form).toContainText('What is your name?');
    await form.getByRole('textbox', { name: 'name' }).fill('Ada');
    await form.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Tool result: Hello Ada')).toBeVisible();

    await box.fill(call('mcp__mock__sign_in', {}));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: 'Allow Atelier to use mcp__mock__sign_in?' }).getByRole('button', { name: 'Allow once' }).click();
    const link = page.getByRole('region', { name: 'mock asks you to open a link' });
    await expect(link).toContainText('https://mock.example/login');
    await link.getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByText('Tool result: Sign-in accept')).toBeVisible();

    // Switched off for this chat, the connector offers the model nothing: the call isn't made.
    await page.getByRole('button', { name: 'Add files and more' }).click();
    await page.getByRole('menuitem', { name: /Connectors/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'mock' }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await box.fill(call('mcp__mock__echo', { text: 'off' }));
    await sendWhenIdle(page);
    await expect(page.getByText(/^You said: call mcp__mock__echo/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Allow mcp__mock__echo?' })).toBeHidden();
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('desktop Chat: the assistant adds an MCP server the person gave it to Settings › Connectors and uses it', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  // An MCP server on this computer that asks for no credentials, like Fusion 360's.
  const mock = await startMcpMock({ MOCK_OPEN: '1' });
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(call('AddConnector', { name: 'fusion', url: mock.url }));
    await box.press('Enter');
    const card = page.getByRole('region', { name: 'Add fusion to your connectors?' });
    await expect(card).toContainText('It joins Settings › Connectors on this computer');
    await card.getByRole('button', { name: 'Add connector' }).click();
    await expect(page.getByText('Tool result: Added fusion to Settings › Connectors.')).toBeVisible({ timeout: 30_000 });

    await box.fill(call('mcp__fusion__echo', { text: 'from this computer' }));
    await sendWhenIdle(page);
    await page.getByRole('region', { name: 'Allow Atelier to use mcp__fusion__echo?' }).getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText('Tool result: from this computer')).toBeVisible();
  } finally {
    await app.close();
    mock.process.kill();
    await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
