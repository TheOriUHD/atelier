/**
 * Atelier's Windows shortcuts (desktop, Start menu, taskbar) can come out of an update with a blank icon, or pointing at
 * an Atelier.exe that's gone, and Windows keeps showing the broken one. On each start Atelier checks its own shortcuts
 * and repairs them; after an update it rewrites them anyway, which makes Windows read the icon again.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ShortcutLink {
  target: string;
  icon?: string;
  iconIndex?: number;
}

export interface ShortcutDeps {
  exists(path: string): boolean;
  /** The link, or null when it can't be read. */
  read(path: string): ShortcutLink | null;
  /** Changes only the given fields; false when Windows refused (a shortcut for all users needs an administrator). */
  update(path: string, link: Required<ShortcutLink>): boolean;
  /** Tells Windows to read icons again. */
  refreshIcons(): void;
}

const same = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
/** Only links to an Atelier.exe are touched: a shortcut someone named "Atelier" for something else stays as it is. */
const isOurs = (link: ShortcutLink) => /(?:^|[\\/])Atelier\.exe$/i.test(link.target);

/** Where the installer and the taskbar keep shortcuts to Atelier, for this person and for everyone on the computer. */
export function shortcutPaths(env: NodeJS.ProcessEnv, desktop: string): string[] {
  const appData = env.APPDATA ?? '';
  const programData = env.ProgramData ?? env.PROGRAMDATA ?? '';
  const publicDir = env.PUBLIC ?? '';
  return [
    join(desktop, 'Atelier.lnk'),
    ...(appData ? [join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Atelier.lnk'), join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Atelier.lnk')] : []),
    ...(programData ? [join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Atelier.lnk')] : []),
    ...(publicDir ? [join(publicDir, 'Desktop', 'Atelier.lnk')] : []),
  ];
}

/** Repairs the shortcuts that need it, or all of Atelier's after an update (`refresh`); returns the ones it rewrote. */
export function repairShortcuts(paths: readonly string[], exe: string, deps: ShortcutDeps, refresh: boolean): string[] {
  const repaired: string[] = [];
  for (const path of paths) {
    if (!deps.exists(path)) continue;
    const link = deps.read(path);
    if (!link || !isOurs(link)) continue;
    const broken = !same(link.target, exe) || !link.icon || !same(link.icon, exe) || (link.iconIndex ?? 0) !== 0;
    if (!broken && !refresh) continue;
    if (deps.update(path, { target: exe, icon: exe, iconIndex: 0 })) repaired.push(path);
  }
  if (repaired.length) deps.refreshIcons();
  return repaired;
}

export const fileExists = (path: string): boolean => existsSync(path);
