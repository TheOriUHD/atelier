/**
 * Connector entries as the Connectors page writes them (`mcpServers.<name>`, Claude Code's shape). Credentials go
 * to the secret store; the entry keeps only `${secret:<id>}` references, with ids derived from the connector name.
 * A connector that signs in with OAuth needs none: the backend keeps what the sign-in gives it.
 */
import { McpServerName, presetRunsOn, type ConnectorPreset, type McpImportEntry, type McpServerConfig, type McpTransport, type SecretSummary } from '@atelier/protocol';

/** A credential to store before the entry that refers to it is written. */
export interface NewSecret {
  id: string;
  label: string;
  kind: SecretSummary['kind'];
  value: string;
}

/** A header (http, sse) or environment variable (stdio). `secret` undefined: stored as a secret when its name looks like a credential. */
export interface Pair {
  name: string;
  value: string;
  secret?: boolean;
}

export interface ConnectorForm {
  name: string;
  type: McpTransport;
  url: string;
  command: string;
  /** One argument per line. */
  args: string;
  pairs: Pair[];
  /** http and sse: sign in with OAuth. */
  oauth: boolean;
}

export type ConnectorFormErrors = Partial<Record<'name' | 'url' | 'command' | 'pairs', string>>;

/** Names of headers and env vars that usually hold credentials (as the backend's import checks them). */
const CREDENTIAL_NAME = /token|key|secret|passw|credential|auth/i;

/** `Authorization: Bearer …` keeps its scheme in the entry; only the token is the secret. */
const SCHEME = /^(Bearer|Basic|Token)\s+(\S.*)$/is;

