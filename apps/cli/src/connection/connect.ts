/**
 * Connecting a terminal to its backend (ARCHITECTURE §25):
 *   standalone   the background service's backend, over its local socket (signed in as this computer's owner)
 *   server mode  the server's `/api/ws` with this terminal's token, plus the background service holding the device link
 * Either way the TUI gets the same typed RPC client and live sessions the app has.
 */
import { contract, createRpcClient, RpcError, type AppContract, type DeviceInfo, type RpcClient, type UserSummary } from '@atelier/protocol';
import { createLiveSessions, wsTransport, type LiveSessions, type ReconnectingTransport } from '@atelier/client';
import { diagnose } from '@atelier/core/device';
import type { CliConfig } from '../config.ts';
import { cliDevice } from '../daemon/daemon.ts';
import { connectService, serviceTransport, type ServiceLink } from '../daemon/client.ts';
import { credentialStore, tokenName } from '../keychain.ts';
import { networkProgram } from './known.ts';
import type { CliPaths } from '../paths.ts';
import { USER_AGENT } from '../runtime.ts';

export class NeedsSetup extends Error {
  constructor(readonly reason: 'no-connection' | 'no-account' | 'signed-out', message: string) {
    super(message);
  }
}

export interface Connected {
  mode: 'local' | 'server';
  serverUrl: string | null;
  rpc: RpcClient<AppContract>;
  live: LiveSessions;
  transport: ReconnectingTransport;
  user: UserSummary;
  /** Server mode: this computer as the server's device. */
  device: DeviceInfo | null;
  service: ServiceLink | null;
  close(): void;
}

export const errorCode = (e: unknown): string | undefined => (e instanceof RpcError ? (e.data as { code?: string } | undefined)?.code : undefined);

/** A plain sentence for a failed call. */
export function describe(e: unknown): string {
  if (e instanceof RpcError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function connect(p: CliPaths, config: CliConfig, options: { service?: boolean } = {}): Promise<Connected> {
  const connection = config.connection;
  if (!connection) throw new NeedsSetup('no-connection', 'Atelier isn’t set up in this terminal yet.');

  if (connection.mode === 'local') {
    const link = await connectService(p, { mode: 'local' });
    const transport = serviceTransport(p, link, { mode: 'local' });
    const rpc = createRpcClient(contract, transport);
    const status = await rpc.call('auth.status', {});
    if (status.setupRequired) {
      transport.close();
      throw new NeedsSetup('no-account', 'This computer has no account yet.');
    }
    // The service signs its terminals in; a terminal connected before the account existed signs in itself.
    let user = status.user;
    if (!user) user = (await rpc.call('auth.localSignIn', { clientKind: 'cli' })).user;
    transport.onReconnect(() => void rpc.call('auth.status', {}).then((s) => (s.user ? undefined : rpc.call('auth.localSignIn', { clientKind: 'cli' }))).catch(() => undefined));
    const live = createLiveSessions({ rpc: () => rpc, onReconnect: (h) => void transport.onReconnect(h) });
    return { mode: 'local', serverUrl: null, rpc, live, transport, user, device: null, service: link, close: () => (transport.close(), link.close()) };
  }

  const serverUrl = connection.serverUrl;
  const store = await credentialStore(p.credentials);
  // ATELIER_TOKEN (a script, CI) goes before the stored one and isn't kept.
  const token = process.env.ATELIER_TOKEN || (await store.get(tokenName(serverUrl)));
  if (!token) throw new NeedsSetup('signed-out', `Sign in to ${new URL(serverUrl).host} first: atelier login`);
  // The tries go on until the server answers. Before the first answer, a word on stderr says why it waits: most often
  // macOS asking whether the program may reach the local network (it only asks a program that keeps running).
  let answered = false;
  const waiting = (failures: number) => {
    if (failures !== 2 || answered) return;
    void diagnose(serverUrl).then((problem) => {
      if (answered) return;
      const host = new URL(serverUrl).host;
      process.stderr.write(
        problem.localNetwork
          ? `macOS is asking whether “${networkProgram()}” may reach ${host} on your local network: choose Allow. Chose Don’t Allow before? Switch “${networkProgram()}” on under System Settings › Privacy & Security › Local Network. Still trying…\n`
          : `${problem.message} Still trying… (Ctrl+C stops)\n`,
      );
    });
  };
  const transport = wsTransport({ serverUrl, headers: () => ({ Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT }), onFailures: waiting });
  const rpc = createRpcClient(contract, transport);
  let user: UserSummary;
  try {
    user = await rpc.call('account.get', {});
    answered = true;
  } catch (e) {
    answered = true;
    transport.close();
    if (errorCode(e) === 'unauthenticated') throw new NeedsSetup('signed-out', `Your sign-in to ${new URL(serverUrl).host} ended. Sign in again: atelier login`);
    throw e;
  }
  const device = await cliDevice(p);
  const register = () => rpc.call('devices.register', device).catch(() => undefined);
  await register();
  transport.onReconnect(() => void register());
  // The device link lives in the background service, so tools keep reaching this computer between terminals.
  const service = options.service === false ? null : await connectService(p, { mode: 'server', serverUrl }).catch(() => null);
  const live = createLiveSessions({ rpc: () => rpc, onReconnect: (h) => void transport.onReconnect(h) });
  return { mode: 'server', serverUrl, rpc, live, transport, user, device, service, close: () => (transport.close(), service?.close()) };
}
