/**
 * Where the terminal keeps its secrets: a server's sign-in token, and the standalone backend's key for its secrets
 * (the API keys the person adds). The system's own store where there is one, without a native module:
 *   macOS    the login keychain, through `security -i` (the secret goes over stdin, never on a command line)
 *   Linux    the Secret Service (GNOME Keyring, KWallet), through `secret-tool`, when a session bus is there
 *   Windows  DPAPI for this Windows user, through PowerShell; the sealed value is kept in credentials.json
 * otherwise credentials.json, readable by this user only (as on a server without a keyring).
 */
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { writePrivate } from './config.ts';

const run = promisify(execFile);
const SERVICE = 'Atelier CLI';

export type StoreKind = 'keychain' | 'secret-service' | 'dpapi' | 'file';

export interface CredentialStore {
  readonly kind: StoreKind;
  /** The value, or null when none is stored. A value that is stored but can't be read now throws, never null. */
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** What `security -i` and our files can carry unquoted: tokens, hex and base64. */
const PLAIN = /^[A-Za-z0-9._~+/=:-]{1,4096}$/;

function piped(command: string, args: string[], input: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${command} exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

/** credentials.json: `{name: value}`; values are plain, or `dpapi:` sealed on Windows. */
class FileStore implements CredentialStore {
  readonly kind: StoreKind = 'file';
  constructor(protected file: string) {}
  protected async all(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  async get(name: string): Promise<string | null> {
    return (await this.all())[name] ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    await writePrivate(this.file, `${JSON.stringify({ ...(await this.all()), [name]: value }, null, 2)}\n`);
  }
  async delete(name: string): Promise<void> {
    const all = await this.all();
    if (!(name in all)) return;
    delete all[name];
    await writePrivate(this.file, `${JSON.stringify(all, null, 2)}\n`);
  }
}

class MacKeychain implements CredentialStore {
  readonly kind: StoreKind = 'keychain';
  /** Null only when the item isn't there (`security` exits 44); a locked or refusing keychain throws. */
  async get(name: string): Promise<string | null> {
    try {
      return (await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { timeout: 30_000 })).stdout.replace(/\n$/, '') || null;
    } catch (e) {
      if ((e as { code?: unknown }).code === 44) return null;
      throw new Error(`The keychain didn't give Atelier its saved ${name}: ${e instanceof Error ? e.message.split('\n').at(-1) : String(e)}`, { cause: e });
    }
  }
  async set(name: string, value: string): Promise<void> {
    if (!PLAIN.test(value) || !PLAIN.test(name)) throw new Error('This value can’t go into the keychain.');
    await piped('security', ['-i'], `add-generic-password -U -s "${SERVICE}" -a "${name}" -w "${value}"\n`);
  }
  async delete(name: string): Promise<void> {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { timeout: 10_000 }).catch(() => undefined);
  }
}

class SecretService implements CredentialStore {
  readonly kind: StoreKind = 'secret-service';
  async get(name: string): Promise<string | null> {
    try {
      return (await run('secret-tool', ['lookup', 'service', 'atelier-cli', 'account', name], { timeout: 10_000 })).stdout.replace(/\n$/, '') || null;
    } catch {
      return null;
    }
  }
  async set(name: string, value: string): Promise<void> {
    await piped('secret-tool', ['store', `--label=${SERVICE} (${name})`, 'service', 'atelier-cli', 'account', name], value);
  }
  async delete(name: string): Promise<void> {
    await run('secret-tool', ['clear', 'service', 'atelier-cli', 'account', name], { timeout: 10_000 }).catch(() => undefined);
  }
}

const PS = ['-NoProfile', '-NonInteractive', '-Command'];
const DPAPI = (verb: 'Protect' | 'Unprotect') =>
  `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); ` +
  (verb === 'Protect'
    ? `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'))`
    : `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser'))`);

class WindowsDpapi extends FileStore {
  override readonly kind: StoreKind = 'dpapi';
  /**
   * A sealed value that can't be unsealed now (PowerShell slow to start, busy or blocked) throws: read as "none", it
   * made the standalone backend write a new key over the one its saved API keys were sealed with, losing them.
   */
  override async get(name: string): Promise<string | null> {
    const sealed = await super.get(name);
    if (!sealed?.startsWith('dpapi:')) return sealed;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const value = (await piped('powershell.exe', [...PS, DPAPI('Unprotect')], sealed.slice(6))).trim();
        if (value) return value;
        last = new Error('PowerShell answered with nothing');
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`Windows couldn't unlock Atelier's saved ${name} for this user (DPAPI through PowerShell): ${last instanceof Error ? last.message : String(last)}`);
  }
  /** Sealed for this Windows user; where PowerShell can't seal it, kept as is in the file (readable by this user only). */
  override async set(name: string, value: string): Promise<void> {
    const sealed = await piped('powershell.exe', [...PS, DPAPI('Protect')], value).then(
      (out) => out.trim(),
      () => '',
    );
    await super.set(name, sealed ? `dpapi:${sealed}` : value);
  }
}

