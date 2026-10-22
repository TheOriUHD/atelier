/**
 * The pure parts of the release command (deploy/ship/release.mjs): versions, the changelog, the update files and
 * which files a release must contain. Nothing here touches the network, git or the disk beyond what a function says.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** `0.1.11` or `v0.3.0-beta.1` into what the command needs; throws with a message for the person. */
export function parseVersion(input) {
  const version = String(input ?? '').trim().replace(/^v/, '');
  if (!SEMVER.test(version)) throw new Error(`"${input}" is not a version. Use 0.1.11 or 0.3.0-beta.1.`);
  const prerelease = version.includes('-');
  return { version, tag: `v${version}`, prerelease, channel: prerelease ? 'beta' : 'stable' };
}

/** -1, 0 or 1; a release is newer than its own prereleases. */
export function compareVersions(a, b) {
  const [pa, pb] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (!pa || !pb) throw new Error(`Cannot compare ${a} and ${b}.`);
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  const [xs, ys] = [pa[4].split('.'), pb[4].split('.')];
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const [x, y] = [xs[i], ys[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** `APP.version` in packages/protocol/src/app.ts. */
export function readAppVersion(source) {
  return /^ {2}version: '([^']*)',$/m.exec(source)?.[1] ?? null;
}

export function setAppVersion(source, version) {
  if (readAppVersion(source) === null) throw new Error("Can't find `version: '…'` in packages/protocol/src/app.ts.");
  return source.replace(/^( {2}version: ')[^']*(',)$/m, `$1${version}$2`);
}

/** The desktop package's own version, which electron-builder names the packages and update files after. */
export function readPackageVersion(source) {
  return /^ {2}"version": "([^"]*)",$/m.exec(source)?.[1] ?? null;
}

export function setPackageVersion(source, version) {
  if (readPackageVersion(source) === null) throw new Error("Can't find the version in apps/desktop/package.json.");
  return source.replace(/^( {2}"version": ")[^"]*(",)$/m, `$1${version}$2`);
}

/** Whether a stable release has its "What's new" notes (packages/ui/src/features/whats-new/release-notes.ts). */
export function hasReleaseNotes(source, version) {
  return source.includes(`version: '${version}'`);
}

const HEADING = /^## \[([^\]]+)\].*$/gm;

/** The body of one `## [x]` section of the changelog, trimmed; null when there is none. */
export function changelogSection(text, name) {
  const heads = [...text.matchAll(HEADING)];
  const at = heads.findIndex((h) => h[1] === name);
  if (at < 0) return null;
  const start = heads[at].index + heads[at][0].length;
  const end = heads[at + 1]?.index ?? text.length;
  return text.slice(start, end).trim();
}

/** The GitHub release's text: the version's changelog section, or for a prerelease the changes waiting in Unreleased. */
export function releaseNotes(text, version) {
  if (!version.includes('-')) return changelogSection(text, version) ?? '';
  return `A prerelease of the next version. The changes since the last release:\n\n${changelogSection(text, 'Unreleased') ?? ''}`;
}

/** Turns `## [Unreleased]` into the version's section, dated, with a new empty Unreleased above it. */
export function cutChangelog(text, version, date) {
  if (changelogSection(text, version) !== null) throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  const unreleased = changelogSection(text, 'Unreleased');
  if (unreleased === null) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.');
  if (!unreleased) throw new Error('"## [Unreleased]" in CHANGELOG.md is empty: there is nothing to release.');
  return text.replace(/^## \[Unreleased\].*$/m, `## [Unreleased]\n\n## [${version}] — ${date}`);
}

/** The files a release must contain, by where they are built. */
export function expectedFiles(version) {
  const v = version;
  const blockmaps = (names) => names.map((n) => `${n}.blockmap`);
  const macPackages = [`Atelier-${v}-mac.zip`, `Atelier-${v}-arm64-mac.zip`, `Atelier-${v}.dmg`, `Atelier-${v}-arm64.dmg`];
  return {
    linux: [`Atelier-${v}.AppImage`, `Atelier-${v}-arm64.AppImage`, `Atelier-${v}-amd64.deb`, `Atelier-${v}-arm64.deb`, 'latest-linux.yml', 'latest-linux-arm64.yml'],
    windows: [`Atelier-Setup-${v}.exe`, `Atelier-Setup-${v}.exe.blockmap`, 'latest.yml'],
    mac: [...macPackages, ...blockmaps(macPackages), 'latest-mac.yml'],
  };
}

/** The packages (files that get a `.sig`) among names. */
export const isPackage = (name) => /\.(exe|dmg|zip|deb|AppImage)$/.test(name);
export const isUpdateFile = (name) => /^latest.*\.ya?ml$/.test(name);

/** electron-builder's update file: the version and each file with its sha512 (base64) and size. Its format is fixed and flat. */
export function parseUpdateFile(text) {
  const version = /^version: *(.+)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null;
  const files = [];
  for (const block of text.split(/^ {2}- url: /m).slice(1)) {
    const lines = block.split('\n');
    const sha512 = /^ {4}sha512: *(\S+)/m.exec(block)?.[1];
    const size = /^ {4}size: *(\d+)/m.exec(block)?.[1];
    if (!lines[0] || !sha512 || size === undefined) throw new Error(`An entry of the update file has no sha512 or size:\n${block.slice(0, 200)}`);
    files.push({ url: lines[0].trim().replace(/^['"]|['"]$/g, ''), sha512, size: Number(size) });
  }
  if (!version || files.length === 0) throw new Error('Not an update file: no version or no files.');
  return { version, files };
}

export const sha512Base64 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64');

/**
 * Checks a folder of built files against what the release needs: every expected file exists and isn't empty, every
 * update file names this version, and every file it lists is in the folder with the same size and sha512.
 * Returns the problems (an empty list means the folder is a release).
 */
export function checkRelease(dir, version, platforms = ['linux', 'windows', 'mac']) {
  const problems = [];
  const expected = expectedFiles(version);
  for (const platform of platforms) {
    for (const name of expected[platform]) {
      const file = join(dir, name);
      if (!existsSync(file)) problems.push(`${platform}: ${name} is missing`);
      else if (statSync(file).size === 0) problems.push(`${platform}: ${name} is empty`);
    }
    for (const name of expected[platform].filter(isUpdateFile)) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      let feed;
      try {
        feed = parseUpdateFile(readFileSync(file, 'utf8'));
      } catch (e) {
        problems.push(`${name}: ${e.message}`);
        continue;
      }
      if (feed.version !== version) problems.push(`${name} says version ${feed.version}, not ${version}`);
      for (const entry of feed.files) {
        const target = join(dir, entry.url);
        if (!existsSync(target)) problems.push(`${name} lists ${entry.url}, which is not in the folder`);
        else if (statSync(target).size !== entry.size) problems.push(`${entry.url} is ${statSync(target).size} bytes, ${name} says ${entry.size}`);
        else if (sha512Base64(target) !== entry.sha512) problems.push(`${entry.url} does not match the sha512 in ${name}`);
      }
    }
  }
  return problems;
}

/** `https://github.com/Owner/repo(.git)` or `git@github.com:Owner/repo.git` into `Owner/repo`. */
export function repoFromRemote(url) {
  const match = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?\/?$/.exec(url.trim());
  if (!match) throw new Error(`The remote "${url}" is not a GitHub repository.`);
  return match[1];
}

/** The server image names for a repository and a version: ghcr wants them lower case. */
export function imageNames(repo, tag, prerelease) {
  const base = `ghcr.io/${repo.split('/')[0].toLowerCase()}/atelier`;
  const tags = (name) => [`${name}:${tag}`, ...(prerelease ? [] : [`${name}:latest`])];
  return { main: tags(base), sandbox: tags(`${base}-sandbox`), updater: tags(`${base}-updater`), base };
}

/** "1m 05s", "12s", "2h 03m": how long a step took. */
export function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** The notarization answers `package:mac --status` prints (`  arm64: Accepted  (id, sent …)`) as { arm64: 'Accepted', … }. */
export function parseNotarizationStatus(output) {
  const out = {};
  for (const m of output.matchAll(/^ {2}(arm64|x64): (.+?) {2}\(/gm)) out[m[1]] = m[2];
  return out;
}

/**
 * The one-line installer (deploy/ship/install.sh.tmpl) for a version: its name and the sha256 of each platform's
 * atelier-setup are written into the script, so what it downloads is checked against what was released.
 */
export function renderInstaller(template, version, sums) {
  const lines = Object.entries(sums)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, sha]) => {
      if (!/^atelier-setup-(linux|darwin)-(amd64|arm64)$/.test(name)) throw new Error(`Unexpected installer file ${name}.`);
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`${name} has no valid sha256.`);
      return `${sha}  ${name}`;
    });
  if (lines.length === 0) throw new Error('The installer needs at least one binary.');
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) throw new Error(`"${version}" cannot be a version in the installer.`);
  if (!template.includes('@VERSION@') || !template.includes('@SUMS@')) throw new Error('The installer template lacks @VERSION@ or @SUMS@.');
  // The checksums sit on separate lines inside the shell string.
  return template.replace('@VERSION@', version).replace('@SUMS@', `\n${lines.join('\n')}\n`);
}
