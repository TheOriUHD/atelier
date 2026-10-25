/**
 * Personal connectors (ARCHITECTURE §9-B): on a server, anyone adds their own, beside the admin's shared ones. Each
 * person gets an `McpManager` of their own, made once they have a connector, that resolves only their own secrets and
 * never the server's environment. A connector that runs a program (stdio) runs it on the first of their desktops that
 * is online and allows exactly that program (`lending.json`, by fingerprint), over the device link; an HTTP or SSE one
 * is reached from the server when its address is public, and through such a desktop when it is on that computer or its
 * network. What a connector's program writes, and why it failed, stays in its owner's log (`connectors.logs`).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FetchLike } from '@modelcontextprotocol/client';
import {
  connectorFingerprintInput,
  PersonalConnector,
  UNSAFE_CONNECTOR_ENV,
  type ElicitationAnswer,
  type ElicitationRequest,
  type McpServerConfig,
  type McpServerStatus,
  type PersonalConnectorInput,
  type PersonalConnectorView,
} from '@atelier/protocol';
import type { SecretStore } from '../secrets/secret-store.ts';
import { personalSecretOf } from '../secrets/secret-store.ts';
import type { BlobStore } from '../store/blobs.ts';
import { assertPublicHost } from '../tools/address-guard.ts';
import type { Tool } from '../tools/types.ts';
import { deviceFetch } from '../workspaces/device-fetch.ts';
import type { DeviceLinks } from '../workspaces/device-links.ts';
import { LineTransport } from './line-transport.ts';
import { McpManager, type SignInStarter } from './manager.ts';

/** How many connectors one person may have. */
export const PERSONAL_CONNECTOR_LIMIT = 50;

export class PersonalConnectorError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'not_found' | 'limit',
    message: string,
  ) {
    super(message);
  }
}

export interface PersonalConnectorsDeps {
  /** The person's connectors as saved (their preferences), and saving them. */
  connectors(userId: string): Promise<PersonalConnector[]>;
  saveConnectors(userId: string, list: PersonalConnector[]): Promise<void>;
  /** The admin's connectors: a personal one of the same name stays off. */
  shared(): Record<string, McpServerConfig>;
  secrets: Pick<SecretStore, 'forUser' | 'set' | 'delete'>;
  links: Pick<DeviceLinks, 'devices' | 'info' | 'start'>;
  deviceName(userId: string, deviceId: string): Promise<string>;
  /** The server's own `fetch`, for public addresses. */
  fetch: FetchLike;
  /** Throws when a host is this machine or on a private network; the address guard by default. */
  publicHost?(host: string): Promise<void>;
  blobs: Pick<BlobStore, 'put'>;
  elicit(sessionId: string, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationAnswer>;
  /** A person's connectors changed state: their windows hear of it. */
  changed(userId: string): void;
  callTimeoutMs?: number;
}

interface Person {
  manager: McpManager;
  /** What the manager runs, by name: everything saved but names an admin's connector has. */
  servers: Record<string, McpServerConfig>;
  byName: Map<string, PersonalConnector>;
  /** The computer each connector runs on or through, while it does, by name. */
  runsOn: Map<string, string>;
  /** The last computer each ran on, by id, for saying it is offline. */
  lastOn: Map<string, string>;
  statuses: McpServerStatus[];
}

const valuesId = (userId: string, id: string) => `connector-user-${userId}-${id}`;
const signInId = (userId: string, name: string) => `mcp-oauth-user-${userId}-${name}`;
const fingerprint = (command: string, args: readonly string[], envKeys: readonly string[]) => createHash('sha256').update(connectorFingerprintInput(command, args, envKeys)).digest('hex');
const ALLOW_HINT = 'allow it in Customize › Connectors in the Atelier desktop app there';

interface Values {
  env: Record<string, string>;
  headers: Record<string, string>;
}

export class PersonalConnectors {
  private people = new Map<string, Person>();
  /** One reload at a time per person. */
  private loading = new Map<string, Promise<Person | null>>();

  constructor(private readonly deps: PersonalConnectorsDeps) {}

  /** The person's connectors and whether an admin's has the same name. */
  async list(userId: string): Promise<PersonalConnectorView[]> {
    const shared = this.deps.shared();
    return (await this.deps.connectors(userId)).map((connector) => ({ connector, clash: Object.hasOwn(shared, connector.name) }));
  }

