/**
 * Which download is which, by file name (electron-builder's names for this app), and which of them the update feed
 * carries. Used by releases.mjs; tests: deploy/ship/site.test.ts.
 */

// The version, with an optional prerelease part that is never an architecture (0.3.0-beta.1, not 0.3.0-arm64).
const V = String.raw`\d+\.\d+\.\d+(?:-(?!arm64|amd64|x64)[A-Za-z0-9.]+)?`;

export const KINDS = {
  'macos-arm64': new RegExp(`^Atelier-${V}-arm64\\.dmg$`),
  'macos-x64': new RegExp(`^Atelier-${V}\\.dmg$`),
  // An installer per architecture since 0.3.2 (electron-builder.yml); before, one that carried both.
  'windows-x64': new RegExp(`^Atelier-Setup-${V}-x64\\.exe$`),
  'windows-arm64': new RegExp(`^Atelier-Setup-${V}-arm64\\.exe$`),
  'linux-deb-x64': new RegExp(`^Atelier-${V}-amd64\\.deb$`),
  'linux-deb-arm64': new RegExp(`^Atelier-${V}-arm64\\.deb$`),
  'linux-appimage-x64': new RegExp(`^Atelier-${V}\\.AppImage$`),
  'linux-appimage-arm64': new RegExp(`^Atelier-${V}-arm64\\.AppImage$`),
};

/**
 * Whether a build is expected on the update feed. The macOS disk images are not (deploy/cloudflare/upload.mjs): they
 * are for a first install, and the page links them on the GitHub release, which is public.
 */
export const onFeed = (kind) => !kind.startsWith('macos-');
