/** What the update files and the bucket's listing say, as plain functions (no Worker APIs, so they can be tested). */

/**
 * The package kinds the download page offers, in the order it shows them, with how to tell them apart by name.
 * Windows has an installer per architecture since 0.3.2; the one that carried both (`Atelier-Setup-<version>.exe`) is
 * what older releases in the bucket have, and is only shown while no newer per-architecture installer exists.
 */
export const KINDS = [
  { id: 'windows-x64', label: 'Windows', note: 'x64', test: (n) => /^Atelier-Setup-.*-x64\.exe$/.test(n) },
  { id: 'windows-arm64', label: 'Windows', note: 'ARM64', test: (n) => /^Atelier-Setup-.*-arm64\.exe$/.test(n) },
  { id: 'windows', label: 'Windows', note: 'x64 and ARM64', test: (n) => /^Atelier-Setup-\d[^-]*(?:-[A-Za-z0-9.]+)?\.exe$/.test(n) && !/-(x64|arm64)\.exe$/.test(n) },
  { id: 'mac-arm64', label: 'macOS, Apple silicon', note: '.dmg', test: (n) => /^Atelier-.*arm64\.dmg$/.test(n) },
  { id: 'mac-x64', label: 'macOS, Intel', note: '.dmg', test: (n) => /^Atelier-.*\.dmg$/.test(n) && !/arm64/.test(n) },
  { id: 'linux-deb-x64', label: 'Linux, Debian and Ubuntu', note: '.deb, x64', test: (n) => /^Atelier-.*amd64\.deb$/.test(n) },
  { id: 'linux-deb-arm64', label: 'Linux, Debian and Ubuntu', note: '.deb, ARM64', test: (n) => /^Atelier-.*arm64\.deb$/.test(n) },
  { id: 'linux-appimage-x64', label: 'Linux, AppImage', note: 'x64', test: (n) => /^Atelier-.*\.AppImage$/.test(n) && !/arm64/.test(n) },
  { id: 'linux-appimage-arm64', label: 'Linux, AppImage', note: 'ARM64', test: (n) => /^Atelier-.*arm64\.AppImage$/.test(n) },
];

/** `1.2.3-beta.4` as a comparable list; releases sort above their own prereleases. */
function parts(version) {
  const [core, pre = ''] = version.split('-');
  return [...core.split('.').map(Number), pre ? 0 : 1, pre];
}

/** Positive when `a` is newer than `b`. */
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (typeof x[i] === 'number' && typeof y[i] === 'number') return x[i] - y[i];
    return String(x[i] ?? '') < String(y[i] ?? '') ? -1 : 1;
  }
  return 0;
}

/** The version in a package's file name (`Atelier-0.2.0-arm64.dmg` is 0.2.0, `Atelier-0.3.0-beta.1.exe` 0.3.0-beta.1). */
export function versionOfFile(name) {
  const base = name.replace(/\.(exe|dmg|zip|deb|AppImage|blockmap)$/, '').replace(/-(arm64-mac|mac|arm64|amd64|x64)$/, '');
  return /^Atelier-(?:Setup-)?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)$/.exec(base)?.[1] ?? null;
}

/** The newest file of each kind among `names`: `{ id, label, note, name, version }[]`. */
export function latestPackages(names) {
  const out = [];
  for (const kind of KINDS) {
    const best = names
      .filter((n) => kind.test(n))
      .map((name) => ({ name, version: versionOfFile(name) }))
      .filter((f) => f.version)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (best) out.push({ id: kind.id, label: kind.label, note: kind.note, ...best });
  }
  // The installer that carried both architectures is a fallback for a bucket whose newest Windows release has no other.
  const split = out.filter((p) => p.id === 'windows-x64' || p.id === 'windows-arm64');
  const combined = out.find((p) => p.id === 'windows');
  if (combined && split.some((p) => compareVersions(p.version, combined.version) >= 0)) out.splice(out.indexOf(combined), 1);
  return out;
}

/**
 * The files an update file (`latest*.yml`) announces: the `url:` of each entry. The download page lists only these, so
 * a package that is in the bucket but that no update file points at yet (a release being uploaded: the update files
 * go last) is not offered.
 */
export function announcedFiles(texts) {
  const names = new Set();
  for (const text of texts) for (const m of text.matchAll(/^ {2}- url: *['"]?([^'"\s]+)['"]?\s*$/gm)) names.add(m[1]);
  return [...names];
}

/**
 * Where a macOS disk image that is not in the bucket is: the same file on the GitHub release (the repository is public).
 * Releases from 0.3.2 on leave the .dmg off the feed to save an upload; the app's "Download" button on a Mac that can't
 * replace itself, and older apps' too, ask the feed for it by the name `latest-mac.yml` gives. Null for any other key.
 */
export function diskImageUrl(key, repo) {
  const m = /^(?:stable|beta)\/(Atelier-[A-Za-z0-9._-]+\.dmg)$/.exec(key);
  const version = m && versionOfFile(m[1]);
  return version ? `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(m[1])}` : null;
}
