/**
 * Paths that hold credentials, keys or the browser's and the app's private data. Looking at a file elsewhere on the
 * machine is ordinary work for an agent, and Auto mode lets it through unreviewed; these are the exceptions, which the
 * reviewing model still sees (it allows them only when the person asked for exactly this).
 */
const PATTERNS: [RegExp, string][] = [
  [/(^|\/)\.(ssh|aws|gnupg|kube|azure|password-store)(\/|$)/, 'credentials or keys'],
  [/(^|\/)\.config\/(gcloud|gh|op|doctl|hub|git\/credentials)(\/|$)/, 'credentials'],
  [/(^|\/)\.docker\/config\.json$/, 'registry credentials'],
  [/(^|\/)\.(netrc|git-credentials|npmrc|pypirc|pgpass|my\.cnf|vault-token)$/, 'credentials'],
  [/(^|\/)\.env(\.[\w.-]+)?$/, 'environment secrets'],
  [/(^|\/)(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]+\.(pem|key|p12|pfx|keystore|kdbx|jks))$/, 'a private key or key store'],
  [/(^|\/)Library\/(Keychains|Cookies|Application Support\/(Google\/Chrome|BraveSoftware|Firefox|Microsoft Edge|Arc|1Password))(\/|$)/, 'keychains or browser data'],
  [/(^|\/)\.(config|mozilla|cache)\/(google-chrome|chromium|BraveSoftware|mozilla|1Password)(\/|$)/, 'browser or password-manager data'],
  [/(^|\/)AppData\/(Local|Roaming)\/(Google\/Chrome|BraveSoftware|Mozilla|Microsoft\/Edge|Microsoft\/(Credentials|Vault|Protect)|1Password|Opera Software)(\/|$)/, 'browser data, keychains or password-manager data'],
  [/^\/etc\/(shadow|gshadow|sudoers(\.d\/.*)?|ssh\/ssh_host_[^/]*_key)$/, 'system credentials'],
  [/^\/proc\/[^/]+\/environ$/, 'a process environment'],
  [/(^|\/)\.claude(\.json|\/\.credentials\.json)$/, "the agent's credentials"],
  [/(^|\/)\.atelier\/(data|ssh|settings(\.local)?\.json)(\/|$)/, "the app's private data"],
];

/** Why reading the (absolute) path is not ordinary, or null. */
export function credentialPath(abs: string): string | null {
  const normalized = abs.replace(/\\/g, '/');
  // A Windows disk doesn't tell `.SSH` from `.ssh`.
  const win = process.platform === 'win32' || /^[a-zA-Z]:\//.test(normalized);
  return PATTERNS.find(([pattern]) => pattern.test(normalized) || (win && new RegExp(pattern.source, 'i').test(normalized)))?.[1] ?? null;
}
