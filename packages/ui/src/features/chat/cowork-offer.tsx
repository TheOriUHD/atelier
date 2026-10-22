/**
 * Under a chat reply that worked in the sandbox: an offer to continue the conversation as a Cowork task, where longer
 * work in a folder belongs. It goes when the person writes again, and for good once dismissed.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRight, X } from 'lucide-react';
import type { Message } from '@atelier/protocol';
import { Button, IconButton, toast } from '../../components/ui/index.ts';
import { usePrefs, useSetPref } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

const SANDBOX_TOOLS = new Set(['Bash', 'Read']);

/** Whether the reply after the person's last message used the sandbox. */
export function usedSandbox(messages: readonly Message[]): boolean {
  const lastAsk = messages.findLastIndex((m) => m.role === 'user' && m.kind === 'normal');
  return messages.slice(lastAsk + 1).some((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'tool_call' && SANDBOX_TOOLS.has(p.name)));
}

export function CoworkOffer({ sessionId, messages, running }: { sessionId: string; messages: readonly Message[]; running: boolean }) {
  const { prefs } = usePrefs();
  const setPref = useSetPref();
  const navigate = useNavigate();
  const [moving, setMoving] = useState(false);
  if (running || !prefs?.chat.coworkOffer || !usedSandbox(messages)) return null;

  const move = () => {
    setMoving(true);
    rpc()
      .call('sessions.continueInCowork', { id: sessionId })
      .then((task) => navigate({ to: '/work/$sessionId', params: { sessionId: task.id } }))
      .catch((e: unknown) => {
        setMoving(false);
        toast.error(describeError(e).message);
      });
  };

  return (
    <div role="note" aria-label="Continue in Cowork" className="flex items-center gap-1 text-body text-fg-muted">
      <span className="mr-1">Doing more than a quick look?</span>
      <Button size="sm" variant="ghost" trailingIcon={ArrowRight} loading={moving} onClick={move}>
        Continue in Cowork
      </Button>
      <IconButton icon={X} size="xs" label="Don’t offer Cowork again" onClick={() => setPref.mutate({ path: ['chat', 'coworkOffer'], value: false })} />
    </div>
  );
}
