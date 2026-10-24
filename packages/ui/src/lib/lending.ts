/**
 * What this desktop lends the server it is signed in to (ARCHITECTURE §21): SSH hosts reached with this computer's ssh,
 * and folders made here for sessions started without one. Offered only where both the server and this desktop can, and
 * allowed only from this computer's own windows: choosing an SSH host here allows it here.
 */
import { useQuery } from '@tanstack/react-query';
import type { DeviceLending, DeviceService } from '@atelier/protocol';
import { desktop, type LendingChange } from './platform.ts';
import { keys, queryClient, useAppInfo } from './queries.ts';
import { rpc } from './rpc.ts';

/** The desktop app's connection: its own backend, or a server. */
export function useConnection() {
  return useQuery({ queryKey: keys.connection, queryFn: () => desktop!.connection.get(), enabled: !!desktop });
}

export interface Lending {
  /** The desktop app is signed in to a server. */
  server: boolean;
  /** SSH hosts can be reached from this computer for the server's sessions. */
  ssh: boolean;
  /** Sessions started without a folder can get one made here. */
  scratch: boolean;
  /** Whether this computer lends `service` to the server: both ends can, and its link is up. */
  lends(service: DeviceService): boolean;
  /** What the person allowed here so far; null outside server mode. */
  allowed: DeviceLending | null;
}

export function useLending(): Lending {
  const { data: connection } = useConnection();
  const server = connection?.mode === 'server';
  const { data: info } = useAppInfo();
  const { data: devices } = useQuery({ queryKey: keys.devices, queryFn: () => rpc().call('account.devices', {}), enabled: server });
  const { data: allowed } = useQuery({ queryKey: keys.lending, queryFn: () => desktop!.lending!.get(), enabled: server && !!desktop?.lending });
  const here = devices?.find((d) => d.current);
  const can = (service: string) => server && !!desktop?.lending && !!info?.deviceLink?.services.includes(service) && !!here?.online && !!here.services?.includes(service);
  return { server, ssh: can('ssh'), scratch: can('scratch'), lends: can, allowed: allowed ?? null };
}

/** Changes what this computer lends the server; nothing outside server mode. */
export async function changeLending(change: LendingChange): Promise<DeviceLending | null> {
  if (!desktop?.lending) return null;
  const next = await desktop.lending.change(change);
  queryClient.setQueryData(keys.lending, next);
  return next;
}

/** The person chose `host` on this computer: the server may reach it from here. */
export async function lendSsh(host: string): Promise<void> {
  if (!desktop?.lending) return;
  const now = await desktop.lending.get();
  if (now && !now.ssh.includes(host)) await changeLending({ kind: 'ssh', host, allowed: true });
}
