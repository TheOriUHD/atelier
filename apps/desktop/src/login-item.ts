/**
 * Launch at login (Settings › System). macOS and Windows keep it as the app's login item; Linux desktops start
 * what has an entry in the XDG autostart folder (~/.config/autostart).
 */
import { join } from 'node:path';
import { APP } from '@atelier/protocol';

export interface LoginItemOptions {
  platform: NodeJS.Platform;
  app: Pick<Electron.App, 'getLoginItemSettings' | 'setLoginItemSettings'>;
  /** `$XDG_CONFIG_HOME/autostart`. */
  autostartDir: string;
  /** What the Linux entry starts. */
  executable: string;
  fs: {
    access(path: string): Promise<void>;
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    writeFile(path: string, data: string): Promise<void>;
    rm(path: string, options: { force: true }): Promise<void>;
  };
}

/** A Desktop Entry's Exec: the path quoted with `"` `` ` `` `$` `\` escaped, then backslashes escaped again as a string value, and `%` doubled. */
export function desktopEntry(executable: string): string {
  const exec = `"${executable.replace(/[\\"`$]/g, '\\$&')}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%');
  return `[Desktop Entry]\nType=Application\nName=${APP.name}\nExec=${exec}\n`;
}

export function loginItem({ platform, app, autostartDir, executable, fs }: LoginItemOptions) {
  const entry = join(autostartDir, `${APP.id}.desktop`);
  const get = async (): Promise<boolean> =>
    platform === 'linux'
      ? fs.access(entry).then(
          () => true,
          () => false,
        )
      : app.getLoginItemSettings().openAtLogin;
  return {
    get,
    /** Turns it on or off, then answers what the system says now. */
    async set(openAtLogin: boolean): Promise<boolean> {
      if (platform !== 'linux') app.setLoginItemSettings({ openAtLogin });
      else if (openAtLogin) {
        await fs.mkdir(autostartDir, { recursive: true });
        await fs.writeFile(entry, desktopEntry(executable));
      } else await fs.rm(entry, { force: true });
      return get();
    },
  };
}
