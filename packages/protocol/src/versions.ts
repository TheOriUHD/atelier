/** Versions of Atelier: comparing them, and what an admin sees about the server's own version and updates. */
import { z } from 'zod';

/** Compares two semver versions (build metadata ignored): negative when `a` is older, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const plain = v.replace(/^v/, '').split('+')[0]!;
    const dash = plain.indexOf('-');
    return { core: (dash < 0 ? plain : plain.slice(0, dash)).split('.').map(Number), pre: dash < 0 ? [] : plain.slice(dash + 1).split('.') };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  // A release ranks above its own pre-releases.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** A run of the updater service: pull the images, then recreate the server and the sandbox. */
export const ServerUpdateJob = z.object({
  state: z.enum(['idle', 'pulling', 'restarting', 'done', 'failed']),
  /** Why it failed, or the last line the update printed. */
  message: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type ServerUpdateJob = z.infer<typeof ServerUpdateJob>;

/** Settings › Admin › Server; `install`: the updater service can do it, by hand (`manual`), or rebuild (`source`). */
export const ServerUpdateStatus = z.object({
  version: z.string(),
  latest: z.object({ version: z.string(), checkedAt: z.number() }).nullable(),
  /** Why the newest version is unknown right now (offline, feed down); the last known one stays in `latest`. */
  latestError: z.string().nullable(),
  install: z.enum(['updater', 'manual', 'source']),
  /** The image the server runs, when the updater could tell. */
  image: z.string().nullable(),
  /** Why the configured updater can't be used (unreachable, refused the secret). */
  updaterError: z.string().nullable(),
  job: ServerUpdateJob.nullable(),
});
export type ServerUpdateStatus = z.infer<typeof ServerUpdateStatus>;
