/**
 * The server's chat sandbox keeps its accounts apart with the operating system (ARCHITECTURE §6): the container has a pool of
 * Unix users, `sbx000`, `sbx001`, …, and every account of the server is given one of them, for good. The server logs in
 * as that user, so the commands of a chat run as it, and the user's home and the account's chat folders are mode 0700:
 * another account's commands can neither read nor change them. `apps/server/sandbox/` makes the users and the folders.
 *
 * Which account has which user is kept here, in `<data dir>/sandbox/slots.json` (a slot is never given to a second
 * account), and told to the container through the shared keys volume: `<keys folder>/accounts/sbxNNN` holds the account's
 * id, which is the only way the container learns it. The container then makes `chats/<account id>` that user's (and
 * hands over the folders an earlier, shared layout left under that name).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SshError } from './ssh.ts';

/** The pool's size when `ATELIER_SANDBOX_SLOTS` is not set; the container builds the same number of users. */
export const SANDBOX_DEFAULT_SLOTS = 256;
export const SANDBOX_MAX_SLOTS = 9999;

/** Where the sandbox image keeps its volume, and what it keeps there (`apps/server/sandbox/atelier-sandbox`). */
export const SANDBOX_HOME = '/home/sandbox';
/** The accounts' homes (`u/sbxNNN`, mode 0700). */
export const SANDBOX_HOMES = `${SANDBOX_HOME}/u`;
/** The accounts' chat folders (`chats/<account id>/<chat>`, mode 0700 for the account's user). */
export const SANDBOX_CHATS = `${SANDBOX_HOME}/chats`;

/** The Unix user of a slot, as the image creates them. */
export const sandboxUserName = (slot: number) => `sbx${String(slot).padStart(3, '0')}`;

/** Ids become folder names inside the container, where a script run as root uses them: only these characters. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An SshError so that it reads, where errors of reaching the sandbox are shown, like the other ways the sandbox can't be used. */
export class SandboxAccountError extends SshError {}

/** The number of users the sandbox holds, from `ATELIER_SANDBOX_SLOTS`. */
export function sandboxSlots(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return SANDBOX_DEFAULT_SLOTS;
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < 1 || n > SANDBOX_MAX_SLOTS) {
    throw new SandboxAccountError(`ATELIER_SANDBOX_SLOTS must be a whole number from 1 to ${SANDBOX_MAX_SLOTS}, not "${value}".`);
  }
  return n;
}

/**
 * Where an account's chat folders go and which folder a runner is rooted at to make them. With the sandbox's own users
 * (the login's home is below `u/`) they are `chats/<account id>`, which the container made for that user; with a
 * single shared login (a sandbox of your own, `ATELIER_SANDBOX_USER`) they are `chats/<account id>` in its home folder.
 */
export function sandboxChats(userId: string, home: string): { dir: string; from: string } {
  if (home.startsWith(`${SANDBOX_HOMES}/`)) {
    const dir = `${SANDBOX_CHATS}/${userId}`;
    return { dir, from: dir };
  }
  return { dir: `${home}/chats/${userId}`, from: home };
}

interface Stored {
  version: 1;
  accounts: Record<string, number>;
}

export class SandboxAccounts {
  private accounts: Map<string, number> | null = null;
  /** Calls run one after the other, so two accounts arriving together never get the same slot. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The `user:account` pairs this process has told the container about. */
  private readonly told = new Set<string>();

  /**
   * @param file where the assignments are kept
   * @param accountsDir the folder (in the volume the container reads) to tell the container which account has which user; null where there is none
   * @param slots how many users the container has
   */
  constructor(
    private readonly file: string,
    private readonly accountsDir: string | null,
    readonly slots = SANDBOX_DEFAULT_SLOTS,
  ) {}

  /** The Unix user the account's commands run as. The first call gives the account the lowest free slot; later calls give the same. */
  userFor(userId: string): Promise<string> {
    const run = this.queue.then(() => this.assign(userId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async assign(userId: string): Promise<string> {
    if (!SAFE_ID.test(userId)) throw new SandboxAccountError('This account has no sandbox: its id is not one a folder can be named for.');
    if (!this.accountsDir) {
      throw new SandboxAccountError('The sandbox has no way to learn which account is which: set ATELIER_SANDBOX_KEYS to the file in the volume it reads its keys from (the compose file does).');
    }
    const accounts = await this.load();
    let slot = accounts.get(userId);
    if (slot === undefined) {
      const taken = new Set(accounts.values());
      slot = 0;
      while (taken.has(slot)) slot++;
      if (slot >= this.slots) {
        throw new SandboxAccountError(`The sandbox has no free account left (all ${this.slots} are taken). An admin can raise ATELIER_SANDBOX_SLOTS on both the server and the sandbox container.`);
      }
      // Kept before anyone uses it: an assignment that isn't on disk could be given to someone else after a restart.
      await this.save(new Map(accounts).set(userId, slot));
      accounts.set(userId, slot);
    }
    if (slot >= this.slots) {
      throw new SandboxAccountError(`This account's sandbox user is number ${slot}, beyond ATELIER_SANDBOX_SLOTS (${this.slots}). Set it back to at least ${slot + 1} on both the server and the sandbox container.`);
    }
    const user = sandboxUserName(slot);
    await this.tell(user, userId);
    return user;
  }

  private async load(): Promise<Map<string, number>> {
    if (this.accounts) return this.accounts;
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.accounts = new Map());
      throw error;
    }
    // A file that can't be understood is never replaced by an empty one: accounts would be given other accounts' slots.
    const broken = (why: string) => new SandboxAccountError(`${this.file} can't be used (${why}). Fix or restore it; the sandbox keeps accounts apart with it.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw broken('not JSON');
    }
    const stored = parsed as Partial<Stored> | null;
    if (!stored || stored.version !== 1 || typeof stored.accounts !== 'object' || stored.accounts === null) throw broken('unknown format');
    const accounts = new Map<string, number>();
    const used = new Set<number>();
    for (const [id, slot] of Object.entries(stored.accounts)) {
      if (!Number.isInteger(slot) || slot < 0 || slot >= SANDBOX_MAX_SLOTS || used.has(slot) || !SAFE_ID.test(id)) throw broken(`account ${id} has slot ${String(slot)}`);
      used.add(slot);
      accounts.set(id, slot);
    }
    return (this.accounts = accounts);
  }

  private async save(accounts: Map<string, number>): Promise<void> {
    const stored: Stored = { version: 1, accounts: Object.fromEntries(accounts) };
    await writeAtomically(this.file, `${JSON.stringify(stored, null, 2)}\n`, 0o700);
  }

  /** Puts the account's id where the container reads it, once per run of the server (this also repairs a recreated volume). */
  private async tell(user: string, userId: string): Promise<void> {
    const key = `${user}:${userId}`;
    if (this.told.has(key)) return;
    // Mode 0700/0600: the container's root reads it; its accounts can't.
    await writeAtomically(join(this.accountsDir!, user), `${userId}\n`, 0o700);
    this.told.add(key);
  }
}

async function writeAtomically(file: string, text: string, folderMode: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: folderMode });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}
