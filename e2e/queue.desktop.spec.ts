import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, tempConfigDir, tempRepo } from './fixtures.ts';

test('desktop Code: a message sent while the agent works waits, can be taken back, or sent now to interrupt it', async () => {
  test.setTimeout(120_000);
  // Bypass: nothing here is about approvals.
  const configDir = await tempConfigDir({ permissions: { defaultMode: 'bypassPermissions' } });
  const repo = await tempRepo();
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, repo);
    const page = await app.firstWindow();
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    await page.getByRole('button', { name: 'No folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open folder…' }).click();
    // A folder is asked about once: trust it to work in it.
    await page.getByRole('button', { name: 'Trust workspace' }).click();
    await expect(page.getByRole('button', { name: basename(repo) })).toBeVisible();

    // A long command keeps the agent busy; Stop shows while the box is empty.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill(call('Bash', { command: 'sleep 20; echo finished', description: 'Wait a while' }));
    await box.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    // Once the command runs: a message sent before the agent's first request would simply join that request.
    await expect(page.getByRole('status').getByText('Wait a while')).toBeVisible();

    // Typing turns Stop into Send; Enter queues the message under the conversation.
    await box.fill('also say hello');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await box.press('Enter');
    const waiting = page.getByTestId('waiting-message');
    await expect(waiting).toContainText('also say hello');
    await expect(waiting).toContainText('Waiting for the next step');
    await expect(box).toHaveValue('');

    // Taking it back returns the text to the box.
    await waiting.getByRole('button', { name: 'Take back and edit' }).click();
    await expect(waiting).toHaveCount(0);
    await expect(box).toHaveValue('also say hello');

    // Queue it again and send it now: the command is cut off and the agent answers the message.
    await box.press('Enter');
    await waiting.getByRole('button', { name: 'Send now' }).click();
    await expect(waiting).toHaveCount(0);
    await expect(page.getByText('also say hello', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
  } finally {
    await app.close();
  }
});
