/**
 * The terminal app's own settings (`config.json`): where it connects, how it looks, and conveniences of this computer.
 * Model, effort and permission rules are the backend's (the server's for a connected terminal); a model chosen here is
 * this terminal's own choice over the account's default.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { PermissionMode } from '@atelier/protocol';

export const Theme = z.enum(['auto', 'dark', 'light', 'plain']);
export type Theme = z.infer<typeof Theme>;

export const Connection = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local') }),
  z.object({ mode: z.literal('server'), serverUrl: z.string().url(), username: z.string().optional() }),
]);
export type Connection = z.infer<typeof Connection>;

export const CliConfig = z.object({
  /** Absent until setup ran. */
  connection: Connection.optional(),
  theme: Theme.default('auto'),
  /** Notify when a reply ends or needs you while the terminal is in the background. */
  notifications: z.boolean().default(true),
  /** The model for this terminal's new sessions (`provider/model`); absent: the account's default for Code. */
  model: z.string().optional(),
  effort: z.string().optional(),
  /** The mode new sessions start in; absent: the backend's default (Auto). */
  permissionMode: PermissionMode.optional(),
  /** normal, thinking or verbose: what the transcript shows of each turn (Ctrl+O cycles it). */
  transcriptView: z.enum(['normal', 'thinking', 'verbose']).default('normal'),
  /** A command whose first line of output is the status line; it gets a JSON description of the session on stdin. */
  statusLine: z.object({ command: z.string().min(1), padding: z.number().int().min(0).max(8).optional() }).optional(),
  /** Server mode: the background service keeps lending this computer with no terminal open (a login service). */
  keepAvailable: z.boolean().default(false),
  /** The animated mascot and banner (off: still pictures). */
  motion: z.boolean().default(true),
  /** The editor Ctrl+G opens; absent: $VISUAL, $EDITOR, then a sensible default. */
  editor: z.string().optional(),
  /** Stable or beta updates. */
  channel: z.enum(['stable', 'beta']).default('stable'),
  /** When the last update check ran. */
  checkedForUpdatesAt: z.number().optional(),
  /** Tips shown so far (one per start, in order). */
  tipIndex: z.number().int().min(0).default(0),
});
export type CliConfig = z.infer<typeof CliConfig>;

export async function readConfig(file: string): Promise<CliConfig> {
  try {
    const parsed = CliConfig.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or unreadable: start over.
  }
  return CliConfig.parse({});
}

/** Writes atomically (a rename), readable by this user only. */
export async function writeConfig(file: string, config: CliConfig): Promise<void> {
  await writePrivate(file, `${JSON.stringify(config, null, 2)}\n`);
}

export async function updateConfig(file: string, change: (c: CliConfig) => CliConfig): Promise<CliConfig> {
  const next = CliConfig.parse(change(await readConfig(file)));
  await writeConfig(file, next);
  return next;
}

export async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
}

export async function readJson<T>(file: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}
