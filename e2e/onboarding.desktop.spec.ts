import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { FAKE_OLLAMA_PORT } from './fixtures.ts';

test('a fresh install goes from connection choice and owner setup through onboarding to a streamed reply', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'atelier-e2e-fresh-'));
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    const started = Date.now();
    // macOS draws the window buttons over the top-left corner: the brand starts to their right at any width.
    if (process.platform === 'darwin') {
      const brand = await page.getByRole('banner').getByText('Atelier').boundingBox();
      expect(brand!.x).toBeGreaterThanOrEqual(80);
    }
    await setUpLocal(page);
    await page.getByRole('button', { name: 'Add manually' }).click();
    await page.getByRole('button', { name: /^Ollama/ }).click();
    const url = page.getByRole('textbox', { name: 'Base URL' });
    await url.fill(`http://127.0.0.1:${FAKE_OLLAMA_PORT}`);
    await page.getByRole('button', { name: 'Add provider' }).click();

    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('first message');
    await box.press('Enter');
    await expect(page.getByText('You said: first message')).toBeVisible();
    expect(Date.now() - started).toBeLessThan(60_000);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
