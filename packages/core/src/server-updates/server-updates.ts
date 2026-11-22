/** A server in Docker can't replace its own container, so it asks the compose file's updater service, which can. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse } from 'yaml';
import { APP, compareVersions, ServerUpdateJob, type ServerUpdateStatus, type UpdateChannel } from '@atelier/protocol';

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
  /** Which versions it looks for (Settings › Admin › Server › Update channel), read on every check; stable without it. */
  channel?: () => UpdateChannel;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Updates the updater to the compose file's own tag (`:latest`), which is a release's. */
export const UPDATE_UPDATER = 'docker compose pull updater && docker compose up -d updater';

/**
 * The one command that puts in an updater able to install betas (0.10.7 and later), where an older one runs. A beta's
 * images have only their version's tag, so before a release has it, `:latest` is too old as well: the command fetches the
 * beta's own updater and gives it the name the compose file runs. From then on every update brings the updater along.
 */
export function updaterUpdateCommand(image: string | null | undefined, target: string | null): string {
  if (!target?.includes('-')) return UPDATE_UPDATER;
  const updater = `${image || 'ghcr.io/theoriuhd/atelier'}-updater`;
  return `docker pull ${updater}:v${target} && docker tag ${updater}:v${target} ${updater}:latest && docker compose up -d updater`;
}

/** Why an updater from before 0.10.7 can't install a beta, and the one command that fixes it. */
export const betaNeedsNewUpdater = (command: string): string =>
  `This server’s updater is too old to install betas, which have only their own version’s image. Update it once: on the server’s host, in the folder with compose.yaml, run ${command}`;

export class ServerUpdateError extends Error {
  constructor(
    readonly code: 'source_build' | 'no_updater' | 'updater_failed' | 'updater_old',
    message: string,
  ) {
    super(message);
  }
}

/** What the updater answers on `GET /status`. */
interface UpdaterStatus {
  services: { atelier?: { image: string; source: boolean } | null };
  job: ServerUpdateJob;
  /** What the updater can do beyond pulling and restarting in one go ('pull': download ahead, install later); absent before 0.10.6. */
  features?: string[];
}

