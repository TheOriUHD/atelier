/**
 * The pure parts of scripts/package-mac.mjs and of the release command's macOS step (deploy/ship/release.mjs): the
 * command line, which stage each architecture is at, and the text of latest-mac.yml. Nothing here runs a program.
 * Tests: deploy/ship/mac.test.ts.
 */
import { join } from 'node:path';

export const ARCHS = ['arm64', 'x64'];

/**
 * `package:mac [--finish|--status|--feed] [--arch arm64|x64]... [--sign-only] [--submit] [--force]`.
 * Without --arch a signing run does both architectures, and --finish/--status do those that are with Apple.
 */
export function parseMacArgs(argv) {
  const out = { mode: 'submit', archs: null, signOnly: false, resume: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--finish') out.mode = 'finish';
    else if (a === '--status') out.mode = 'status';
    else if (a === '--feed') out.mode = 'feed';
    else if (a === '--sign-only') out.signOnly = true;
    else if (a === '--submit') out.resume = true;
    else if (a === '--force') out.force = true;
    else if (a === '--arch' || a.startsWith('--arch=')) {
      const value = a === '--arch' ? argv[++i] : a.slice('--arch='.length);
      if (!ARCHS.includes(value)) throw new Error(`--arch takes ${ARCHS.join(' or ')}, not "${value ?? ''}".`);
      out.archs = [...new Set([...(out.archs ?? []), value])];
    } else throw new Error(`Unknown flag ${a}. See the top of apps/desktop/scripts/package-mac.mjs.`);
  }
  if (out.signOnly && out.resume) throw new Error('--sign-only and --submit contradict each other: one stops after signing, the other starts after it.');
  return out;
}

/** What the signing step of one architecture leaves in release-mac: the app, a marker that signing finished, and Apple's ticket number. */
export const macFiles = {
  app: (release, arch) => join(release, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Atelier.app'),
  /** Written when electron-builder has signed the app, so a failed submission can be redone without signing again. */
  signed: (release, arch) => join(release, `signed-${arch}`),
  /** One file per architecture, because both are signed and submitted side by side. */
  state: (release, arch) => join(release, `notarization-${arch}.json`),
  zip: (release, arch) => join(release, `notarize-${arch}.zip`),
};

/** The disk image and the zip of one architecture, as electron-builder names them (Intel has no suffix). */
export function macPackages(version, arch) {
  return arch === 'arm64' ? [`Atelier-${version}-arm64-mac.zip`, `Atelier-${version}-arm64.dmg`] : [`Atelier-${version}-mac.zip`, `Atelier-${version}.dmg`];
}

/**
 * How far each architecture has come, from what exists on disk: `none` (nothing signed), `signed` (signed, not sent to
 * Apple), `submitted` (with Apple), `done` (disk image and zip made). `has(path)` tells whether a file exists.
 */
export function macProgress(release, version, has) {
  const out = {};
  for (const arch of ARCHS) {
    if (macPackages(version, arch).every((name) => has(join(release, name)))) out[arch] = 'done';
    else if (has(macFiles.state(release, arch))) out[arch] = 'submitted';
    else if (has(macFiles.signed(release, arch)) && has(macFiles.app(release, arch))) out[arch] = 'signed';
    else out[arch] = 'none';
  }
  return out;
}

/** What the release command runs for the macOS apps, given `macProgress`: the architectures to sign and send, and those to send only. */
export function macPlan(progress) {
  const pick = (stage) => ARCHS.filter((arch) => progress[arch] === stage);
  return { sign: pick('none'), submit: pick('signed') };
}

/** `latest-mac.yml`: both architectures, zips first and then disk images, Intel first (the order electron-builder uses). */
export function renderMacFeed(version, entries, releaseDate) {
  const lines = ['version: ' + version, 'files:'];
  for (const e of entries) lines.push(`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`);
  lines.push(`path: ${entries[0].url}`, `sha512: ${entries[0].sha512}`, `releaseDate: '${releaseDate}'`, '');
  return lines.join('\n');
}

/** The four files latest-mac.yml lists, in its order. */
export const macFeedNames = (version) => [`Atelier-${version}-mac.zip`, `Atelier-${version}-arm64-mac.zip`, `Atelier-${version}.dmg`, `Atelier-${version}-arm64.dmg`];
