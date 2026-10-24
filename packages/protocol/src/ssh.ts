/** SSH connections Atelier manages itself (desktop): their own list, not ~/.ssh/config's; prompts for host keys and passwords. */
import { z } from 'zod';

/** What `ssh` is given as the destination: `user@host` or a Host from ~/.ssh/config. Never starts with `-`. */
export const SshHost = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\w.@:+-]+$/, 'Use user@hostname or a host from ~/.ssh/config.')
  .refine((h) => !h.startsWith('-'), 'Use user@hostname or a host from ~/.ssh/config.');

export const SshConnectionInput = z.object({
  /** A friendly name for the connection. */
  name: z.string().trim().min(1, 'Give the connection a name.').max(80),
  host: SshHost,
  /** Empty: ssh's default (22) or the port from ~/.ssh/config. */
  port: z.number().int().min(1).max(65535).nullable().default(null),
  /** A private key to offer in addition to the ssh config's and the agent's; empty: just those. */
  keyPath: z.string().trim().max(1024).nullable().default(null),
  /** Where new sessions start on this host (`~/` is its home folder); empty: its home folder. */
  folder: z.string().trim().max(1024).nullable().default(null),
});
export type SshConnectionInput = z.infer<typeof SshConnectionInput>;

export const SshConnection = SshConnectionInput.extend({ id: z.string() });
export type SshConnection = z.infer<typeof SshConnection>;

/** A connection as the settings and menus show it. */
export const SshConnectionView = SshConnection.extend({ passwordSaved: z.boolean() });
export type SshConnectionView = z.infer<typeof SshConnectionView>;

/** Something a connection needs from the person before it can go on. */
export const SshPrompt = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('hostkey'),
    /** The connection's name (or its host). */
    connection: z.string(),
    host: z.string(),
    keyType: z.string(),
    fingerprint: z.string(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('password'),
    connection: z.string(),
    host: z.string(),
    /** What ssh asked: "alice@host's password:", "Enter passphrase for key …", a verification code's prompt. */
    prompt: z.string(),
    /** A password was tried before and refused. */
    retry: z.boolean(),
    /** Whether the answer can be kept (a password or passphrase, not a one-time code). */
    canSave: z.boolean(),
  }),
]);
export type SshPrompt = z.infer<typeof SshPrompt>;

export const SshAnswer = z.object({
  id: z.string(),
  /** Host key: trust it (it is then recorded in known_hosts). */
  accept: z.boolean().optional(),
  password: z.string().max(1024).optional(),
  /** Keep the password (encrypted) for this connection. */
  save: z.boolean().optional(),
});
export type SshAnswer = z.infer<typeof SshAnswer>;

export const SshTestResult = z.object({ ok: z.boolean(), message: z.string() });
export type SshTestResult = z.infer<typeof SshTestResult>;
