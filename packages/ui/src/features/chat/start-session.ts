/** Starting a conversation from a home page: Chat, a project, Work or Code. */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { z } from 'zod';
import type { AppContract, Part } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { SESSION_ROUTE } from '../../app/navigation.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useSplitCell } from '../../lib/split-cell.tsx';
import { trustWorkspace } from '../workspaces/trust.tsx';
import type { useAttachments } from './use-attachments.ts';

type NewSession = z.input<AppContract['procedures']['sessions.create']['input']>;

/**
 * Creates the session, sends the first message with the attachments and opens it. When sending fails the new,
 * empty session is deleted again, so trying once more doesn't leave one behind. A session in a folder the backend doesn't
 * trust yet (a codespace added before "Trust this workspace?" was asked) asks first, and doesn't start without a yes.
 */
export function useStartSession(attachments: ReturnType<typeof useAttachments>) {
  const navigate = useNavigate();
  // In a split view cell the new session takes the cell's place; elsewhere the page goes to it.
  const cell = useSplitCell();
  const [sending, setSending] = useState(false);
  const start = async (session: NewSession, text: string): Promise<void> => {
    if (sending) return;
    setSending(true);
    let sessionId: string | null = null;
    try {
      if (session.workspaceId) {
        const folder = (await rpc().call('workspaces.list', {})).find((w) => w.id === session.workspaceId);
        if (folder && !(await trustWorkspace(folder))) return;
      }
      sessionId = (await rpc().call('sessions.create', session)).id;
      const parts: Part[] = [...attachments.parts(), ...(text ? [{ type: 'text' as const, text }] : [])];
      await rpc().call('chat.send', { sessionId, parts });
      attachments.clear();
      if (cell) cell.openSession(sessionId);
      else void navigate({ to: SESSION_ROUTE[session.mode], params: { sessionId } });
    } catch (error) {
      if (sessionId) void rpc().call('sessions.delete', { id: sessionId }).catch(() => {});
      toast.error(describeError(error).message);
    } finally {
      setSending(false);
    }
  };
  return { sending, start };
}
