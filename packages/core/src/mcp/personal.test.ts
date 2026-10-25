import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { connectorFingerprintInput, NO_LENDING, PersonalConnector, type DeviceStart, type McpServerConfig } from '@atelier/protocol';
import { personalSecretOf } from '../secrets/secret-store.ts';
import type { ToolContext } from '../tools/types.ts';
import type { DeviceLinkInfo } from '../workspaces/device-links.ts';
import { LineTransport, programChannel } from './line-transport.ts';
import { PersonalConnectors, type PersonalConnectorsDeps } from './personal.ts';

const STDIO_SERVER = fileURLToPath(new URL('./__fixtures__/stdio-server.ts', import.meta.url));
const ctx = (): ToolContext => ({ sessionId: 's1', callId: 'c1', signal: new AbortController().signal }) as ToolContext;
const print = (command: string, args: string[], envKeys: string[]) => createHash('sha256').update(connectorFingerprintInput(command, args, envKeys)).digest('hex');
const online = (lending: Partial<DeviceLinkInfo['lending']> = {}): DeviceLinkInfo => ({ services: ['runner', 'mcp', 'http'], lending: { ...NO_LENDING, ...lending }, home: '/home/ada', sep: '/', os: 'darwin', app: '0.3.0' });

describe('the line transport', () => {
  it("speaks MCP to a program's stdio through a channel's lines", async () => {
    const stderr: string[] = [];
    const channel = await programChannel({ command: process.execPath, args: [STDIO_SERVER], env: { MOCK_TOKEN: 'line-token' }, cwd: tmpdir() }, (line) => stderr.push(line));
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new LineTransport(channel));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('echo');
      expect(await client.callTool({ name: 'echo', arguments: { text: 'over lines' } })).toMatchObject({ content: [{ type: 'text', text: 'over lines' }] });
      expect(stderr.join('\n')).toContain('mock server starting with token line-token');
    } finally {
      await client.close();
    }
    await channel.closed;
  });
});

