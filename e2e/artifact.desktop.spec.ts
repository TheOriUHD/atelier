import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { ALL_BLOCKED, probeArtifactSandbox, tempConfigDir } from './fixtures.ts';

test('desktop: artifacts cannot reach the app, its storage or the network', async () => {
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await setUpLocal(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await probeArtifactSandbox(page, 'atelier-artifact://ui/artifact-runtime/index.html')).toEqual(ALL_BLOCKED);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
