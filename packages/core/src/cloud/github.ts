/**
 * A person's GitHub connection (ARCHITECTURE §9-C): a token from GitHub's device flow (an OAuth app the admin
 * registers; its client id is in Settings) or a pasted token. It is kept in the secret store as the
 * person's own (never listed for admins) and used for Codespaces.
 */
import type { SecretStore } from '../secrets/secret-store.ts';
import { newId } from '../util/ids.ts';

export class GitHubError extends Error {}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const SCOPES = 'codespace repo';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** The secret id holding a person's token; `isPersonalSecret` keeps it from admins and settings. */
export const githubSecretId = (userId: string) => `github-user-${userId}`;

export interface GitHubStatus {
  connected: boolean;
  login?: string;
}

export class GitHub {
  private flows = new Map<string, { userId: string; deviceCode: string; interval: number; expires: number }>();

  constructor(
    private readonly deps: { fetch: Fetch; secrets: Pick<SecretStore, 'get' | 'set' | 'delete' | 'list'>; clientId(): string | null },
  ) {}

  async status(userId: string): Promise<GitHubStatus> {
    const own = (await this.deps.secrets.list(() => [])).find((s) => s.id === githubSecretId(userId));
    return own ? { connected: true, login: own.label.replace(/^GitHub \((.*)\)$/, '$1') } : { connected: false };
  }

  token(userId: string): Promise<string | undefined> {
    return this.deps.secrets.get(githubSecretId(userId));
  }

  /** Checks a token with GitHub and keeps it; returns the account it belongs to. */
  async connectToken(userId: string, token: string): Promise<GitHubStatus> {
    const res = await this.deps.fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new GitHubError(res.status === 401 ? 'GitHub didn’t accept that token.' : `GitHub answered ${res.status}.`);
    // Classic tokens list their scopes; fine-grained ones don't, and are checked when used.
    const scopes = res.headers.get('x-oauth-scopes');
    if (scopes !== null && !scopes.split(',').map((s) => s.trim()).includes('codespace')) {
      throw new GitHubError('That token lacks the “codespace” scope. Create one with codespace and repo.');
    }
    const { login } = (await res.json()) as { login: string };
    await this.deps.secrets.set({ id: githubSecretId(userId), label: `GitHub (${login})`, kind: 'github', value: token });
    return { connected: true, login };
  }

  /** Starts the device flow: the person opens `verificationUri` and types `userCode`. */
  async deviceStart(userId: string): Promise<{ flowId: string; userCode: string; verificationUri: string; interval: number }> {
    const clientId = this.deps.clientId();
    if (!clientId) throw new GitHubError('Signing in with GitHub needs an OAuth app; an admin adds its client id in Settings.');
    const res = await this.deps.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope: SCOPES }).toString(),
    });
    const data = (await res.json()) as { device_code?: string; user_code?: string; verification_uri?: string; interval?: number; expires_in?: number; error_description?: string };
    if (!res.ok || !data.device_code) throw new GitHubError(data.error_description ?? `GitHub answered ${res.status}.`);
    const flowId = newId();
    for (const [id, f] of this.flows) if (f.expires < Date.now()) this.flows.delete(id);
    this.flows.set(flowId, { userId, deviceCode: data.device_code, interval: data.interval ?? 5, expires: Date.now() + (data.expires_in ?? 900) * 1000 });
    return { flowId, userCode: data.user_code!, verificationUri: data.verification_uri!, interval: data.interval ?? 5 };
  }

  /** Asks GitHub whether the person finished; poll no faster than the returned interval (seconds). */
  async devicePoll(userId: string, flowId: string): Promise<{ status: 'pending' | 'connected' | 'expired' | 'denied'; interval?: number; login?: string }> {
    const flow = this.flows.get(flowId);
    if (!flow || flow.userId !== userId || flow.expires < Date.now()) {
      this.flows.delete(flowId);
      return { status: 'expired' };
    }
    const res = await this.deps.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.deps.clientId() ?? '', device_code: flow.deviceCode, grant_type: DEVICE_GRANT }).toString(),
    });
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (data.access_token) {
      this.flows.delete(flowId);
      const { login } = await this.connectToken(userId, data.access_token);
      return { status: 'connected', ...(login ? { login } : {}) };
    }
    if (data.error === 'authorization_pending') return { status: 'pending', interval: flow.interval };
    if (data.error === 'slow_down') return { status: 'pending', interval: (flow.interval += 5) };
    this.flows.delete(flowId);
    return { status: data.error === 'access_denied' ? 'denied' : 'expired' };
  }

  async disconnect(userId: string): Promise<void> {
    await this.deps.secrets.delete(githubSecretId(userId));
  }
}
