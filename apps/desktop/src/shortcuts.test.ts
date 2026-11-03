import { describe, expect, it, vi } from 'vitest';
import { repairShortcuts, shortcutPaths, type ShortcutDeps, type ShortcutLink } from './shortcuts.ts';

const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\Atelier\\Atelier.exe';
const ICON = 'C:\\Users\\me\\AppData\\Roaming\\Atelier\\app-icon.ico';

function deps(links: Record<string, ShortcutLink>, refused: string[] = []) {
  const updated: Record<string, ShortcutLink> = {};
  const refreshIcons = vi.fn();
  const d: ShortcutDeps = {
    exists: (path) => path in links || path === EXE,
    read: (path) => links[path] ?? null,
    update: (path, link) => {
      if (refused.includes(path)) return false;
      updated[path] = link;
      return true;
    },
    refreshIcons,
  };
  return { d, updated, refreshIcons };
}

describe('repairShortcuts', () => {
  it('gives a shortcut with no icon its icon back, and tells Windows to read icons again', () => {
    const { d, updated, refreshIcons } = deps({ desk: { target: EXE } });
    expect(repairShortcuts(['desk'], EXE, ICON, d, false)).toEqual(['desk']);
    expect(updated.desk).toEqual({ target: EXE, icon: ICON, iconIndex: 0 });
    expect(refreshIcons).toHaveBeenCalledOnce();
  });

  it('points a shortcut at this Atelier when it points at one that has moved', () => {
    const { d, updated } = deps({ start: { target: 'D:\\Old\\Atelier\\Atelier.exe', icon: 'D:\\Old\\Atelier\\Atelier.exe', iconIndex: 0 } });
    repairShortcuts(['start'], EXE, ICON, d, false);
    expect(updated.start?.target).toBe(EXE);
  });

  it('leaves a shortcut that is right as it is, unless Atelier was just updated', () => {
    const right = { target: EXE, icon: ICON.toUpperCase(), iconIndex: 0 };
    const quiet = deps({ desk: right });
    expect(repairShortcuts(['desk'], EXE, ICON, quiet.d, false)).toEqual([]);
    expect(quiet.refreshIcons).not.toHaveBeenCalled();
    const updated = deps({ desk: right });
    expect(repairShortcuts(['desk'], EXE, ICON, updated.d, true)).toEqual(['desk']);
  });

  it('moves a shortcut that takes its icon from Atelier.exe onto the copy no update deletes', () => {
    // What the installer writes: right target, the .exe's own icon. An update deletes that .exe for a moment, and
    // Windows can keep the blank page it saw then.
    const { d, updated } = deps({ start: { target: EXE, icon: EXE, iconIndex: 0 } });
    expect(repairShortcuts(['start'], EXE, ICON, d, false)).toEqual(['start']);
    expect(updated.start).toEqual({ target: EXE, icon: ICON, iconIndex: 0 });
  });

  it('never touches a shortcut to something else that happens to be called Atelier', () => {
    const { d, updated } = deps({ desk: { target: 'C:\\Games\\Atelier Sim\\launcher.exe' } });
    expect(repairShortcuts(['desk'], EXE, ICON, d, true)).toEqual([]);
    expect(updated).toEqual({});
  });

  it('skips missing shortcuts and carries on past one Windows won’t let it change', () => {
    const { d } = deps({ all: { target: EXE }, mine: { target: EXE } }, ['all']);
    expect(repairShortcuts(['gone', 'all', 'mine'], EXE, ICON, d, false)).toEqual(['mine']);
  });
});

describe('shortcutPaths', () => {
  it('covers the desktop, the Start menu and the taskbar, for this person and for everyone', () => {
    const paths = shortcutPaths({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming', ProgramData: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public' }, 'C:\\Users\\me\\Desktop', () => []);
    expect(paths.some((p) => p.endsWith('Desktop/Atelier.lnk') || p.endsWith('Desktop\\Atelier.lnk'))).toBe(true);
    expect(paths.filter((p) => /Start Menu/.test(p))).toHaveLength(2);
    expect(paths.some((p) => /User Pinned/.test(p))).toBe(true);
    expect(paths).toHaveLength(5);
  });

  it('includes every shortcut pinned to the taskbar, whatever it was named when it was pinned', () => {
    const pinned = shortcutPaths({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me\\Desktop', (dir) => (/TaskBar$/.test(dir) ? ['Atelier.lnk', 'Atelier (2).lnk', 'File Explorer.lnk'] : []));
    const names = pinned.filter((p) => /User Pinned/.test(p)).map((p) => p.split(/[\\/]/).pop());
    expect(names).toEqual(['Atelier.lnk', 'Atelier (2).lnk', 'File Explorer.lnk']);
  });
});
