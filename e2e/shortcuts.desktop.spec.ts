import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

// Windows only: shortcuts are Windows', and only Windows' shell can read and write them.
test.skip(process.platform !== 'win32', 'Windows shortcuts');

test('desktop: a broken shortcut to Atelier is mended on the next start', async () => {
  const configDir = await tempConfigDir();
  const links = await mkdtemp(join(tmpdir(), 'atelier-links-'));
  const link = join(links, 'Atelier.lnk');
  const exe = join(links, 'Atelier.exe');
  try {
    // What an update left behind: a shortcut to an Atelier.exe that moved, with no icon of its own.
    const first = await launchDesktop(configDir);
    await first.firstWindow();
    await first.evaluate(({ shell }, path) => shell.writeShortcutLink(path, 'create', { target: 'C:\\Old\\Atelier\\Atelier.exe' }), link);
    await first.close();

    const second = await launchDesktop(configDir, { ATELIER_SHORTCUT_TEST_DIR: links, ATELIER_SHORTCUT_TEST_EXE: exe });
    await second.firstWindow();
    await expect.poll(() => second.evaluate(({ shell }, path) => shell.readShortcutLink(path), link), { timeout: 15_000 }).toMatchObject({ target: exe, icon: expect.stringMatching(/[\\/]app-icon\.ico$/i), iconIndex: 0 });
    await second.close();
  } finally {
    await rm(links, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
