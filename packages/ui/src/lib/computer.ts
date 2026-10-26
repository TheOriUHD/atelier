/**
 * Computer use on this computer (ARCHITECTURE §22), as the desktop app's windows see it: the status main keeps, read
 * again when it changes and when the window comes back to the front (the person may have switched a permission on in
 * System Settings meanwhile).
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComputerStatus } from '@atelier/protocol';
import { desktop } from './platform.ts';
import { useConnection } from './lending.ts';

const KEY = ['desktop', 'computer'] as const;

export function useComputerStatus(): ComputerStatus | undefined {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: () => desktop!.computer!.status(), enabled: !!desktop?.computer, refetchOnWindowFocus: true });
  useEffect(() => desktop?.computer?.onChanged(() => void qc.invalidateQueries({ queryKey: KEY })), [qc]);
  return data;
}

/**
 * Where this window can answer a session's computer use cards: in the desktop app running the session on its own
 * backend (`local`). A browser or a desktop signed in to a server can't allow anything on this computer yet.
 */
export function useComputerHere(): string | null {
  const { data: connection } = useConnection();
  return desktop?.computer && connection?.mode === 'local' ? 'local' : null;
}

export async function refreshComputer(qc: ReturnType<typeof useQueryClient>, run: () => Promise<unknown>): Promise<void> {
  await run();
  await qc.invalidateQueries({ queryKey: KEY });
}
