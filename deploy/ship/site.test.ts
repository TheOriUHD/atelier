import { describe, expect, it } from 'vitest';
import { KINDS, onFeed } from '../../apps/site/scripts/kinds.mjs';

const kindOf = (name: string) => Object.entries(KINDS as Record<string, RegExp>).find(([, re]) => re.test(name))?.[0] ?? null;

describe('the website download list', () => {
  it('tells every build of a release apart, a Windows installer per architecture included', () => {
    const names: Record<string, string> = {
      'Atelier-0.3.2-arm64.dmg': 'macos-arm64',
      'Atelier-0.3.2.dmg': 'macos-x64',
      'Atelier-Setup-0.3.2-x64.exe': 'windows-x64',
      'Atelier-Setup-0.3.2-arm64.exe': 'windows-arm64',
      'Atelier-0.3.2-amd64.deb': 'linux-deb-x64',
      'Atelier-0.3.2-arm64.deb': 'linux-deb-arm64',
      'Atelier-0.3.2.AppImage': 'linux-appimage-x64',
      'Atelier-0.3.2-arm64.AppImage': 'linux-appimage-arm64',
      'Atelier-Setup-0.3.2-beta.1-x64.exe': 'windows-x64',
    };
    for (const [name, kind] of Object.entries(names)) expect(kindOf(name), name).toBe(kind);
  });

  it('knows no kind for what is not a download, nor for the old one-installer name (a release has the new ones)', () => {
    for (const name of ['latest.yml', 'Atelier-0.3.2-mac.zip', 'Atelier-Setup-0.3.2.exe', 'Atelier-Setup-0.3.2-x64.exe.blockmap', 'Atelier-Setup-0.3.2-x64.exe.sig']) expect(kindOf(name), name).toBeNull();
  });

  it('expects everything on the update feed except the macOS disk images', () => {
    expect(Object.keys(KINDS).filter((k) => !onFeed(k))).toEqual(['macos-arm64', 'macos-x64']);
  });
});
