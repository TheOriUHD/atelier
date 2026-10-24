/**
 * What this computer lets each server it signs in to do here (ARCHITECTURE §21), beyond the folders trusted in
 * `trusted-folders.json`: make folders for sessions started without one, and reach SSH hosts with this computer's ssh.
 * Kept per server in `lending.json` (userData) and changed only from this computer's own windows; the device link reads
 * it on every request, so a server can't make this computer do more than the person allowed here.
 */
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { connectorFingerprintInput, DeviceLending, NO_LENDING } from '@atelier/protocol';

async function readAll(path: string): Promise<Record<string, unknown>> {
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return {};
  }
}

/** What `serverUrl` may do here; nothing beyond trusted folders when the file says nothing (or nothing readable). */
export async function readLending(path: string, serverUrl: string): Promise<DeviceLending> {
  const parsed = DeviceLending.partial().safeParse((await readAll(path))[serverUrl]);
  return { ...NO_LENDING, ...(parsed.success ? parsed.data : {}) };
}

let queue: Promise<unknown> = Promise.resolve();

/** Changes what `serverUrl` may do here (one change at a time, written whole); returns what it may do now. */
export function changeLending(path: string, serverUrl: string, change: (current: DeviceLending) => DeviceLending): Promise<DeviceLending> {
  const run = queue.then(async () => {
    const all = await readAll(path);
    const next = DeviceLending.parse(change(await readLending(path, serverUrl)));
    all[serverUrl] = next;
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** The changes a window can ask for. A connector is allowed by what runs (its fingerprint), taken back by id. */
export const LendingChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scratch'), allowed: z.boolean() }),
  z.object({ kind: z.literal('ssh'), host: z.string().min(1).max(255), allowed: z.boolean() }),
  z.object({
    kind: z.literal('connector'),
    id: z.string().min(1).max(64),
    name: z.string().max(80).default(''),
    command: z.string().max(4096).optional(),
    args: z.array(z.string().max(8192)).max(200).default([]),
    envKeys: z.array(z.string().max(200)).max(200).default([]),
    allowed: z.boolean(),
  }),
  z.object({ kind: z.literal('http'), id: z.string().min(1).max(64), baseUrl: z.url().max(2048).optional(), allowed: z.boolean() }),
  z.object({ kind: z.literal('chatgptChat'), allowed: z.boolean() }),
  z.object({ kind: z.literal('home'), allowed: z.boolean() }),
]);
export type LendingChange = z.infer<typeof LendingChange>;

/** What a personal connector's fingerprint is: sha256 of its program, arguments and environment names. */
export const connectorFingerprint = (command: string, args: readonly string[], envKeys: readonly string[]) =>
  createHash('sha256').update(connectorFingerprintInput(command, args, envKeys)).digest('hex');

/** Applies a window's change to what a server may do. */
export function applyLending(current: DeviceLending, change: LendingChange): DeviceLending {
  switch (change.kind) {
    case 'scratch':
      return { ...current, scratch: change.allowed };
    case 'chatgptChat':
      return { ...current, chatgptChat: change.allowed };
    case 'home':
      return { ...current, home: change.allowed };
    case 'ssh': {
      const ssh = current.ssh.filter((h) => h !== change.host);
      return { ...current, ssh: change.allowed ? [...ssh, change.host] : ssh };
    }
    case 'connector': {
      const connectors = current.connectors.filter((c) => c.id !== change.id);
      if (!change.allowed) return { ...current, connectors };
      if (!change.command) throw new Error('A connector is allowed by the program it runs.');
      return { ...current, connectors: [...connectors, { id: change.id, name: change.name, fingerprint: connectorFingerprint(change.command, change.args, change.envKeys) }] };
    }
    case 'http': {
      const http = current.http.filter((a) => a.id !== change.id);
      if (!change.allowed) return { ...current, http };
      if (!change.baseUrl) throw new Error('An address is allowed by its URL.');
      return { ...current, http: [...http, { id: change.id, baseUrl: change.baseUrl }] };
    }
  }
}
