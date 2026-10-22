/** The composer's connector switches: which connectors a conversation may use. */
import { useState } from 'react';
import type { SessionSummary } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { useMcpStatus } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import type { ConnectorSwitches } from './composer.tsx';

/** For a conversation that exists: saved on it, so they apply from its next turn. */
export function useSessionConnectors(session: SessionSummary | null | undefined): ConnectorSwitches | undefined {
  const list = useMcpStatus() ?? [];
  if (!session) return undefined;
  return {
    list,
    off: session.connectorsOff,
    onChange: (off) => void rpc().call('sessions.update', { id: session.id, connectorsOff: off }).catch((e: unknown) => toast.error(describeError(e).message)),
  };
}

/** For a conversation about to start: kept here until it is created with them. */
export function useNewConnectors(): ConnectorSwitches {
  const list = useMcpStatus() ?? [];
  const [off, setOff] = useState<string[]>([]);
  return { list, off, onChange: setOff };
}
