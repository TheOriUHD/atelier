/**
 * Atelier's icon on Windows (resources/icon.ico, made from resources/icon-full.png). Each window carries it, so the
 * taskbar and Alt+Tab show it even when Windows' cached copy of the .exe's icon went blank during an update, and the
 * shortcuts take theirs from a copy in the user data that no update deletes (shortcuts.ts).
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

/** The .ico the windows use: in the app's resources once installed, in the repository when run from source. */
export function windowIcon(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const path = app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(import.meta.dirname, '..', 'resources', 'icon.ico');
  return existsSync(path) ? path : undefined;
}

/** For a BrowserWindow's options: `{ icon }` on Windows, nothing elsewhere. */
export const windowIconOption = (): { icon?: string } => {
  const icon = windowIcon();
  return icon ? { icon } : {};
};

/** Copies the icon to `<userData>/app-icon.ico` when that's missing or different; its path, or null with no icon. */
export async function shortcutIcon(): Promise<string | null> {
  const source = windowIcon();
  if (!source) return null;
  const target = join(app.getPath('userData'), 'app-icon.ico');
  const bytes = await readFile(source);
  const current = await readFile(target).catch(() => null);
  if (!current?.equals(bytes)) await writeFile(target, bytes);
  return target;
}
