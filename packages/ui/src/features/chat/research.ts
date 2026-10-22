/** The composer's Research switch: each message asks for a broad, sourced web search. Offered while an admin has web search on. */
import { useState } from 'react';
import type { SessionSummary } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

export interface ResearchSwitch {
  on: boolean;
  onChange(on: boolean): void;
}

function useWebSearch(): boolean {
  return !!useSettings().settings?.capabilities.webSearch.enabled;
}

/** For a conversation that exists: saved on it, from its next message. */
export function useSessionResearch(session: SessionSummary | null | undefined): ResearchSwitch | undefined {
  const available = useWebSearch();
  if (!session || !available) return undefined;
  return {
    on: session.research,
    onChange: (research) =>
      void rpc()
        .call('sessions.update', { id: session.id, research })
        .catch((e: unknown) => toast.error(describeError(e).message)),
  };
}

/** For a conversation about to start: kept here until it is created with it. */
export function useNewResearch(): ResearchSwitch | undefined {
  const available = useWebSearch();
  const [on, setOn] = useState(false);
  return available ? { on, onChange: setOn } : undefined;
}
