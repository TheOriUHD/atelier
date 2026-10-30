/**
 * Encrypted secret storage. Plaintext only exists transiently inside the backend: it is never sent to
 * the UI (only a masked tail), never logged and never placed into prompts.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { SecretSummary } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { secrets } from '../store/schema.ts';

export interface Cipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/** AES-256-GCM with a 32-byte key (server: ATELIER_SECRET_KEY or a 0600 key file). */
export class AesGcmCipher implements Cipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Secret key must be 32 bytes');
  }

  async encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  async decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith('v1:')) throw new Error('Unknown secret format');
    const raw = Buffer.from(ciphertext.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/** Reads the key from `envValue` (base64/hex, 32 bytes) or a key file, creating the file if needed. */
export async function loadServerKey(keyFile: string, envValue?: string): Promise<Buffer> {
  if (envValue) {
    const key = /^[0-9a-f]{64}$/i.test(envValue) ? Buffer.from(envValue, 'hex') : Buffer.from(envValue, 'base64');
    if (key.length !== 32) throw new Error('ATELIER_SECRET_KEY must encode 32 bytes (hex or base64)');
    return key;
  }
  try {
    return Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'base64');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const key = randomBytes(32);
    await mkdir(dirname(keyFile), { recursive: true });
    await writeFile(keyFile, key.toString('base64'), { mode: 0o600 });
    await chmod(keyFile, 0o600);
    return key;
  }
}

/** An id for a secret from its label; never one that reads as a person's own (`github-user-…`), which would hide it. */
export function slugId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'secret';
  return isPersonalSecret(slug) ? `secret-${slug}`.slice(0, 48) : slug;
}

/**
 * Secrets that belong to one person (`<kind>-user-<user id>-…`): their GitHub token, SSH passwords, personal connectors'
 * and model providers' keys. Never listed for admins, never reachable from settings (`forSettings`); `forUser` gives
 * them to their owner's own things only.
 */
const PERSONAL_KINDS = ['github', 'ssh', 'connector', 'mcp-oauth', 'provider'] as const;
export const isPersonalSecret = (id: string) => PERSONAL_KINDS.some((kind) => id.startsWith(`${kind}-user-`));
/** Whether a personal secret is `userId`'s: its id names them right after the kind. */
export const personalSecretOf = (id: string, userId: string) => PERSONAL_KINDS.some((kind) => id.startsWith(`${kind}-user-${userId}-`));

export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}

  async list(usedBy: (id: string) => string[]): Promise<SecretSummary[]> {
    const rows = await this.db.select().from(secrets).all();
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      masked: `••••${r.tail}`,
      usedBy: usedBy(r.id),
      createdAt: r.createdAt,
      rotatedAt: r.rotatedAt,
      lastUsedAt: r.lastUsedAt,
    }));
  }

  /** Decrypts a secret for immediate use and records the access time. */
  async get(id: string): Promise<string | undefined> {
    const row = await this.db.select().from(secrets).where(eq(secrets.id, id)).get();
    if (!row) return undefined;
    await this.db.update(secrets).set({ lastUsedAt: Date.now() }).where(eq(secrets.id, id));
    return this.cipher.decrypt(row.ciphertext);
  }

  /** A personal secret, for its owner's own things (their connectors and providers); nothing for anyone else's. */
  forUser(userId: string, id: string): Promise<string | undefined> {
    return personalSecretOf(id, userId) ? this.get(id) : Promise.resolve(undefined);
  }

  /** Resolves a `${secret:<id>}` written in settings. A person's own secrets never resolve there, whoever wrote the setting. */
  forSettings(id: string): Promise<string | undefined> {
    return isPersonalSecret(id) ? Promise.resolve(undefined) : this.get(id);
  }

  async has(id: string): Promise<boolean> {
    return Boolean(await this.db.select({ id: secrets.id }).from(secrets).where(eq(secrets.id, id)).get());
  }

  /** The last four characters, to show a stored secret masked; undefined when there is none. */
  async tail(id: string): Promise<string | undefined> {
    return (await this.db.select({ tail: secrets.tail }).from(secrets).where(eq(secrets.id, id)).get())?.tail;
  }

  /** Creates or rotates a secret; returns its id. */
  async set(input: { id?: string; label: string; kind: SecretSummary['kind']; value: string }): Promise<string> {
    const id = input.id ?? (await this.freeId(slugId(input.label)));
    const now = Date.now();
    const ciphertext = await this.cipher.encrypt(input.value);
    const tail = input.value.slice(-4);
    const existing = await this.db.select({ id: secrets.id }).from(secrets).where(eq(secrets.id, id)).get();
    if (existing) {
      await this.db.update(secrets).set({ ciphertext, tail, label: input.label, kind: input.kind, rotatedAt: now }).where(eq(secrets.id, id));
    } else {
      await this.db.insert(secrets).values({ id, label: input.label, kind: input.kind, ciphertext, tail, createdAt: now });
    }
    return id;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(secrets).where(eq(secrets.id, id));
  }

  private async freeId(base: string): Promise<string> {
    let id = base;
    for (let n = 2; await this.has(id); n++) id = `${base}-${n}`;
    return id;
  }
}