describe('personal connectors', () => {
  let prefs: Map<string, PersonalConnector[]>;
  let vault: Map<string, string>;
  let devices: Map<string, DeviceLinkInfo>;
  let started: DeviceStart[];
  let shared: Record<string, McpServerConfig>;
  let people: PersonalConnectors;

  beforeEach(() => {
    prefs = new Map();
    vault = new Map();
    devices = new Map();
    started = [];
    shared = {};
    const deps: PersonalConnectorsDeps = {
      connectors: async (userId) => prefs.get(userId) ?? [],
      saveConnectors: async (userId, list) => void prefs.set(userId, list),
      shared: () => shared,
      secrets: {
        forUser: async (userId, id) => (personalSecretOf(id, userId) ? vault.get(id) : undefined),
        set: async ({ id, value }) => (vault.set(id!, value), id!),
        delete: async (id) => void vault.delete(id),
      },
      links: {
        devices: () => [...devices.keys()],
        info: (_userId, id) => devices.get(id) ?? null,
        // The device's end, here: the program runs on this machine.
        start: async (_userId, _deviceId, service, log) => {
          started.push(service);
          if (service.kind !== 'mcp') throw new Error('not here');
          return programChannel({ command: service.command, args: service.args, env: service.env, cwd: tmpdir() }, log ?? (() => {}));
        },
      },
      deviceName: async (_userId, id) => (id === 'mac' ? 'MacBook' : 'Desktop'),
      fetch: () => Promise.reject(new Error('no network here')),
      publicHost: async (host) => {
        if (host !== 'mcp.example.com') throw new Error('private');
      },
      blobs: { put: async () => ({ sha256: 'x', mime: 'image/png', size: 1 }) as never },
      elicit: async () => ({ action: 'decline' }),
      changed: () => {},
    };
    people = new PersonalConnectors(deps);
  });

  afterEach(async () => {
    await people.close();
  });

  const addMock = (userId = 'u1', env: Record<string, string | null> = { MOCK_TOKEN: 'my-token' }) =>
    people.save(userId, { name: 'mock', type: 'stdio', command: process.execPath, args: [STDIO_SERVER], env, headers: {}, enabled: true, disabledTools: [] });

  it('runs a program on a desktop of its owner that allows it, once one is online', async () => {
    const saved = await addMock();
    // The values are the owner's secret, not their preferences.
    expect(prefs.get('u1')).toEqual([expect.objectContaining({ name: 'mock', envKeys: ['MOCK_TOKEN'] })]);
    expect(JSON.stringify(prefs.get('u1'))).not.toContain('my-token');
    expect(JSON.parse(vault.get(`connector-user-u1-${saved.id}`)!)).toEqual({ env: { MOCK_TOKEN: 'my-token' }, headers: {} });

    await people.test('u1', saved.id);
    expect((await people.status('u1'))[0]).toMatchObject({ name: 'mock', state: 'error', personal: true, error: expect.stringContaining('allow it in Customize') });

    // A desktop online that doesn't allow it, then one that allows exactly this program.
    devices.set('pc', online());
    devices.set('mac', online({ connectors: [{ id: saved.id, name: 'mock', fingerprint: print(process.execPath, [STDIO_SERVER], ['MOCK_TOKEN']) }] }));
    people.devicesChanged('u1');
    await expect.poll(async () => (await people.status('u1'))[0]?.state).toBe('ready');
    expect((await people.status('u1'))[0]).toMatchObject({ device: 'MacBook', personal: true });
    expect(started).toEqual([{ kind: 'mcp', connectorId: saved.id, command: process.execPath, args: [STDIO_SERVER], env: { MOCK_TOKEN: 'my-token' } }]);

    const whoami = (await people.tools('u1', [])).find((t) => t.name === 'mcp__mock__whoami')!;
    // It got the saved value, masked in what it returns as every credential is.
    expect(await whoami.run({}, ctx())).toMatchObject({ content: [{ type: 'text', text: 'token: ••••' }] });
    // Switched off for a session: none of its tools.
    expect(await people.tools('u1', ['mock'])).toEqual([]);
    // Someone else has none of them.
    expect(await people.tools('u2', [])).toEqual([]);
  });

  it('says it changed when the program is no longer the one allowed', async () => {
    const saved = await addMock();
    devices.set('mac', online({ connectors: [{ id: saved.id, name: 'mock', fingerprint: print(process.execPath, [STDIO_SERVER], []) }] }));
    await people.test('u1', saved.id);
    expect((await people.status('u1'))[0]?.error).toMatch(/changed since you allowed it on MacBook/);
    expect(started).toEqual([]);
  });

  it("fills in only its owner's own secrets, and never the server's environment", async () => {
    vault.set('connector-user-u2-theirs', 'not yours');
    process.env.ATELIER_SERVER_ONLY = 'server value';
    try {
      const saved = await people.save('u1', {
        name: 'mock',
        type: 'stdio',
        command: process.execPath,
        args: [STDIO_SERVER],
        env: { MOCK_TOKEN: '${ATELIER_SERVER_ONLY}', OTHER: '${secret:connector-user-u2-theirs}' },
        headers: {},
        enabled: true,
        disabledTools: [],
      });
      devices.set('mac', online({ connectors: [{ id: saved.id, name: 'mock', fingerprint: print(process.execPath, [STDIO_SERVER], ['MOCK_TOKEN', 'OTHER']) }] }));
      await people.test('u1', saved.id);
      expect((await people.status('u1'))[0]?.error).toMatch(/Missing the secret "connector-user-u2-theirs"/);
      expect(started).toEqual([]);

      await people.save('u1', { ...saved, env: { MOCK_TOKEN: '${ATELIER_SERVER_ONLY}', OTHER: 'mine' }, headers: {} });
      await people.test('u1', saved.id);
      // `${VAR}` goes as written, for the desktop to fill in from its own environment.
      expect(started.at(-1)).toMatchObject({ env: { MOCK_TOKEN: '${ATELIER_SERVER_ONLY}', OTHER: 'mine' } });

      // An HTTP one runs here: its `${VAR}` has nothing to be filled from.
      const http = await people.save('u1', { name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp', args: [], env: {}, headers: { Authorization: 'Bearer ${ATELIER_SERVER_ONLY}' }, enabled: true, disabledTools: [] });
      await people.test('u1', http.id);
      expect((await people.status('u1')).find((s) => s.name === 'remote')?.error).toMatch(/Missing the environment variable ATELIER_SERVER_ONLY/);
    } finally {
      delete process.env.ATELIER_SERVER_ONLY;
    }
  });

  it("keeps saved values unless given, and an admin's connector keeps its name", async () => {
    const saved = await addMock();
    await people.save('u1', { ...saved, env: { MOCK_TOKEN: null }, headers: {} });
    expect(JSON.parse(vault.get(`connector-user-u1-${saved.id}`)!).env).toEqual({ MOCK_TOKEN: 'my-token' });

    shared = { docs: { type: 'http', url: 'https://docs.example.com/mcp', args: [], env: {}, headers: {}, enabled: true, disabledTools: [] } };
    await expect(people.save('u1', { name: 'docs', type: 'http', url: 'https://mcp.example.com/mcp', args: [], env: {}, headers: {}, enabled: true, disabledTools: [] })).rejects.toThrow(/An admin's connector is called docs/);
    // An admin adds one with the name of yours: theirs is used, yours waits to be renamed.
    shared = { mock: shared.docs! };
    people.sharedChanged();
    await expect.poll(async () => (await people.list('u1'))[0]?.clash).toBe(true);
    await expect.poll(async () => people.status('u1')).toEqual([]);

    await expect(people.save('u1', { name: 'evil', type: 'stdio', command: 'node', args: [], env: { NODE_OPTIONS: '--require /tmp/x.js' }, headers: {}, enabled: true, disabledTools: [] })).rejects.toThrow(/NODE_OPTIONS/);
  });

  it('reaches an address on its owner’s network only through a desktop that lends it', async () => {
    const saved = await people.save('u1', { name: 'lan', type: 'http', url: 'http://192.168.1.20:8080/mcp', args: [], env: {}, headers: {}, enabled: true, disabledTools: [] });
    await people.test('u1', saved.id);
    expect((await people.status('u1'))[0]?.error).toMatch(/on your computer or its network/);
    devices.set('mac', online({ http: [{ id: saved.id, baseUrl: 'http://192.168.1.20:8080' }] }));
    await people.test('u1', saved.id);
    // Through the device: its fetch asks the link to start an `http` request there.
    expect(started.at(-1)).toMatchObject({ kind: 'http', target: saved.id, url: 'http://192.168.1.20:8080/mcp' });
  });

  it('creates one under an id chosen first (AddConnector), and only a new one', async () => {
    const input = { id: 'abc123def4567890', name: 'lan', type: 'http' as const, url: 'http://192.168.1.20:8080/mcp', args: [], env: {}, headers: {}, enabled: true, disabledTools: [] };
    // Without `create`, an id is for changing one that exists.
    await expect(people.save('u1', input)).rejects.toThrow(/no longer exists/);
    expect(await people.save('u1', input, true)).toMatchObject({ id: 'abc123def4567890', name: 'lan' });
    await expect(people.save('u1', { ...input, name: 'other' }, true)).rejects.toThrow(/exists already/);
  });

  it('forgets the values and the sign-in of one removed', async () => {
    const saved = await people.save('u1', { name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp', auth: 'oauth', args: [], env: {}, headers: { 'X-Key': 'k' }, enabled: true, disabledTools: [] });
    vault.set('mcp-oauth-user-u1-remote', '{}');
    await people.remove('u1', saved.id);
    expect([...vault.keys()]).toEqual([]);
    expect(prefs.get('u1')).toEqual([]);
  });
});
