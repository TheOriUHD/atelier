import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('the screen shown when a page breaks has Copy diagnostics, which names the error', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // A server that answers with settings the app doesn't expect (as 0.3.0's did for an app that hadn't updated): the
  // page throws while it draws, and the router shows the error screen.
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      try {
        const frame = JSON.parse(String(message)) as { result?: { effective?: Record<string, unknown> } };
        if (frame.result?.effective) {
          delete frame.result.effective.providers;
          delete frame.result.effective.prompts;
          return ws.send(JSON.stringify(frame));
        }
      } catch {
        // Not JSON: passed on as it is.
      }
      ws.send(message);
    });
  });
  await page.goto('/#/');
  const alert = page.getByRole('alert').filter({ hasText: 'ran into a problem' });
  await expect(alert).toBeVisible();
  if (process.env.ATELIER_SHOTS_DIR) {
    await mkdir(process.env.ATELIER_SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.ATELIER_SHOTS_DIR, 'error-screen.png') });
  }
  await alert.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(alert.getByRole('button', { name: 'Copied' })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('Mode: web browser');
  expect(text).toMatch(/Last error \(\d+ s ago\):\n {2}\S/);
  expect(text).toContain('a browser keeps none');
  // Only the scheme of this server shows, never its address.
  expect(text).not.toContain('127.0.0.1');
  expect(text).not.toContain('7381');
});