/** The tag a GitHub release names, without its `v`, or null for a draft or a name that isn't a version. */
const releaseVersion = (release: { tag_name?: unknown; draft?: unknown }): string | null =>
  !release.draft && typeof release.tag_name === 'string' && /^v?\d+\.\d+\.\d+(-[\w.]+)?$/.test(release.tag_name) ? release.tag_name.replace(/^v/, '') : null;

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
  private latestCache: { version: string; checkedAt: number; channel: UpdateChannel } | null = null;
  private latestError: { message: string; at: number } | null = null;
  private pending: { channel: UpdateChannel; done: Promise<void> } | null = null;
  private secretValue: Promise<string> | null = null;

  constructor(private readonly options: ServerUpdatesOptions) {
    if (options.repo && !/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error(`ATELIER_UPDATES_REPO must be owner/repo, not "${options.repo}".`);
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** The version this server runs. */
  get version(): string {
    return this.options.version;
  }

  /** The channel it looks in right now. */
  get channel(): UpdateChannel {
    return this.options.channel?.() ?? 'stable';
  }

  /** Reads the channel from the settings (the backend's). */
  useChannel(channel: () => UpdateChannel): void {
    this.options.channel = channel;
  }

  /**
   * The exact version the updater is asked to install, or null for the compose file's own tags. On the beta channel it
   * is always the version found (a beta has no `:latest`); on stable the tags stay as they are, as before 0.10.7.
   */
  exactVersion(target: string | null): string | null {
    return this.channel === 'beta' ? target : null;
  }

  /** The command that updates an updater too old for `target` (see updaterUpdateCommand). */
  updaterUpdate(target: string | null): string {
    return updaterUpdateCommand(this.options.image, target);
  }

  async status(refresh = false): Promise<ServerUpdateStatus> {
    const [, updater] = await Promise.all([this.checkLatest(refresh), this.askUpdater()]);
    const stamped = !!this.options.image;
    const atelier = updater.ok ? updater.status.services.atelier : null;
    const latest = this.latestCache?.channel === this.channel ? this.latestCache : null;
    return {
      version: this.options.version,
      latest: latest && { version: latest.version, checkedAt: latest.checkedAt },
      latestError: this.latestError?.message ?? null,
      install: updater.ok ? (atelier?.source ? 'source' : 'updater') : stamped ? 'manual' : 'source',
      image: atelier?.image ?? (this.options.image || null),
      updaterError: updater.ok ? null : updater.error,
      job: updater.ok ? updater.status.job : null,
      channel: this.channel,
      exactVersions: updater.ok ? (updater.status.features?.includes('version') ?? false) : null,
      updaterUpdate: this.updaterUpdate(latest?.version ?? null),
    };
  }

  /** Starts the update; resolves once the updater accepted it (the server restarts a little later). */
  async update(): Promise<ServerUpdateStatus> {
    const before = await this.status();
    if (before.install === 'source') throw new ServerUpdateError('source_build', 'This server was built from source; update it by rebuilding its image.');
    const updater = this.options.updater;
    if (!updater) throw new ServerUpdateError('no_updater', `This server has no updater service. On its host, run: ${MANUAL_UPDATE}`);
    if (before.updaterError) throw new ServerUpdateError('updater_failed', before.updaterError);
    const exact = this.exactVersion(before.latest?.version ?? null);
    if (exact && !before.exactVersions) throw new ServerUpdateError('updater_old', betaNeedsNewUpdater(this.updaterUpdate(exact)));
    const answer = await this.call('POST', exact ? `/update?version=${encodeURIComponent(exact)}` : '/update');
    // 409: an update is already running, which is what was asked for.
    if (!answer.ok && answer.status !== 409) {
      const body = (await answer.json().catch(() => null)) as { error?: string } | null;
      throw new ServerUpdateError(answer.status === 422 ? 'source_build' : 'updater_failed', body?.error ?? `The updater answered ${answer.status}.`);
    }
    return this.status();
  }

  /** The newest version the feed names right now (a fresh lookup), or null when it can't be read. */
  async refreshLatest(): Promise<string | null> {
    await this.checkLatest(true);
    return this.latestCache?.version ?? null;
  }

  /** What the updater says (its job, whether it downloads ahead and installs exact versions), without looking for a new version. */
  async updaterState(): Promise<{ ok: true; job: ServerUpdateJob; downloadsAhead: boolean; exactVersions: boolean; source: boolean } | { ok: false; error: string | null }> {
    const answer = await this.askUpdater();
    if (!answer.ok) return answer;
    const features = answer.status.features ?? [];
    return { ok: true, job: answer.status.job, downloadsAhead: features.includes('pull'), exactVersions: features.includes('version'), source: !!answer.status.services.atelier?.source };
  }

  /**
   * Has the updater download the new images without installing them (`version`: that version's). `unsupported`: an
   * updater from before 0.10.6.
   */
  async pull(version: string | null = null): Promise<'started' | 'running' | 'unsupported'> {
    const answer = await this.call('POST', version ? `/pull?version=${encodeURIComponent(version)}` : '/pull');
    if (answer.status === 404) return 'unsupported';
    if (answer.status === 409) return 'running';
    if (!answer.ok) {
      const body = (await answer.json().catch(() => null)) as { error?: string } | null;
      throw new ServerUpdateError('updater_failed', body?.error ?? `The updater answered ${answer.status}.`);
    }
    return 'started';
  }

  /** Has the updater recreate the server from the images it downloaded (`pulled`), or download and recreate in one go. */
  async install(pulled: boolean, version: string | null = null): Promise<void> {
    const query = [...(pulled ? ['pull=false'] : []), ...(version ? [`version=${encodeURIComponent(version)}`] : [])];
    const answer = await this.call('POST', `/update${query.length ? `?${query.join('&')}` : ''}`);
    // 409: an update is already running, which is what was asked for.
    if (!answer.ok && answer.status !== 409) {
      const body = (await answer.json().catch(() => null)) as { error?: string } | null;
      throw new ServerUpdateError(answer.status === 422 ? 'source_build' : 'updater_failed', body?.error ?? `The updater answered ${answer.status}.`);
    }
  }

  private async checkLatest(refresh: boolean): Promise<void> {
    const now = this.now();
    const channel = this.channel;
    const sameChannel = this.latestCache?.channel === channel;
    const fresh = sameChannel && this.latestCache && now - this.latestCache.checkedAt < CACHE_MS;
    const failedRecently = sameChannel && this.latestError && now - this.latestError.at < RETRY_MS;
    if (!refresh && (fresh || failedRecently)) return;
    // A lookup of the other channel under way doesn't answer for this one.
    if (this.pending && this.pending.channel !== channel) await this.pending.done;
    this.pending ??= {
      channel,
      done: this.lookUp(channel)
        .then((version) => {
          this.latestCache = { version, checkedAt: this.now(), channel };
          this.latestError = null;
        })
        .catch((e: unknown) => {
          // The last version found stays: a server that went offline still knows what it saw.
          this.latestError = { message: `Couldn't check for a newer version: ${e instanceof Error ? e.message : String(e)}`, at: this.now() };
        })
        .finally(() => (this.pending = null)),
    };
    return this.pending.done;
  }

  /** The newest version of the channel: stable's, or on beta the newer of the newest beta and the newest release. */
  private async lookUp(channel: UpdateChannel): Promise<string> {
    const { repo, token, feed } = this.options;
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    if (repo) {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': APP.name };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (channel === 'beta') {
        const r = await this.request(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers, signal });
        if (!r.ok) throw new Error(`GitHub answered ${r.status} for the releases of ${repo}.`);
        const versions = ((await r.json()) as { tag_name?: unknown; draft?: unknown }[]).map(releaseVersion).filter((v): v is string => v !== null);
        if (!versions.length) throw new Error(`${repo} has no releases.`);
        return versions.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
      }
      const r = await this.request(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal });
      if (!r.ok) throw new Error(`GitHub answered ${r.status} for the releases of ${repo}.`);
      const tag = ((await r.json()) as { tag_name?: unknown }).tag_name;
      if (typeof tag !== 'string' || !tag) throw new Error(`The newest release of ${repo} has no tag.`);
      return tag.replace(/^v/, '');
    }
    if (!feed) throw new Error('No update feed is set.');
    const base = feed.replace(/\/$/, '');
    const read = async (name: UpdateChannel): Promise<string> => {
      const r = await this.request(`${base}/${name}/latest.yml`, { signal });
      if (!r.ok) throw new Error(`The update feed answered ${r.status}.`);
      const version = (parse(await r.text()) as { version?: unknown } | null)?.version;
      if (typeof version !== 'string' && typeof version !== 'number') throw new Error('The update feed names no version.');
      return String(version);
    };
    if (channel === 'stable') return read('stable');
    // A release newer than the last beta (0.10.7 after 0.10.7-beta.6) is the beta channel's newest too.
    const [stable, beta] = await Promise.allSettled([read('stable'), read('beta')]);
    const found = [stable, beta].flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (!found.length) throw (beta as PromiseRejectedResult).reason;
    return found.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
  }

  private async askUpdater(): Promise<{ ok: true; status: UpdaterStatus } | { ok: false; error: string | null }> {
    if (!this.options.updater) return { ok: false, error: null };
    try {
      const r = await this.call('GET', '/status');
      if (r.status === 401) return { ok: false, error: 'The updater refused this server’s secret: both must mount the same `updater-secret` volume.' };
      if (!r.ok) return { ok: false, error: `The updater answered ${r.status}.` };
      const body = (await r.json()) as UpdaterStatus;
      if (!body.services?.atelier) return { ok: false, error: 'The updater found no `atelier` service in its compose project.' };
      return { ok: true, status: { services: body.services, job: ServerUpdateJob.parse(body.job), features: Array.isArray(body.features) ? body.features.filter((f): f is string => typeof f === 'string') : [] } };
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
