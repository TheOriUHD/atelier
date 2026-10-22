import { describe, expect, it, vi } from 'vitest';
import { desktopEntry, loginItem, type LoginItemOptions } from './login-item.ts';

/** Files in memory, keyed by path. */
function memoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const fs: LoginItemOptions['fs'] = {
    access: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    mkdir: async (path) => void dirs.add(path),
    writeFile: async (path, data) => void files.set(path, data),
    rm: async (path) => void files.delete(path),
  };
  return { fs, files, dirs };
}

const AUTOSTART = '/home/ada/.config/autostart';
const ENTRY = `${AUTOSTART}/dev.atelier.app.desktop`;

function fakeApp() {
  let openAtLogin = false;
  return {
    getLoginItemSettings: () => ({ openAtLogin }) as Electron.LoginItemSettings,
    setLoginItemSettings: vi.fn((settings: Electron.Settings) => void (openAtLogin = !!settings.openAtLogin)),
  };
}

describe('launch at login', () => {
  // The XDG autostart folder is under $HOME, which Windows doesn't use; Linux's entry is checked on Linux.
  it.skipIf(process.platform === 'win32')('writes and removes an XDG autostart entry on Linux', async () => {
    const { fs, files, dirs } = memoryFs();
    const app = fakeApp();
    const item = loginItem({ platform: 'linux', app, autostartDir: AUTOSTART, executable: '/home/ada/Apps/Atelier.AppImage', fs });
    expect(await item.get()).toBe(false);

    expect(await item.set(true)).toBe(true);
    expect(dirs.has(AUTOSTART)).toBe(true);
    expect(files.get(ENTRY)).toBe('[Desktop Entry]\nType=Application\nName=Atelier\nExec="/home/ada/Apps/Atelier.AppImage"\n');

    expect(await item.set(false)).toBe(false);
    expect(files.has(ENTRY)).toBe(false);
    // Turning it off again is fine.
    expect(await item.set(false)).toBe(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('quotes the program the way desktop entries need', () => {
    expect(desktopEntry('/home/ada/My Apps/Atelier.AppImage')).toContain('Exec="/home/ada/My Apps/Atelier.AppImage"\n');
    // In the file a literal \ in a quoted argument takes four backslashes, and " or $ two before it.
    expect(desktopEntry('/opt/a"b$c\\d 100%')).toContain('Exec="/opt/a\\\\"b\\\\$c\\\\\\\\d 100%%"\n');
  });

  it('uses the login item on macOS and Windows', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const { fs, files } = memoryFs();
      const app = fakeApp();
      const item = loginItem({ platform, app, autostartDir: AUTOSTART, executable: '/x', fs });
      expect(await item.set(true)).toBe(true);
      expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
      expect(await item.get()).toBe(true);
      expect(await item.set(false)).toBe(false);
      expect(files.size).toBe(0);
    }
  });
});
