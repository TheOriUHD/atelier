/**
 * GitHub Codespaces (ARCHITECTURE §9-C) through the REST API with the person's GitHub token. A codespace
 * becomes a workspace: its runner is reached with `gh codespace ssh`, like an SSH host.
 */
import type { CodespaceMachine, CodespaceSummary, GitHubRepo } from '@atelier/protocol';
import type { RemoteShell } from '../workspaces/ssh.ts';
import { GitHubError, type GitHub } from './github.ts';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const READY_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 1000;
/** GitHub's longest idle timeout: a codespace Atelier makes stays on as long as it allows while nothing happens. */
const MAX_IDLE_MINUTES = 240;
/** Repositories listed for the picker, newest push first (100 per page). */
const REPO_PAGES = 5;
/** States a codespace can't be used from: it is gone or broken, so a new one is made. */
const UNUSABLE = new Set(['Deleted', 'Failed', 'Unavailable', 'Archived']);

interface ApiCodespace {
  name: string;
  display_name?: string | null;
  state: string;
  repository: { full_name: string; name: string };
  machine?: { display_name?: string } | null;
  idle_timeout_minutes?: number | null;
  last_used_at?: string | null;
}

export class Codespaces {
  constructor(private readonly deps: { fetch: Fetch; github: GitHub; gh?: string; sleep?: (ms: number) => Promise<void> }) {}

  async list(userId: string): Promise<CodespaceSummary[]> {
    const { codespaces } = (await this.api(userId, '/user/codespaces?per_page=100')) as { codespaces: ApiCodespace[] };
    return codespaces.map(summary);
  }

