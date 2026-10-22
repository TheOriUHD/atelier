import { useQuery } from '@tanstack/react-query';
import type { SshConnectionView } from '@atelier/protocol';
import { desktop } from '../../lib/platform.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';

/** The person's own SSH connections (desktop app only; none elsewhere). */
export function useSshConnections(): SshConnectionView[] {
  const { data } = useQuery({ queryKey: keys.ssh, queryFn: () => rpc().call('ssh.list', {}), enabled: !!desktop, staleTime: 30_000 });
  return data ?? [];
}

/** What a host is called in menus: its connection's name, else the host itself. */
export function sshName(connections: readonly SshConnectionView[], host: string | null | undefined): string {
  return connections.find((c) => c.host === host)?.name ?? host ?? 'SSH host';
}