  /** Adds or changes one; values left null keep what was saved. */
  /**
   * Adds or changes one of the person's connectors. With `create`, `input.id` is the id a new one gets (chosen before
   * it exists, so that a desktop could allow its address under it first).
   */
  async save(userId: string, input: PersonalConnectorInput, create = false): Promise<PersonalConnector> {
    const list = await this.deps.connectors(userId);
    const existing = input.id ? list.find((c) => c.id === input.id) : undefined;
    if (input.id && !existing && !create) throw new PersonalConnectorError('not_found', 'That connector no longer exists.');
    if (create && existing) throw new PersonalConnectorError('invalid_request', 'That connector exists already.');
    if (!existing && list.length >= PERSONAL_CONNECTOR_LIMIT) throw new PersonalConnectorError('limit', `You can have up to ${PERSONAL_CONNECTOR_LIMIT} connectors.`);
    if (list.some((c) => c.name === input.name && c !== existing)) throw new PersonalConnectorError('invalid_request', `You have a connector called ${input.name} already.`);
    if (Object.hasOwn(this.deps.shared(), input.name)) throw new PersonalConnectorError('invalid_request', `An admin's connector is called ${input.name}: choose another name.`);
    const unsafe = Object.keys(input.env).find((key) => UNSAFE_CONNECTOR_ENV.test(key));
    if (unsafe) throw new PersonalConnectorError('invalid_request', `A connector can't set ${unsafe}: it changes which programs run.`);
    if (input.type !== 'stdio') {
      const url = URL.parse(input.url ?? '');
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new PersonalConnectorError('invalid_request', 'Use an http or https URL.');
    }
    const parsed = PersonalConnector.safeParse({
      id: existing?.id ?? input.id ?? randomBytes(8).toString('hex'),
      name: input.name,
      type: input.type,
      ...(input.type === 'stdio' ? { command: input.command, args: input.args ?? [] } : { url: input.url, ...(input.auth ? { auth: input.auth } : {}) }),
      envKeys: input.type === 'stdio' ? Object.keys(input.env) : [],
      headerKeys: input.type === 'stdio' ? [] : Object.keys(input.headers),
      enabled: input.enabled ?? true,
      disabledTools: input.disabledTools ?? [],
    });
    if (!parsed.success) throw new PersonalConnectorError('invalid_request', parsed.error.issues[0]?.message ?? 'Not a connector.');
    const connector = parsed.data;
    const before = existing ? await this.values(userId, existing.id) : { env: {}, headers: {} };
    const fill = (given: Record<string, string | null>, saved: Record<string, string>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, given[k] ?? saved[k] ?? '']));
    const values: Values = { env: fill(input.env, before.env, connector.envKeys), headers: fill(input.headers, before.headers, connector.headerKeys) };
    await this.deps.secrets.set({ id: valuesId(userId, connector.id), label: `Connector ${connector.name}`, kind: 'token', value: JSON.stringify(values) });
    // A sign-in belongs to a name and an address: one that changes, or stops signing in, forgets it.
    if (existing?.auth && (existing.name !== connector.name || existing.url !== connector.url || !connector.auth)) await this.forgetSignIn(userId, existing.name);
    await this.deps.saveConnectors(userId, existing ? list.map((c) => (c === existing ? connector : c)) : [...list, connector]);
    await this.sync(userId);
    return connector;
  }

  async remove(userId: string, id: string): Promise<void> {
    const list = await this.deps.connectors(userId);
    const gone = list.find((c) => c.id === id);
    if (!gone) return;
    await this.deps.saveConnectors(
      userId,
      list.filter((c) => c !== gone),
    );
    await this.deps.secrets.delete(valuesId(userId, id));
    await this.forgetSignIn(userId, gone.name);
    await this.sync(userId);
  }

  /** Every one's status; asking starts connecting the ones not tried yet. */
  async status(userId: string): Promise<McpServerStatus[]> {
    const person = await this.person(userId);
    if (!person) return [];
    person.statuses = person.manager.status();
    return this.decorated(person);
  }

  /** What is known now, without connecting anything. */
  known(userId: string): McpServerStatus[] {
    const person = this.people.get(userId);
    return person ? this.decorated(person) : [];
  }

  async tools(userId: string, off: readonly string[]): Promise<Tool[]> {
    const person = await this.person(userId);
    return person ? person.manager.tools(off) : [];
  }

  async test(userId: string, id: string): Promise<McpServerStatus> {
    const { person, connector } = await this.connector(userId, id);
    await person.manager.test(connector.name);
    return this.decorated(person).find((s) => s.name === connector.name)!;
  }

  async signIn(userId: string, id: string, starter: SignInStarter): Promise<string> {
    const { person, connector } = await this.connector(userId, id);
    return person.manager.signIn(connector.name, starter);
  }

  async logs(userId: string, id: string): Promise<string[]> {
    const { person, connector } = await this.connector(userId, id);
    return person.manager.logs(connector.name) ?? [];
  }

  /** Whether the browser came back from one of these sign-ins. */
  owns(params: URLSearchParams): boolean {
    return [...this.people.values()].some((p) => p.manager.signingIn(params.get('state')));
  }

  finishSignIn(params: URLSearchParams, userId: string | null): Promise<string | null> {
    const person = [...this.people.values()].find((p) => p.manager.signingIn(params.get('state')));
    return person ? person.manager.finishSignIn(params, userId) : Promise.resolve('This sign-in has expired or was used already.');
  }

  /** One of the person's computers came or went, or changed what it allows: what failed tries again. */
  devicesChanged(userId: string): void {
    this.people.get(userId)?.manager.retry();
  }

  /** The admin's connectors changed: a name they now share (or no longer do) changes what runs. */
  sharedChanged(): void {
    for (const userId of this.people.keys()) void this.sync(userId).catch(() => undefined);
  }

  /** Reads the person's connectors again (after a change) and restarts what changed. */
  async sync(userId: string): Promise<void> {
    await this.load(userId, true);
  }

  async close(): Promise<void> {
    const people = [...this.people.values()];
    this.people.clear();
    await Promise.all(people.map((p) => p.manager.close()));
  }

  private async connector(userId: string, id: string): Promise<{ person: Person; connector: PersonalConnector }> {
    const person = await this.person(userId);
    const connector = person && [...person.byName.values()].find((c) => c.id === id);
    if (!person || !connector) throw new PersonalConnectorError('not_found', 'That connector doesn’t exist, or an admin’s has its name.');
    return { person, connector };
  }

  private person(userId: string): Promise<Person | null> {
    const person = this.people.get(userId);
    return person ? Promise.resolve(person) : this.load(userId, false);
  }

  private load(userId: string, reload: boolean): Promise<Person | null> {
    const run = (this.loading.get(userId) ?? Promise.resolve(null)).then(
      () => this.reload(userId, reload),
      () => this.reload(userId, reload),
    );
    this.loading.set(userId, run);
    return run;
  }

  private async reload(userId: string, reload: boolean): Promise<Person | null> {
    const had = this.people.get(userId);
    if (had && !reload) return had;
    const list = await this.deps.connectors(userId);
    if (!list.length) {
      if (had) {
        this.people.delete(userId);
        await had.manager.close();
        this.deps.changed(userId);
      }
      return null;
    }
    const shared = this.deps.shared();
    const servers: Record<string, McpServerConfig> = {};
    const byName = new Map<string, PersonalConnector>();
    for (const c of list) {
      if (Object.hasOwn(shared, c.name)) continue;
      const values = await this.values(userId, c.id);
      byName.set(c.name, c);
      servers[c.name] = {
        type: c.type,
        ...(c.command ? { command: c.command } : {}),
        args: c.args,
        env: Object.fromEntries(c.envKeys.map((k) => [k, values.env[k] ?? ''])),
        ...(c.url ? { url: c.url } : {}),
        headers: Object.fromEntries(c.headerKeys.map((k) => [k, values.headers[k] ?? ''])),
        enabled: c.enabled,
        disabledTools: c.disabledTools,
        ...(c.auth ? { auth: c.auth } : {}),
      };
    }
    if (had) {
      Object.assign(had, { servers, byName });
      had.manager.sync();
      this.deps.changed(userId);
      return had;
    }
    const person: Person = { manager: null!, servers, byName, runsOn: new Map(), lastOn: new Map(), statuses: [] };
    person.manager = this.managerFor(userId, person);
    this.people.set(userId, person);
    return person;
  }

  private managerFor(userId: string, person: Person): McpManager {
    const own = (id: string) => {
      if (!personalSecretOf(id, userId)) throw new Error('That isn’t one of your secrets.');
      return id;
    };
    const guarded = this.guardedFetch();
    const manager = new McpManager({
      servers: () => person.servers,
      surface: 'web',
      startable: () => true,
      // Only the person's own secrets, and none of the server's environment: a program's `${VAR}` is its computer's.
      secret: (id) => this.deps.secrets.forUser(userId, id),
      secrets: { get: (id) => this.deps.secrets.forUser(userId, id), set: (s) => this.deps.secrets.set({ ...s, id: own(s.id!) }), delete: (id) => this.deps.secrets.delete(own(id)) },
      signInSecret: (name) => signInId(userId, name),
      env: {},
      deferEnv: true,
      blobs: this.deps.blobs,
      // Their log is theirs (Customize › Connectors), not the server's.
      logger: { info: () => {}, error: () => {} },
      elicit: (sessionId, request, signal) => this.deps.elicit(sessionId, request, signal),
      fetch: guarded,
      reach: (server, resolved, log) => this.reach(userId, person, server.name, server.config, resolved, log),
      ...(this.deps.callTimeoutMs ? { callTimeoutMs: this.deps.callTimeoutMs } : {}),
    });
    manager.on('changed', (list) => {
      person.statuses = list;
      if (this.people.get(userId) === person) this.deps.changed(userId);
    });
    return manager;
  }

  private async reach(
    userId: string,
    person: Person,
    name: string,
    config: McpServerConfig,
    resolved: { env: Record<string, string>; url: string },
    log: (line: string) => void,
  ): Promise<{ transport: LineTransport } | { fetch: FetchLike }> {
    const connector = person.byName.get(name);
    if (!connector) throw new Error('This connector was removed.');
    person.runsOn.delete(name);
    const devices = this.deps.links.devices(userId).map((id) => ({ id, info: this.deps.links.info(userId, id) }));
    const at = async (deviceId: string) => {
      const device = await this.deps.deviceName(userId, deviceId);
      person.runsOn.set(name, device);
      person.lastOn.set(connector.id, deviceId);
      return device;
    };
    if (config.type === 'stdio') {
      const print = fingerprint(config.command!, config.args, Object.keys(resolved.env));
      let changed: string | null = null;
      for (const { id, info } of devices) {
        const lent = info?.services.includes('mcp') ? info.lending.connectors.find((c) => c.id === connector.id) : undefined;
        if (!lent) continue;
        if (lent.fingerprint !== print) {
          changed = id;
          continue;
        }
        const channel = await this.deps.links.start(userId, id, { kind: 'mcp', connectorId: connector.id, command: config.command!, args: config.args, env: resolved.env }, log);
        await at(id);
        return { transport: new LineTransport(channel) };
      }
      if (changed) throw new Error(`It changed since you allowed it on ${await this.deps.deviceName(userId, changed)}: ${ALLOW_HINT} again.`);
      const last = person.lastOn.get(connector.id);
      if (last && !devices.some((d) => d.id === last)) throw new Error(`Offline on ${await this.deps.deviceName(userId, last)}: it runs there.`);
      throw new Error(`It runs a program on your computer: ${ALLOW_HINT}.`);
    }
    const url = new URL(resolved.url);
    if (await this.isPublic(url.hostname)) return { fetch: this.guardedFetch() };
    for (const { id, info } of devices) {
      if (!info?.services.includes('http') || !info.lending.http.some((a) => a.id === connector.id)) continue;
      await at(id);
      return { fetch: deviceFetch(this.deps.links, userId, id, connector.id) };
    }
    const last = person.lastOn.get(connector.id);
    if (last && !devices.some((d) => d.id === last)) throw new Error(`Offline on ${await this.deps.deviceName(userId, last)}: ${url.host} is reached through it.`);
    throw new Error(`${url.host} is on your computer or its network, which the server can't reach: ${ALLOW_HINT}.`);
  }

  private isPublic(host: string): Promise<boolean> {
    return (this.deps.publicHost ?? ((h: string) => assertPublicHost(h, false)))(host).then(
      () => true,
      () => false,
    );
  }

  /** The server's fetch, only ever to public addresses, following no redirect (one could lead to a private one). */
  private guardedFetch(): FetchLike {
    return async (input, init) => {
      const url = new URL(String(input));
      if (!(await this.isPublic(url.hostname))) throw new TypeError('fetch failed', { cause: new Error(`${url.host} is not a public address.`) });
      return this.deps.fetch(url, { ...init, redirect: 'manual' });
    };
  }

  /** The ones that run; one whose name an admin's has is only in `list` (as `clash`), so no name is there twice. */
  private decorated(person: Person): McpServerStatus[] {
    return person.statuses.map((s) => {
      const device = s.state === 'ready' ? person.runsOn.get(s.name) : undefined;
      return { ...s, personal: true, ...(device ? { device } : {}) };
    });
  }

  private async values(userId: string, id: string): Promise<Values> {
    try {
      const parsed = JSON.parse((await this.deps.secrets.forUser(userId, valuesId(userId, id))) ?? '{}') as Partial<Values>;
      return { env: parsed.env ?? {}, headers: parsed.headers ?? {} };
    } catch {
      return { env: {}, headers: {} };
    }
  }

  private async forgetSignIn(userId: string, name: string): Promise<void> {
    const person = this.people.get(userId);
    if (person?.byName.has(name)) await person.manager.signOut(name);
    else await this.deps.secrets.delete(signInId(userId, name));
  }
}
