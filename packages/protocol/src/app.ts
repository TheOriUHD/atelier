/** Single source of truth for the product identity. Renaming the app is an edit to this object. */
export const APP = {
  name: 'Atelier',
  /** Reverse-DNS id used for the Electron appId, keychain service and OS integrations. */
  id: 'dev.atelier.app',
  /** Config directory name under the home directory and in projects (`~/.atelier`, `<repo>/.atelier`). */
  dirName: '.atelier',
  /** URL scheme prefix for desktop custom protocols (`atelier-blob://`, `atelier-artifact://`). */
  scheme: 'atelier',
  /** Web session cookie name. */
  cookie: 'atelier_session',
  version: '0.2.2',
  /** Where the desktop builds are published (a private repository, so only people with access can open it). */
  releases: 'https://github.com/TheOriUHD/atelier/releases',
  /** Every change, release by release. */
  changelog: 'https://github.com/TheOriUHD/atelier/blob/main/CHANGELOG.md',
  /** The documentation site (apps/docs). */
  docs: 'https://docs.atelierhq.dev',
  /**
   * The public update feed (deploy/cloudflare): where a desktop app looks for newer versions when it has no Atelier
   * server of its own. `ATELIER_UPDATE_FEED` overrides it; none turns it off.
   */
  updateFeed: 'https://updates.atelierhq.dev' as string,
  /**
   * The key updates are signed with (Ed25519, raw 32 bytes, base64). An app installs only packages whose `<file>.sig`
   * it verifies against this; the private half stays on the publisher's machine (deploy/cloudflare/publish.mjs).
   */
  updatePublicKey: 'QKWr+6UdPHGGz8ZacACgYkc/UzXh5HqMOqBWa8l+JKM=' as string,
} as const;

/**
 * Content-Security-Policy for the artifact runtime page. `scriptOrigin` is where the runtime's own bundle
 * is served from. No network access: artifacts are self-contained (see the chat prompt).
 */
export function artifactRuntimeCsp(scriptOrigin: string): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    // Sucrase output runs through new Function, and HTML artifacts carry inline scripts.
    `script-src ${scriptOrigin} 'unsafe-inline' 'unsafe-eval' blob:`,
    `style-src ${scriptOrigin} 'unsafe-inline'`,
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}