/** A valid secret id (`[a-z0-9-]`, at most 64) from its parts, e.g. `mcp-github-authorization`. */
export function secretId(...parts: string[]): string {
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** The value as written to the entry, referring to secret `id`. */
const reference = (id: string) => `\${secret:${id}}`;

export function secretKind(name: string): SecretSummary['kind'] {
  return /key/i.test(name) ? 'api_key' : 'token';
}

/** Whether a pair is marked to be kept as a secret: by hand, or by a name that looks like a credential. */
export function wantsSecret(pair: Pair): boolean {
  return pair.secret ?? CREDENTIAL_NAME.test(pair.name);
}

/** Whether a pair's value goes to the secret store; references (`${…}`) and empty values never do. */
export function storesSecret(pair: Pair): boolean {
  return wantsSecret(pair) && !!pair.value.trim() && !pair.value.includes('${');
}

/** Moves the literal `value` named `name` into a secret of `server`, returning what the entry keeps instead. */
function moveToSecret(server: string, name: string, value: string, secrets: NewSecret[]): string {
  const id = secretId('mcp', server, name);
  const [, scheme, token] = SCHEME.exec(value.trim()) ?? [];
  secrets.push({ id, label: `${name} for ${server}`, kind: secretKind(name), value: token ?? value.trim() });
  return scheme ? `${scheme} ${reference(id)}` : reference(id);
}

export function emptyForm(): ConnectorForm {
  return { name: '', type: 'http', url: '', command: '', args: '', pairs: [], oauth: false };
}

export function formFromConfig(name: string, config: McpServerConfig): ConnectorForm {
  const values = config.type === 'stdio' ? config.env : config.headers;
  return {
    name,
    type: config.type,
    url: config.url ?? '',
    command: config.command ?? '',
    args: config.args.join('\n'),
    pairs: Object.entries(values).map(([n, value]) => ({ name: n, value })),
    oauth: config.auth === 'oauth',
  };
}

/** `taken`: the names of the other connectors. */
export function connectorNameError(name: string, taken: ReadonlySet<string>): string | undefined {
  const parsed = McpServerName.safeParse(name.trim());
  if (!parsed.success) return name.trim() ? parsed.error.issues[0]!.message : 'Give it a name.';
  return taken.has(parsed.data) ? 'There is a connector with this name already.' : undefined;
}

export function connectorFormErrors(form: ConnectorForm, taken: ReadonlySet<string>): ConnectorFormErrors {
  const errors: ConnectorFormErrors = {};
  const name = connectorNameError(form.name, taken);
  if (name) errors.name = name;
  if (form.type === 'stdio' && !form.command.trim()) errors.command = 'Enter the command that starts the server.';
  if (form.type !== 'stdio' && !URL.canParse(form.url.trim()) && !form.url.includes('${')) errors.url = 'Enter the server’s URL, like https://example.com/mcp.';
  if (form.pairs.some((p) => !p.name.trim() && p.value.trim())) errors.pairs = 'Every value needs a name.';
  return errors;
}

/**
 * The entry for a valid form plus the secrets to store first. `keep` carries what the form doesn't edit
 * (enabled, disabled tools, preset) over from the entry being edited.
 */
export function entryFromForm(form: ConnectorForm, keep: Partial<McpServerConfig> = {}): { entry: Partial<McpServerConfig>; secrets: NewSecret[] } {
  const name = form.name.trim();
  const secrets: NewSecret[] = [];
  const values = Object.fromEntries(
    form.pairs
      .filter((p) => p.name.trim())
      .map((p) => [p.name.trim(), storesSecret(p) ? moveToSecret(name, p.name.trim(), p.value, secrets) : p.value]),
  );
  const lines = form.args.split('\n').map((a) => a.trim()).filter(Boolean);
  const transport = form.type === 'stdio' ? { command: form.command.trim(), args: lines, env: values } : { url: form.url.trim(), headers: values, ...(form.oauth ? { auth: 'oauth' as const } : {}) };
  const { enabled, disabledTools, preset } = keep;
  return { entry: { type: form.type, ...transport, enabled, disabledTools, preset }, secrets };
}

/** A preset's entry with the pasted token stored as `mcp-<name>`; `platform` is the system its program runs on. */
export function entryFromPreset(preset: ConnectorPreset, name: string, token: string, fields: Record<string, string>, platform: string): { entry: Partial<McpServerConfig>; secrets: NewSecret[] } {
  const id = secretId('mcp', name);
  return {
    entry: { ...preset.server({ secretRef: reference(id), fields, platform }), preset: preset.id },
    secrets: preset.token ? [{ id, label: `${preset.token.label} for ${name}`, kind: secretKind(preset.token.label), value: token.trim() }] : [],
  };
}

/** What `connectors.save` takes for a person's own connector. */
export interface PersonalInput {
  name: string;
  type: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  auth?: 'oauth';
}

/**
 * A preset as one of the person's own connectors: the pasted token goes in as it is, since all of its values are kept
 * as their secret on the server. `oauth` signs in to the preset's hosted server instead.
 */
export function personalFromPreset(preset: ConnectorPreset, name: string, token: string, fields: Record<string, string>, platform: string, oauth: boolean): PersonalInput {
  if (oauth && preset.oauth) return { name, type: 'http', url: preset.oauth.url, auth: 'oauth', env: {}, headers: {} };
  const server = preset.server({ secretRef: token.trim(), fields, platform });
  return server.type === 'stdio'
    ? { name, type: 'stdio', command: server.command!, args: server.args ?? [], env: server.env ?? {}, headers: {} }
    : { name, type: server.type, url: server.url!, env: {}, headers: server.headers ?? {} };
}

const SYSTEMS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/**
 * Why a preset can't be added from here, if it can't: its setup runs a program and nothing here runs one (`programs`),
 * or its program doesn't exist for the system it would run on (`platform`, null when that isn't known).
 */
export function presetUnavailable(preset: ConnectorPreset, programs: boolean, platform: string | null): string | undefined {
  if (!preset.desktopOnly || preset.oauth) return undefined;
  if (!programs) return 'Only in the desktop app: it runs a program on your computer.';
  if (platform && !presetRunsOn(preset, platform)) return `${preset.name} is only on ${(preset.platforms ?? []).map((p) => SYSTEMS[p] ?? p).join(' and ')}.`;
  return undefined;
}

/** A preset's hosted server, to sign in to with OAuth. */
export function entryForSignIn(preset: ConnectorPreset): Partial<McpServerConfig> {
  return { type: 'http', url: preset.oauth?.url, auth: 'oauth', preset: preset.id };
}

/** A Claude Code server with the literal credentials the backend flagged moved into secrets. */
export function entryFromImport({ name, config, secrets: flagged }: McpImportEntry): { entry: McpServerConfig; secrets: NewSecret[] } {
  const secrets: NewSecret[] = [];
  const entry = { ...config, env: { ...config.env }, headers: { ...config.headers } };
  for (const [field, key] of flagged) {
    if (field === 'url' && entry.url) entry.url = moveToSecret(name, 'URL', entry.url, secrets);
    if ((field === 'env' || field === 'headers') && key && entry[field][key]) entry[field][key] = moveToSecret(name, key, entry[field][key], secrets);
  }
  return { entry, secrets };
}