/** Remembers what it read, so a session doesn't start a process for every look. */
class Cached implements CredentialStore {
  private cache = new Map<string, string | null>();
  constructor(private inner: CredentialStore) {}
  get kind() {
    return this.inner.kind;
  }
  async get(name: string) {
    if (!this.cache.has(name)) this.cache.set(name, await this.inner.get(name));
    return this.cache.get(name) ?? null;
  }
  async set(name: string, value: string) {
    await this.inner.set(name, value);
    this.cache.set(name, value);
  }
  async delete(name: string) {
    await this.inner.delete(name);
    this.cache.set(name, null);
  }
}

/** One store per file in a process: each read of the system store can start a program (PowerShell on Windows). */
const stores = new Map<string, Promise<CredentialStore>>();

/** Tests: the next `credentialStore` is a fresh one, as in a new process. */
export function forgetStores(): void {
  stores.clear();
}

/** The best store this computer has; `ATELIER_CLI_CREDENTIALS=file` keeps everything in credentials.json. */
export function credentialStore(file: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<CredentialStore> {
  const key = `${platform}|${env.ATELIER_CLI_CREDENTIALS ?? ''}|${file}`;
  let store = stores.get(key);
  if (!store) {
    store = pickStore(file, env, platform);
    stores.set(key, store);
    store.catch(() => stores.delete(key));
  }
  return store;
}

async function pickStore(file: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<CredentialStore> {
  const fallback = new FileStore(file);
  if (env.ATELIER_CLI_CREDENTIALS === 'file') return new Cached(fallback);
  if (platform === 'darwin') return new Cached(await usable(new MacKeychain(), fallback));
  // DPAPI seals into the same credentials.json, so it is its own fallback: a second store over the same file deleted
  // every value right after it was written (the sign-in looped; the backend's key was new at every start).
  if (platform === 'win32') return new Cached(new WindowsDpapi(file));
  if (env.DBUS_SESSION_BUS_ADDRESS) {
    const found = await run('secret-tool', ['--version'], { timeout: 3000 }).then(
      () => true,
      () => false,
    );
    if (found) return new Cached(await usable(new SecretService(), fallback));
  }
  return new Cached(fallback);
}

/** A store that answers at all (a locked or missing keyring falls back to the file); probed with a read. */
async function usable(store: CredentialStore, fallback: CredentialStore): Promise<CredentialStore> {
  try {
    await store.get('probe');
    return new Prefer(store, fallback);
  } catch {
    return fallback;
  }
}

/** Writes go to the system store and fall back to the file when it refuses; reads look in both. */
class Prefer implements CredentialStore {
  constructor(
    private first: CredentialStore,
    private second: CredentialStore,
  ) {}
  get kind() {
    return this.first.kind;
  }
  /** The system store's value, else the file's; a sealed value in the file is the system store's to read, never a value. */
  async get(name: string) {
    const value = await this.first.get(name);
    if (value !== null) return value;
    const raw = await this.second.get(name);
    return raw?.startsWith('dpapi:') ? null : raw;
  }
  async set(name: string, value: string) {
    try {
      await this.first.set(name, value);
      await this.second.delete(name);
    } catch {
      await this.second.set(name, value);
    }
  }
  async delete(name: string) {
    await this.first.delete(name);
    await this.second.delete(name);
  }
}

/** The name a server's token is kept under. */
export const tokenName = (serverUrl: string) => `token:${new URL(serverUrl).host}`;
export const LOCAL_KEY = 'local-key';
