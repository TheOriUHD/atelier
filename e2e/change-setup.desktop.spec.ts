import { rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { launchDesktop, PASSWORD } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';
import { SERVER_URL, startServer, stopServer } from './server-mode.ts';

test('desktop: Settings › Connection switches to a server and back, and this computer’s chats are still there', async () => {
  const configDir = await tempConfigDir();
  const dataDir = await tempConfigDir();
  let server: ChildProcess | undefined;
  let app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Run on this computer' }).click();
    await page.getByLabel('Your name').fill('Ada');
    await page.getByRole('button', { name: 'Continue' }).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('kept on this computer');
    await box.press('Enter');
    await expect(page.getByText('You said: kept on this computer')).toBeVisible();

    // The profile menu says where Atelier runs and leads to the page that switches it.
    await page.getByRole('button', { name: /Ada/ }).first().click();
    await page.getByRole('menuitem', { name: 'Running on this computer' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByRole('heading', { name: 'Where Atelier runs' })).toBeVisible();
    await expect(settings.getByRole('button', { name: /This computer.*In use/ })).toBeVisible();

    // An address where no server answers changes nothing.
    await settings.getByRole('button', { name: /An Atelier server/ }).click();
    await settings.getByRole('textbox', { name: 'Server address' }).fill('http://127.0.0.1:9');
    await settings.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(settings.getByText('No Atelier server answered at http://127.0.0.1:9.')).toBeVisible();
    await expect(settings.getByRole('button', { name: /This computer.*In use/ })).toBeVisible();

    // A server that answers: the app switches to it and asks for its sign-in.
    server = await startServer(dataDir);
    await settings.getByRole('textbox', { name: 'Server address' }).fill(SERVER_URL);
    await settings.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Signed in, the window is back on the page that switched it, which now says so.
    await expect(settings.getByRole('button', { name: /An Atelier server.*In use/ })).toBeVisible();
    await expect(settings.getByText(/Signed in to 127\.0\.0\.1:\d+\./)).toBeVisible();

    // And back to this computer, where the chat is as it was; the choice holds after a restart.
    await settings.getByRole('button', { name: /This computer/ }).click();
    await settings.getByRole('button', { name: 'Switch to this computer' }).click();
    await expect(settings.getByRole('button', { name: /This computer.*In use/ })).toBeVisible();
    await app.close();
    app = await launchDesktop(configDir);
    const next = await app.firstWindow();
    await expect(next.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expect(next.getByRole('heading', { name: 'Welcome to Atelier' })).toHaveCount(0);
    // The fake model titles every chat this way.
    await next.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'Scripted demo chat' }).first().click();
    await expect(next.getByText('You said: kept on this computer')).toBeVisible();
  } finally {
    await app.close();
    if (server) await stopServer(server);
    await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('desktop: the network search answers within a few seconds', async () => {
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    await app.firstWindow();
    // Nothing listens on 7340 in a test run, or a dev server does.
    const page = await app.firstWindow();
    const started = Date.now();
    const found = await page.evaluate(() => (window as unknown as { atelierDesktop: { discovery: { scan(f: () => void): Promise<unknown[]> } } }).atelierDesktop.discovery.scan(() => {}));
    expect(Array.isArray(found)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
