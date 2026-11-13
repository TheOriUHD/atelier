import { expect, test, type ElectronApplication } from '@playwright/test';
import { startCoopRelay } from '../packages/core/src/coop/relay-node.ts';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

/** Co-op in Code: a guest's model chip, the typing line above the message box, and the guest's own message answered. */
test('two desktops in Code: the guest answers with the host’s models, sees who types above the box, and gets the whole reply', async () => {
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
    await ada.setViewportSize({ width: 1440, height: 900 });
    await ben.setViewportSize({ width: 1440, height: 900 });
    await setUpLocal(ada, 'Ada');
    await setUpLocal(ben, 'Ben');

    await ada.getByRole('radio', { name: 'Code' }).click();
    const box = ada.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill('the shader plan');
    await box.press('Enter');
    await expect(ada.getByText('You said: the shader plan', { exact: true })).toBeVisible({ timeout: 30_000 });
    await ada.getByRole('button', { name: 'Co-op', exact: true }).click();
    const popover = ada.getByRole('dialog', { name: 'Co-op' });
    await popover.getByRole('button', { name: 'Start co-op' }).click();
    await popover.getByRole('button', { name: 'Copy invite link' }).click();
    await expect(popover.getByRole('button', { name: 'Copied' })).toBeVisible();
    const link = await host.evaluate(({ clipboard }) => clipboard.readText());

    await ben.evaluate((fragment) => void (location.hash = `#/join/${fragment}`), link.slice(link.indexOf('#') + 1));
    await expect(ben.getByText(/Join Ada’s session/)).toBeVisible({ timeout: 30_000 });
    // Answer with my own models (picked once in).
    await ben.getByRole('radio', { name: 'My models' }).click();
    await ben.getByRole('button', { name: 'Join', exact: true }).click();
    const knock = ada.getByRole('region', { name: 'Ben wants to join' });
    await expect(knock).toBeVisible({ timeout: 30_000 });
    await knock.getByRole('button', { name: 'Let in' }).click();
    await ada.keyboard.press('Escape');
    await expect(ben.getByText('You said: the shader plan', { exact: true })).toBeVisible({ timeout: 30_000 });

    // The guest's model chip: the host's models by default, and a menu with something to pick.
    const chip = ben.getByRole('button', { name: /^Answer my messages with/ });
    await expect(chip).toBeVisible();
    // Joined with "My models" and none picked yet, the session's model answers until one is.
    await expect(chip).toHaveAttribute('aria-label', 'Answer my messages with: Ada’s models');
    await chip.click();
    await expect(ben.getByRole('menuitemradio', { name: /Ada’s models/ })).toBeVisible();
    // Pick one of my own.
    await ben.getByRole('menuitemradio', { name: /fake-chat:8b/ }).click();
    // The pick holds: the chip names it (it said "no model chosen": the host's name for it wasn't one of the guest's).
    await expect(chip).toHaveAttribute('aria-label', 'Answer my messages with: fake-chat:8b');

    // Ada types: Ben sees it just above his message box, lined up with it.
    await box.pressSequentially('thinking about');
    const typing = ben.getByText('Ada is typing…');
    await expect(typing).toBeVisible({ timeout: 15_000 });
    const t = (await typing.boundingBox())!;
    const benBox = ben.getByRole('textbox', { name: 'Message', exact: true });
    const composer = (await benBox.locator('xpath=ancestor::div[contains(@class,"rounded-composer")][1]').boundingBox())!;

    // Ben's message is answered in full.
    await benBox.fill('say hi');
    await benBox.press('Enter');
    await expect(ben.getByText('You said: say hi', { exact: true })).toBeVisible({ timeout: 30_000 });
    // A reply to the host, watched by the guest as it streams: all of it, from its first word.
    await box.fill('');
    for (let i = 0; i < 3; i++) {
      await box.fill(`calmer waves number ${i}`);
      await box.press('Enter');
      await expect(ada.getByText(`You said: calmer waves number ${i}`, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(ben.getByText(`You said: calmer waves number ${i}`, { exact: true })).toBeVisible({ timeout: 30_000 });
    }
    expect(Math.abs(t.x - composer.x)).toBeLessThan(24);
    expect(t.y + t.height).toBeLessThanOrEqual(composer.y + 2);
    expect(composer.y - (t.y + t.height)).toBeLessThan(24);
  } finally {
    await host?.close().catch(() => undefined);
    await guest?.close().catch(() => undefined);
    await relay.close();
  }
});