  async machines(userId: string, repo: string, ref?: string): Promise<CodespaceMachine[]> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const { machines } = (await this.api(userId, `/repos/${repo}/codespaces/machines${query}`)) as { machines: { name: string; display_name: string; cpus: number; memory_in_bytes: number }[] };
    return machines.map((m) => ({ name: m.name, displayName: m.display_name, cpus: m.cpus, memoryBytes: m.memory_in_bytes }));
  }

  /** The repositories the person can open, most recently pushed first (their own, collaborations and organizations'). */
  async repos(userId: string): Promise<GitHubRepo[]> {
    const found: GitHubRepo[] = [];
    for (let page = 1; page <= REPO_PAGES; page++) {
      const batch = (await this.api(userId, `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`)) as unknown;
      const list = Array.isArray(batch) ? (batch as { full_name: string; private: boolean; default_branch: string; pushed_at?: string | null; archived?: boolean }[]) : [];
      found.push(...list.filter((r) => !r.archived).map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : null })));
      if (list.length < 100) break;
    }
    return found;
  }

  /**
   * What "work in this repository" needs, done for the person: the repository's codespace when it has one (woken if it
   * went to sleep), otherwise a new one on the largest machine the account can use, set to stay on as long as GitHub
   * allows while idle. Resolves once it is available.
   */
  async open(userId: string, input: { repo: string; ref?: string }): Promise<CodespaceSummary> {
    const mine = (await this.list(userId))
      .filter((c) => c.repo.toLowerCase() === input.repo.toLowerCase() && !UNUSABLE.has(c.state))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    if (mine[0]) return this.wake(userId, mine[0].name);
    const machines = await this.machines(userId, input.repo, input.ref).catch(() => []);
    const best = [...machines].sort((a, b) => b.cpus - a.cpus || b.memoryBytes - a.memoryBytes)[0];
    return this.create(userId, { repo: input.repo, ...(input.ref ? { ref: input.ref } : {}), ...(best ? { machine: best.name } : {}), idleTimeoutMinutes: MAX_IDLE_MINUTES });
  }

  /** Creates a codespace and waits (up to three minutes) until it is available. */
  async create(userId: string, input: { repo: string; ref?: string; machine?: string; idleTimeoutMinutes?: number }): Promise<CodespaceSummary> {
    const created = (await this.api(userId, `/repos/${input.repo}/codespaces`, {
      method: 'POST',
      body: JSON.stringify({ ...(input.ref ? { ref: input.ref } : {}), ...(input.machine ? { machine: input.machine } : {}), ...(input.idleTimeoutMinutes ? { idle_timeout_minutes: input.idleTimeoutMinutes } : {}) }),
    })) as ApiCodespace;
    return summary(await this.ready(userId, created));
  }

  /**
   * Makes sure the codespace is running: one that went to sleep (its idle timeout ran out) is started, one that is
   * still coming up or going down is waited for. Up to three minutes; throws when it can't be started.
   */
  async wake(userId: string, name: string, onWaking?: () => void): Promise<CodespaceSummary> {
    const current = (await this.api(userId, `/user/codespaces/${encodeURIComponent(name)}`)) as ApiCodespace;
    // Told once, and only when it isn't running: a running one costs the caller one lookup and no flicker.
    if (current.state !== 'Available') onWaking?.();
    return summary(await this.ready(userId, current));
  }

  /** Polls until `current` is available, starting it once it has shut down. */
  private async ready(userId: string, first: ApiCodespace): Promise<ApiCodespace> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let current = first;
    let started = false;
    while (current.state !== 'Available') {
      if (['Failed', 'Deleted', 'Unavailable'].includes(current.state)) throw new GitHubError(`${current.name} couldn't start (${current.state}).`);
      if (Date.now() > deadline) throw new GitHubError(`${current.name} isn't available after three minutes (it is ${current.state}).`);
      if (current.state === 'Shutdown' && !started) {
        started = true;
        await this.start(userId, current.name);
      } else {
        await sleep(POLL_MS);
      }
      current = (await this.api(userId, `/user/codespaces/${encodeURIComponent(current.name)}`)) as ApiCodespace;
    }
    return current;
  }

  async start(userId: string, name: string): Promise<void> {
    await this.api(userId, `/user/codespaces/${encodeURIComponent(name)}/start`, { method: 'POST' });
  }

  async stop(userId: string, name: string): Promise<void> {
    await this.api(userId, `/user/codespaces/${encodeURIComponent(name)}/stop`, { method: 'POST' });
  }

  async remove(userId: string, name: string): Promise<void> {
    await this.api(userId, `/user/codespaces/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  /** `gh codespace ssh` into it, signed in with the person's token. The codespace needs sshd (the default image has it). */
  async shell(userId: string, name: string): Promise<RemoteShell> {
    const token = await this.deps.github.token(userId);
    if (!token) throw new GitHubError('Connect GitHub first.');
    // gh starts the codespace's tunnel on each connection, which takes a while right after a wake.
    return { command: this.deps.gh ?? 'gh', args: ['codespace', 'ssh', '-c', name, '--'], env: { GH_TOKEN: token, GH_PROMPT_DISABLED: '1' }, label: name, timeoutMs: 90_000 };
  }

  private async api(userId: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.deps.github.token(userId);
    if (!token) throw new GitHubError('Connect GitHub first.');
    const res = await this.deps.fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    });
    if (res.status === 204 || res.status === 202) return {};
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new GitHubError(res.status === 401 ? 'GitHub no longer accepts the saved token. Connect again.' : (data.message ?? `GitHub answered ${res.status}.`));
    return data;
  }
}

function summary(c: ApiCodespace): CodespaceSummary {
  return {
    name: c.name,
    displayName: c.display_name || c.name,
    repo: c.repository.full_name,
    state: c.state,
    machine: c.machine?.display_name ?? null,
    idleTimeoutMinutes: c.idle_timeout_minutes ?? null,
    lastUsedAt: c.last_used_at ? Date.parse(c.last_used_at) : null,
    // The default working directory of a codespace.
    root: `/workspaces/${c.repository.name}`,
  };
}
