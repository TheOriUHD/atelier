import { describe, expect, it } from 'vitest';
import { appCategory, defaultTier, maxTier, seededDenied } from './computer-apps.ts';

describe('app categories', () => {
  it('knows apps by bundle id on macOS and by exe name or package family on Windows', () => {
    expect(appCategory('com.google.Chrome')).toBe('browser');
    expect(appCategory('com.jetbrains.intellij')).toBe('ide');
    expect(appCategory('chrome.exe')).toBe('browser');
    expect(appCategory('Chrome.EXE')).toBe('browser');
    expect(appCategory('MSTeams_8wekyb3d8bbwe')).toBe('messaging');
    expect(appCategory('windowsterminal.exe')).toBe('terminal');
    expect(appCategory('code.exe')).toBe('ide');
    expect(appCategory('olk.exe')).toBe('mail');
    expect(appCategory('1password.exe')).toBe('password-manager');
    expect(appCategory('notepad.exe')).toBe('other');
  });

  it('never lets Atelier, sign-in and security prompts or Settings be used, on either system', () => {
    for (const id of ['dev.atelier.app', 'com.github.Electron', 'atelier.exe', 'electron.exe', 'consent.exe', 'credentialuibroker.exe', 'logonui.exe', 'windows.immersivecontrolpanel_cw5n1h2txyewy']) {
      expect(appCategory(id), id).toBe('system');
      expect(defaultTier(appCategory(id)), id).toBeNull();
      expect(maxTier(appCategory(id)), id).toBeNull();
    }
  });

  it('seeds the denied list with the password managers of the system', () => {
    expect(seededDenied('darwin').map((a) => a.id)).toContain('com.1password.1password');
    expect(seededDenied('win32').map((a) => a.id)).toEqual(expect.arrayContaining(['1password.exe', 'bitwarden.exe', 'keepassxc.exe']));
    expect(seededDenied('win32').every((a) => appCategory(a.id) === 'password-manager')).toBe(true);
  });
});
