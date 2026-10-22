/** A server in Docker can't replace its own container, so it asks the compose file's updater service, which can. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse } from 'yaml';
import { APP, ServerUpdateJob, type ServerUpdateStatus } from '@atelier/protocol';

export interface ServerUpdatesOptions {
  /** The version this server runs. */
  version: string;
  /** The public update feed (`APP.updateFeed`); null turns the check off when there is no repository either. */
  feed: string | null;
  /** `owner/repo` whose GitHub releases name the newest version instead (ATELIER_UPDATES_REPO), with a token that can read them. */
  repo?: string | undefined;
  token?: string | undefined;
  /** The updater service (ATELIER_UPDATER_URL) and the file holding the secret it and this server share. */
  updater?: { url: string; secretFile: string } | undefined;
  /** The registry image this build was stamped with (ATELIER_IMAGE); empty for images built from source. */
  image?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

export class ServerUpdateError extends Error {
  constructor(
    readonly code: 'source_build' | 'no_updater' | 'updater_failed',
    message: string,
  ) {
    super(message);
  }
}

/** What the updater answers on `GET /status`. */
interface UpdaterStatus {
  services: { atelier?: { image: string; source: boolean } | null };
  job: ServerUpdateJob;
}

const CACHE_MS = 10 * 60_000;
/** A failed lookup is retried after this long, so an offline server doesn't ask on every page view. */
const RETRY_MS = 60_000;
const TIMEOUT_MS = 5_000;
export const MANUAL_UPDATE = 'docker compose pull && docker compose up -d';

export function serverUpdatesFromEnv(env: Record<string, string | undefined>): ServerUpdates {
  return new ServerUpdates({
    version: APP.version,
    feed: env.ATELIER_UPDATE_FEED === 'off' ? null : env.ATELIER_UPDATE_FEED || APP.updateFeed,
    repo: env.ATELIER_UPDATES_REPO,
    token: env.ATELIER_UPDATES_TOKEN,
    updater: env.ATELIER_UPDATER_URL ? { url: env.ATELIER_UPDATER_URL, secretFile: env.ATELIER_UPDATER_SECRET ?? '/updater/secret' } : undefined,
    image: env.ATELIER_IMAGE,
  });
}

export class ServerUpdates {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private latestCache: { version: string; checkedAt: number } | null = null;
  private latestError: { message: string; at: number } | null = null;
  private pending: Promise<void> | null = null;
  private secretValue: Promise<string> | null = null;

  constructor(private readonly options: ServerUpdatesOptions) {
    if (options.repo && !/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error(`ATELIER_UPDATES_REPO must be owner/repo, not "${options.repo}".`);
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async status(refresh = false): Promise<ServerUpdateStatus> {
    const [, updater] = await Promise.all([this.checkLatest(refresh), this.askUpdater()]);
    const stamped = !!this.options.image;
    const atelier = updater.ok ? updater.status.services.atelier : null;
    return {
      version: this.options.version,
      latest: this.latestCache,
      latestError: this.latestError?.message ?? null,
      install: updater.ok ? (atelier?.source ? 'source' : 'updater') : stamped ? 'manual' : 'source',
      image: atelier?.image ?? (this.options.image || null),
      updaterError: updater.ok ? null : updater.error,
      job: updater.ok ? updater.status.job : null,
    };
  }

  /** Starts the update; resolves once the updater accepted it (the server restarts a little later). */
  async update(): Promise<ServerUpdateStatus> {
    const before = await this.status();
    if (before.install === 'source') throw new ServerUpdateError('source_build', 'This server was built from source; update it by rebuilding its image.');
    const updater = this.options.updater;
    if (!updater) throw new ServerUpdateError('no_updater', `This server has no updater service. On its host, run: ${MANUAL_UPDATE}`);
    if (before.updaterError) throw new ServerUpdateError('updater_failed', before.updaterError);
    const answer = await this.call('POST', '/update');
    // 409: an update is already running, which is what was asked for.
    if (!answer.ok && answer.status !== 409) {
      const body = (await answer.json().catch(() => null)) as { error?: string } | null;
      throw new ServerUpdateError(answer.status === 422 ? 'source_build' : 'updater_failed', body?.error ?? `The updater answered ${answer.status}.`);
    }
    return this.status();
  }

  private async checkLatest(refresh: boolean): Promise<void> {
    const now = this.now();
    const fresh = this.latestCache && now - this.latestCache.checkedAt < CACHE_MS;
    const failedRecently = this.latestError && now - this.latestError.at < RETRY_MS;
    if (!refresh && (fresh || failedRecently)) return;
    this.pending ??= this.lookUp()
      .then((version) => {
        this.latestCache = { version, checkedAt: this.now() };
        this.latestError = null;
      })
      .catch((e: unknown) => {
        // The last version found stays: a server that went offline still knows what it saw.
        this.latestError = { message: `Couldn't check for a newer version: ${e instanceof Error ? e.message : String(e)}`, at: this.now() };
      })
      .finally(() => (this.pending = null));
    return this.pending;
  }

  private async lookUp(): Promise<string> {
    const { repo, token, feed } = this.options;
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    if (repo) {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': APP.name };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await this.request(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal });
      if (!r.ok) throw new Error(`GitHub answered ${r.status} for the releases of ${repo}.`);
      const tag = ((await r.json()) as { tag_name?: unknown }).tag_name;
      if (typeof tag !== 'string' || !tag) throw new Error(`The newest release of ${repo} has no tag.`);
      return tag.replace(/^v/, '');
    }
    if (!feed) throw new Error('No update feed is set.');
    const r = await this.request(`${feed.replace(/\/$/, '')}/stable/latest.yml`, { signal });
    if (!r.ok) throw new Error(`The update feed answered ${r.status}.`);
    const version = (parse(await r.text()) as { version?: unknown } | null)?.version;
    if (typeof version !== 'string' && typeof version !== 'number') throw new Error('The update feed names no version.');
    return String(version);
  }

  private async askUpdater(): Promise<{ ok: true; status: UpdaterStatus } | { ok: false; error: string | null }> {
    if (!this.options.updater) return { ok: false, error: null };
    try {
      const r = await this.call('GET', '/status');
      if (r.status === 401) return { ok: false, error: 'The updater refused this server’s secret: both must mount the same `updater-secret` volume.' };
      if (!r.ok) return { ok: false, error: `The updater answered ${r.status}.` };
      const body = (await r.json()) as UpdaterStatus;
      if (!body.services?.atelier) return { ok: false, error: 'The updater found no `atelier` service in its compose project.' };
      return { ok: true, status: { services: body.services, job: ServerUpdateJob.parse(body.job) } };
    } catch (e) {
      return { ok: false, error: `The updater can’t be reached at ${this.options.updater.url}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async call(method: 'GET' | 'POST', path: string): Promise<Response> {
    const { url } = this.options.updater!;
    return this.request(`${url.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.secret()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** Made by the server on first use, in the volume it shares with the updater (which only reads it). */
  private secret(): Promise<string> {
    const file = this.options.updater!.secretFile;
    this.secretValue ??= readFile(file, 'utf8')
      .then((s) => s.trim())
      .catch(async (e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
        const made = randomBytes(32).toString('base64url');
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `${made}\n`, { mode: 0o600, flag: 'wx' }).catch(async (w: NodeJS.ErrnoException) => {
          if (w.code !== 'EEXIST') throw w;
        });
        return (await readFile(file, 'utf8')).trim();
      });
    this.secretValue.catch(() => (this.secretValue = null));
    return this.secretValue;
  }
}
