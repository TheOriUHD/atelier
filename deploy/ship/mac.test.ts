import { describe, expect, it } from 'vitest';
import { ARCHS, macFeedNames, macPackages, macPlan, macProgress, parseMacArgs, renderMacFeed } from '../../apps/desktop/scripts/mac-lib.mjs';

describe('package:mac command line', () => {
  it('signs and sends both architectures by default', () => {
    expect(parseMacArgs([])).toEqual({ mode: 'submit', archs: null, signOnly: false, resume: false, force: false });
  });

  it('reads the modes, repeated and = style architectures, and the flags', () => {
    expect(parseMacArgs(['--finish', '--arch', 'arm64']).archs).toEqual(['arm64']);
    expect(parseMacArgs(['--status', '--arch=x64', '--arch', 'arm64', '--arch', 'x64']).archs).toEqual(['x64', 'arm64']);
    expect(parseMacArgs(['--submit', '--force'])).toMatchObject({ resume: true, force: true });
    expect(parseMacArgs(['--sign-only']).signOnly).toBe(true);
    expect(parseMacArgs(['--feed']).mode).toBe('feed');
  });

  it('refuses what it does not know, and flags that contradict each other', () => {
    expect(() => parseMacArgs(['--arch', 'ia32'])).toThrow(/arm64 or x64/);
    expect(() => parseMacArgs(['--arch'])).toThrow(/arm64 or x64/);
    expect(() => parseMacArgs(['--nope'])).toThrow(/Unknown flag/);
    expect(() => parseMacArgs(['--sign-only', '--submit'])).toThrow(/contradict/);
  });
});

describe('how far each Mac architecture has come', () => {
  const has = (...files: string[]) => (path: string) => files.map((f) => `/r/${f}`).includes(path);

  it('tells nothing, signed, with Apple and done apart, from the files on disk', () => {
    expect(macProgress('/r', '1.0.0', has())).toEqual({ arm64: 'none', x64: 'none' });
    // The marker alone is not enough: the app must be there too.
    expect(macProgress('/r', '1.0.0', has('signed-arm64'))).toEqual({ arm64: 'none', x64: 'none' });
    expect(macProgress('/r', '1.0.0', has('signed-arm64', 'mac-arm64/Atelier.app', 'signed-x64', 'mac/Atelier.app'))).toEqual({ arm64: 'signed', x64: 'signed' });
    expect(macProgress('/r', '1.0.0', has('signed-arm64', 'mac-arm64/Atelier.app', 'notarization-arm64.json'))).toMatchObject({ arm64: 'submitted' });
    expect(macProgress('/r', '1.0.0', has(...macPackages('1.0.0', 'x64'), 'notarization-x64.json'))).toMatchObject({ x64: 'done' });
  });

  it('plans to sign what is not signed and to send only what is signed, and nothing for the rest', () => {
    expect(macPlan({ arm64: 'none', x64: 'none' })).toEqual({ sign: ['arm64', 'x64'], submit: [] });
    expect(macPlan({ arm64: 'signed', x64: 'none' })).toEqual({ sign: ['x64'], submit: ['arm64'] });
    expect(macPlan({ arm64: 'submitted', x64: 'done' })).toEqual({ sign: [], submit: [] });
    expect(ARCHS).toEqual(['arm64', 'x64']);
  });
});

describe('latest-mac.yml', () => {
  it('lists the zips, then the disk images, Intel first, and points at the first zip', () => {
    const names = macFeedNames('1.0.0');
    expect(names).toEqual(['Atelier-1.0.0-mac.zip', 'Atelier-1.0.0-arm64-mac.zip', 'Atelier-1.0.0.dmg', 'Atelier-1.0.0-arm64.dmg']);
    const text = renderMacFeed('1.0.0', names.map((url, i) => ({ url, sha512: `h${i}`, size: i + 1 })), '2026-01-01T00:00:00.000Z');
    expect(text).toBe(
      "version: 1.0.0\nfiles:\n  - url: Atelier-1.0.0-mac.zip\n    sha512: h0\n    size: 1\n  - url: Atelier-1.0.0-arm64-mac.zip\n    sha512: h1\n    size: 2\n  - url: Atelier-1.0.0.dmg\n    sha512: h2\n    size: 3\n  - url: Atelier-1.0.0-arm64.dmg\n    sha512: h3\n    size: 4\npath: Atelier-1.0.0-mac.zip\nsha512: h0\nreleaseDate: '2026-01-01T00:00:00.000Z'\n",
    );
  });
});
