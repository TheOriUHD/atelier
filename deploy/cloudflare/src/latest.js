/** What the update files and the bucket's listing say, as plain functions (no Worker APIs, so they can be tested). */

/** The package kinds the download page offers, in the order it shows them, with how to tell them apart by name. */
export const KINDS = [
  { id: 'windows', label: 'Windows', note: 'x64 and ARM64', test: (n) => /^Atelier-Setup-.*\.exe$/.test(n) },
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
  return out;
}
