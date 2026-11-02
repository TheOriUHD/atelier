/**
 * The admin activity log of a shared server (ARCHITECTURE §21): an append-only record of who changed what. The
 * backend writes it; admins read and export it in Settings › Admin › Activity.
 */
import { z } from 'zod';

/**
 * Everything the log records. A kind is `<category>.<what happened>`; the category is what the page filters by. A
 * newer server may write kinds an older page doesn't know, so events carry `kind` as a plain string and the page
 * falls back to showing it as is.
 */
export const AUDIT_KINDS = [
  'signin.success',
  'signin.failed',
  'signin.blocked',
  'account.created',
  'account.updated',
  'account.role_changed',
  'account.disabled',
  'account.enabled',
  'account.deleted',
  'account.password_reset',
  'invite.created',
  'invite.revoked',
  'invite.used',
  'identity.saved',
  'identity.removed',
  'settings.changed',
  'settings.reset',
  'settings.instructions',
  'provider.added',
  'provider.changed',
  'provider.removed',
  'provider.connected',
  'provider.disconnected',
  'secret.created',
  'secret.rotated',
  'secret.deleted',
  'connector.added',
  'connector.changed',
  'connector.removed',
  'connector.signed_in',
  'connector.signed_out',
  'plugin.installed',
  'plugin.removed',
  'plugin.enabled',
  'plugin.disabled',
  'plugin.changed',
  'skill.installed',
  'skill.removed',
  'model.hidden',
  'model.unhidden',
  'model.changed',
  'limits.changed',
  'server.update_started',
  'audit.exported',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** The part of a kind before the dot. */
export function auditCategory(kind: string): string {
  const dot = kind.indexOf('.');
  return dot < 0 ? kind : kind.slice(0, dot);
}

export const AUDIT_CATEGORIES = [...new Set(AUDIT_KINDS.map(auditCategory))] as readonly string[];

/** What the page calls each category. */
export const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  signin: 'Sign-ins',
  account: 'Accounts',
  invite: 'Invites',
  identity: 'Single sign-on',
  settings: 'Settings',
  provider: 'Providers',
  secret: 'Keys and secrets',
  connector: 'Connectors',
  plugin: 'Plugins',
  skill: 'Skills',
  model: 'Models',
  limits: 'Limits',
  server: 'Server',
  audit: 'This log',
};

/** The values an event may carry besides its summary: short, flat, and never a secret. */
export const AuditDetail = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type AuditDetail = z.infer<typeof AuditDetail>;

export const AuditEvent = z.object({
  id: z.string(),
  at: z.number(),
  kind: z.string(),
  /** The account that did it, when it still exists or did when this was written. */
  actorId: z.string().nullable(),
  /** Their username as it was then (accounts get deleted; the log stays). For a failed sign-in, the name that was tried. */
  actor: z.string().nullable(),
  /** What it was done to: a username, a provider or secret id, a settings path. Never a secret's value. */
  target: z.string().nullable(),
  summary: z.string(),
  detail: AuditDetail.nullable(),
  /** The address as the server saw it (the proxy's forwarded address when the proxy is trusted). */
  ip: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const RETENTION_DAYS = { min: 7, max: 365, default: 90 } as const;

export const AuditFilter = z.object({
  /** A category (`account`) or one kind (`account.deleted`). */
  kind: z.string().max(60).optional(),
  /** A username: events by them or about them. */
  user: z.string().max(80).optional(),
  from: z.number().optional(),
  to: z.number().optional(),
});
export type AuditFilter = z.infer<typeof AuditFilter>;

export const AuditPage = z.object({
  events: z.array(AuditEvent),
  /** Pass as `cursor` for the next, older page; null at the end. */
  next: z.string().nullable(),
  retentionDays: z.number(),
});
export type AuditPage = z.infer<typeof AuditPage>;

export const AuditExport = z.object({
  exportedAt: z.number(),
  retentionDays: z.number(),
  /** More events matched than the export holds (the newest are in). */
  truncated: z.boolean(),
  events: z.array(AuditEvent),
});
export type AuditExport = z.infer<typeof AuditExport>;

/** The most events one export holds. */
export const AUDIT_EXPORT_MAX = 50_000;
