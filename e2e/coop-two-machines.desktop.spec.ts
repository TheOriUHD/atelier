import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

/**
 * Co-op between two real computers through a real relay (the one at coop.atelierhq.dev unless ATELIER_COOP_RELAY
 * says otherwise). It runs only when asked, as one of two roles, one on each computer:
 *
 *   COOP_ROLE=host  COOP_EXCHANGE=<folder>  npx playwright test --project=desktop e2e/coop-two-machines.desktop.spec.ts
 *   COOP_ROLE=guest COOP_EXCHANGE=<folder>  (the same, on the other computer)
 *
 * The two talk through files in their COOP_EXCHANGE folders, which whoever runs it copies across: the host writes
 * `link.txt` (copy it to the guest's folder before the guest starts) and `host-fingerprint.txt`; the guest writes
 * `guest-fingerprint.txt` (copy it to the host's folder: the host lets the guest in once it matches its own) and
 * `guest-done.txt` (copy it too: the host then quits, and the guest sees it go away).
 */
const role = process.env.COOP_ROLE;
const exchange = process.env.COOP_EXCHANGE ?? '';

test.skip(!role || !exchange, 'Runs on two computers, when COOP_ROLE and COOP_EXCHANGE are set.');

/** The app's own output (its backend's errors among it), kept next to the exchange files for whoever reads the run. */
function keepOutput(app: ElectronApplication, name: string): void {
  const file = join(exchange, `${name}-app.log`);
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (data: Buffer) => void appendFile(file, data).catch(() => undefined));
}

async function fileAppears(path: string, ms: number): Promise<string> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`${path} didn’t appear`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return (await readFile(path, 'utf8')).trim();
}

test('co-op between two computers through the relay', async () => {
  test.setTimeout(30 * 60_000);
  await mkdir(exchange, { recursive: true });
  const relay = process.env.ATELIER_COOP_RELAY ? { ATELIER_COOP_RELAY: process.env.ATELIER_COOP_RELAY } : {};
  let app: ElectronApplication | null = null;
  try {
    if (role === 'host') {
      app = await launchDesktop(await tempConfigDir({ profile: { name: 'Ada' } }), relay);
      keepOutput(app, 'host');
      const ada = await app.firstWindow();
      await setUpLocal(ada, 'Ada');
      const box = ada.getByRole('textbox', { name: 'Message', exact: true });
      await box.fill('the shader plan');
      await box.press('Enter');
      await expect(ada.getByText('You said: the shader plan', { exact: true })).toBeVisible({ timeout: 60_000 });
      await ada.getByRole('button', { name: 'Co-op', exact: true }).click();
      const popover = ada.getByRole('dialog', { name: 'Co-op' });
      await popover.getByRole('button', { name: 'Start co-op' }).click();
      await popover.getByRole('button', { name: 'Copy invite link' }).click();
      await expect(popover.getByRole('button', { name: 'Copied' })).toBeVisible();
      const link = await app.evaluate(({ clipboard }) => clipboard.readText());
      expect(link).toMatch(/^https:\/\/atelierhq\.dev\/join#v1\./);
      await writeFile(join(exchange, 'link.txt'), link);

      // Ben knocks from the other computer: the four emoji, then let in.
      const knock = ada.getByRole('region', { name: 'Ben wants to join' });
      await expect(knock).toBeVisible({ timeout: 20 * 60_000 });
      const emoji = (await knock.getByLabel(/^Fingerprint:/).getAttribute('aria-label'))!.replace('Fingerprint: ', '');
      expect(emoji.split(' ')).toHaveLength(4);
      await writeFile(join(exchange, 'host-fingerprint.txt'), emoji);
      // As two people would: compare them with what his screen shows, then let him in.
      expect(await fileAppears(join(exchange, 'guest-fingerprint.txt'), 20 * 60_000)).toBe(emoji);
      await knock.getByRole('button', { name: 'Let in' }).click();

      // His message, answered in this session; then, once he is done, this computer goes away.
      await expect(ada.getByText('You said: calmer waves', { exact: true })).toBeVisible({ timeout: 10 * 60_000 });
      await fileAppears(join(exchange, 'guest-done.txt'), 20 * 60_000);
      await app.close();
      app = null;
    } else {
      const link = await fileAppears(join(exchange, 'link.txt'), 60_000);
      app = await launchDesktop(await tempConfigDir({ profile: { name: 'Ben' } }), relay);
      keepOutput(app, 'guest');
      const ben = await app.firstWindow();
      await setUpLocal(ben, 'Ben');
      await ben.evaluate((fragment) => void (location.hash = `#/join/${fragment}`), link.slice(link.indexOf('#') + 1));
      await expect(ben.getByText(/Join Ada’s session/)).toBeVisible({ timeout: 2 * 60_000 });
      await ben.getByRole('button', { name: 'Join', exact: true }).click();
      const shown = ben.getByLabel(/^Fingerprint: /);
      await expect(shown).toBeVisible({ timeout: 2 * 60_000 });
      await writeFile(join(exchange, 'guest-fingerprint.txt'), (await shown.getAttribute('aria-label'))!.replace('Fingerprint: ', ''));

      // Let in: the conversation so far.
      await expect(ben.getByText('You said: the shader plan', { exact: true })).toBeVisible({ timeout: 20 * 60_000 });
      // Filed in his own sidebar: renamed and pinned, for him only. (A row's ⋯ shows while the pointer is over it.)
      const row = ben.getByRole('navigation', { name: 'Sidebar' }).locator('a:has([aria-label^="Options for "])').first();
      const options = async () => {
        await row.hover();
        await row.getByRole('button', { name: /^Options for / }).click();
      };
      await options();
      await ben.getByRole('menuitem', { name: 'Rename' }).click();
      const rename = ben.getByRole('dialog', { name: /^Rename/ });
      await expect(rename.getByText(/Only you see this name/)).toBeVisible();
      await rename.getByRole('textbox', { name: 'Title' }).fill('Our shader');
      await rename.getByRole('button', { name: 'Save' }).click();
      await expect(row).toContainText('Our shader', { timeout: 30_000 });
      await options();
      await ben.getByRole('menuitem', { name: 'Pin' }).click();
      await options();
      await expect(ben.getByRole('menuitem', { name: 'Unpin' })).toBeVisible();
      await ben.keyboard.press('Escape');

      // His message, answered by the host's model in the host's session.
      const box = ben.getByRole('textbox', { name: 'Message', exact: true });
      await box.fill('calmer waves');
      await box.press('Enter');
      await expect(ben.getByText('You said: calmer waves', { exact: true })).toBeVisible({ timeout: 5 * 60_000 });
      await writeFile(join(exchange, 'guest-done.txt'), 'done');

      // The host's computer quits: he is told it is away.
      await expect(ben.getByText(/Ada’s computer is (asleep|away|offline)/)).toBeVisible({ timeout: 20 * 60_000 });
    }
  } finally {
    await app?.close().catch(() => undefined);
  }
});
