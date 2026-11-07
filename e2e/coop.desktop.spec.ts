import { expect, test, type ElectronApplication } from '@playwright/test';
import { startCoopRelay } from '../packages/core/src/coop/relay-node.ts';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

/**
 * Co-op between two desktops on this machine: a relay on Node, two apps with their own data, an invite, the fingerprint,
 * and a guest's message answered in the host's session.
 */
test('two desktops: invite, compare emoji, let in, write together, and the guest sees the host go away', async () => {
  test.setTimeout(240_000);
  const relay = await startCoopRelay({ port: 0 });
  const env = { ATELIER_COOP_RELAY: relay.url };
  let host: ElectronApplication | null = null;
  let guest: ElectronApplication | null = null;
  try {
    host = await launchDesktop(await tempConfigDir({ profile: { name: 'Ada' } }), env);
    guest = await launchDesktop(await tempConfigDir({ profile: { name: 'Ben' } }), env);
    const ada = await host.firstWindow();
    const ben = await guest.firstWindow();
    await setUpLocal(ada, 'Ada');
    await setUpLocal(ben, 'Ben');

    // Ada's chat, and an invite link from its Co-op popover.
    const box = ada.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill('the shader plan');
    await box.press('Enter');
    await expect(ada.getByText('You said: the shader plan', { exact: true })).toBeVisible();
    await ada.getByRole('button', { name: 'Co-op', exact: true }).click();
    const popover = ada.getByRole('dialog', { name: 'Co-op' });
    await popover.getByRole('button', { name: 'Start co-op' }).click();
    await popover.getByRole('button', { name: 'Copy invite link' }).click();
    await expect(popover.getByRole('button', { name: 'Copied' })).toBeVisible();
    const link = await host.evaluate(({ clipboard }) => clipboard.readText());
    expect(link).toMatch(/^https:\/\/atelierhq\.dev\/join#v1\./);

    // Ben opens it: the join card says whose session it is and where it runs.
    await ben.evaluate((fragment) => void (location.hash = `#/join/${fragment}`), link.slice(link.indexOf('#') + 1));
    await expect(ben.getByText(/Join Ada’s session/)).toBeVisible();
    await expect(ben.getByText('It runs on Ada’s computer.')).toBeVisible();
    await ben.getByRole('button', { name: 'Join', exact: true }).click();

    // Ada sees Ben knock with three emoji, and Ben sees the same three.
    const knock = ada.getByRole('region', { name: 'Ben wants to join' });
    await expect(knock).toBeVisible({ timeout: 30_000 });
    const emoji = (await knock.getByLabel(/^Fingerprint:/).getAttribute('aria-label'))!.replace('Fingerprint: ', '');
    await expect(ben.getByText(emoji.replaceAll(' ', ''), { exact: false }).or(ben.getByLabel(`Fingerprint: ${emoji}`))).toBeVisible();
    await knock.getByRole('button', { name: 'Let in' }).click();

    // Ben is in: the conversation so far, and his message answered in Ada's session as his.
    await expect(ben.getByText('You said: the shader plan', { exact: true })).toBeVisible({ timeout: 30_000 });
    const benBox = ben.getByRole('textbox', { name: 'Message', exact: true });
    await benBox.fill('calmer waves');
    await benBox.press('Enter');
    await expect(ada.getByText('You said: calmer waves', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(ben.getByText('You said: calmer waves', { exact: true })).toBeVisible();

    // Ada quits: Ben is told her computer is away.
    await host.close();
    host = null;
    await expect(ben.getByText(/Ada’s computer is (asleep|away|offline)/)).toBeVisible({ timeout: 60_000 });
  } finally {
    await host?.close().catch(() => undefined);
    await guest?.close().catch(() => undefined);
    await relay.close();
  }
});
