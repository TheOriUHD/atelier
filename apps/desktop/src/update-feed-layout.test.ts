import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The Windows installers are one per architecture (electron-builder.yml), both listed in one latest.yml. Every app that
 * is out (0.1.0 to 0.3.1 all ship electron-updater 6.8.10) must still pick the right one, so this runs electron-updater's
 * own file selection, the code of the installed apps, over the real shape of the file.
 */
const require = createRequire(import.meta.url);
const { findFile, parseUpdateInfo, resolveFiles } = require('electron-updater/out/providers/Provider.js') as {
  findFile(files: unknown[], extension: string, not?: string[]): { url: URL; info: { url: string } };
  parseUpdateInfo(raw: string, channelFile: string, channelUrl: URL): unknown;
  resolveFiles(info: unknown, base: URL): unknown[];
};

/** What electron-builder 26.15.3 wrote on the Windows build machine for the split installers (checksums are real). */
const SPLIT = `version: 0.3.1
files:
  - url: Atelier-Setup-0.3.1-x64.exe
    sha512: X+KMtWjMWFZVURDdJE9l1pLNWCGt/4BQwfRB9lA+BLnEVC37TqnhO5v0/1PebQWLlyzSHc2/L1xiK3dI+haFRg==
    size: 129552475
  - url: Atelier-Setup-0.3.1-arm64.exe
    sha512: /pJkdI0djldljlcaU8oEqo5AILw++vuMw4CwEbqSw4gnwpJ9yjEyDlajc/sh+1Xzw2WpRwHfL70J5HHI+XZCwA==
    size: 123501315
path: Atelier-Setup-0.3.1-x64.exe
sha512: X+KMtWjMWFZVURDdJE9l1pLNWCGt/4BQwfRB9lA+BLnEVC37TqnhO5v0/1PebQWLlyzSHc2/L1xiK3dI+haFRg==
releaseDate: '2026-11-03T07:35:31.398Z'
`;

/** The one installer that carried both architectures, as releases up to 0.3.1 have it. */
const COMBINED = `version: 0.3.1
files:
  - url: Atelier-Setup-0.3.1.exe
    sha512: DK9lvRK7w+cmJAGOwo/Rhp5Ci2/xs5d+qYxJXG3YrUaWjdL0dOSZceCYNHpUWAfyc+bc/xlyTq0mzbj+0KaCng==
    size: 252434124
path: Atelier-Setup-0.3.1.exe
sha512: DK9lvRK7w+cmJAGOwo/Rhp5Ci2/xs5d+qYxJXG3YrUaWjdL0dOSZceCYNHpUWAfyc+bc/xlyTq0mzbj+0KaCng==
releaseDate: '2026-11-02T15:46:37.375Z'
`;

const realArch = process.arch;
const as = (arch: string) => Object.defineProperty(process, 'arch', { value: arch, configurable: true });
afterEach(() => as(realArch));

/** The file name the updater of an app on `arch` downloads from a feed at `base`. */
function pick(yaml: string, arch: string, base = 'https://atelier.example.com/updates/stable/') {
  as(arch);
  const url = new URL(base);
  const info = parseUpdateInfo(yaml, 'latest.yml', new URL('latest.yml', url));
  return findFile(resolveFiles(info, url), 'exe', ['blockmap']).info.url;
}

describe('Windows update file with an installer per architecture', () => {
  it('gives an x64 app the x64 installer and an ARM64 app the ARM64 one, on the project feed and on a server', () => {
    for (const base of ['https://updates.atelierhq.dev/stable/', 'https://atelier.example.com/updates/stable/', 'https://atelier.example.com/updates/beta/']) {
      expect(pick(SPLIT, 'x64', base)).toBe('Atelier-Setup-0.3.1-x64.exe');
      expect(pick(SPLIT, 'arm64', base)).toBe('Atelier-Setup-0.3.1-arm64.exe');
    }
  });

  it('has one known limit: electron-updater matches the architecture in the whole path, so a feed served under a path that itself says arm64 or x64 would give every app the first installer', () => {
    expect(pick(SPLIT, 'arm64', 'https://example.com/arm64/updates/stable/')).toBe('Atelier-Setup-0.3.1-x64.exe');
  });

  it('still gives an architecture it has no installer for the first one, which is the x64 installer', () => {
    expect(pick(SPLIT, 'ia32')).toBe('Atelier-Setup-0.3.1-x64.exe');
  });

  it('lists the .sig the app asks for beside every installer, because it checks the signature of each file in the list', () => {
    as('x64');
    const info = parseUpdateInfo(SPLIT, 'latest.yml', new URL('https://f.example/stable/latest.yml')) as { files: { url: string }[] };
    expect(info.files.map((f) => `${f.url}.sig`)).toEqual(['Atelier-Setup-0.3.1-x64.exe.sig', 'Atelier-Setup-0.3.1-arm64.exe.sig']);
  });

  it('keeps working with the file of earlier releases, which has the one installer for both', () => {
    expect(pick(COMBINED, 'x64')).toBe('Atelier-Setup-0.3.1.exe');
    expect(pick(COMBINED, 'arm64')).toBe('Atelier-Setup-0.3.1.exe');
  });
});
