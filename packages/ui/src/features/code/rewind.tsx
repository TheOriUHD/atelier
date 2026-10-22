/**
 * Rewind (ARCHITECTURE §8 › Checkpoints): back to before one of the person's messages whose turn changed files.
 * It restores what Write and Edit changed since then, the conversation (the old branch stays reachable), or both.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { messageText, type Message } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter, cn, toast } from '../../components/ui/index.ts';
import { resetFromSnapshot } from '../../lib/live-session.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import type { SlashCommand } from '../chat/composer-menu.tsx';
import { displayPath } from './paths.ts';

export const checkpointsKey = (sessionId: string) => ['checkpoints', sessionId] as const;

/** The person's messages whose turns changed files, with those files. */
export function useCheckpoints(sessionId: string) {
  return useQuery({ queryKey: checkpointsKey(sessionId), queryFn: () => rpc().call('checkpoints.list', { sessionId }) });
}

export function rewindCommand(open: () => void): SlashCommand {
  return { name: 'rewind', description: 'Restore the code or the conversation to an earlier point', icon: History, run: open };
}

export interface RewindPoint {
  message: Message;
  paths: string[];
}

/** The checkpoints of the conversation's current branch, newest first. */
export function rewindPoints(messages: readonly Message[], checkpoints: readonly { messageId: string; paths: string[] }[]): RewindPoint[] {
  const paths = new Map(checkpoints.map((c) => [c.messageId, c.paths]));
  return messages.flatMap((message) => (paths.has(message.id) ? [{ message, paths: paths.get(message.id)! }] : [])).reverse();
}

type Choice = { files: boolean; conversation: boolean };

const CHOICES: { label: string; choice: Choice; primary?: boolean }[] = [
  { label: 'Restore code', choice: { files: true, conversation: false } },
  { label: 'Restore conversation', choice: { files: false, conversation: true } },
  { label: 'Restore code and conversation', choice: { files: true, conversation: true }, primary: true },
];

/**
 * Lists the points to go back to, with `initial` (or the newest) chosen. After the conversation moves back,
 * `onConversationRewound` gets the message's text so it can be edited and sent again.
 */
export function RewindDialog({
  sessionId,
  points,
  initial,
  root,
  open,
  onOpenChange,
  onConversationRewound,
}: {
  sessionId: string;
  points: RewindPoint[];
  initial: string | null;
  root: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onConversationRewound(text: string): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Rewind"
        description="Go back to before one of your messages. Changes made by Bash commands aren’t tracked, so they stay as they are."
        width={600}
      >
        <RewindForm
          sessionId={sessionId}
          points={points}
          initial={initial}
          root={root}
          onDone={(text) => {
            onOpenChange(false);
            if (text !== null) onConversationRewound(text);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Inside the dialog, so each opening starts from `initial`. */
function RewindForm({
  sessionId,
  points,
  initial,
  root,
  onDone,
}: {
  sessionId: string;
  points: RewindPoint[];
  initial: string | null;
  root: string | null;
  onDone(conversationText: string | null): void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(initial ?? points[0]?.message.id ?? null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const point = points.find((p) => p.message.id === selected);

  const restore = async (label: string, { files, conversation }: Choice) => {
    if (!point) return;
    setPending(label);
    setError(null);
    try {
      const { restored, snapshot } = await rpc().call('checkpoints.rewind', { sessionId, messageId: point.message.id, files, conversation });
      resetFromSnapshot(sessionId, snapshot);
      const count = `${restored.length} ${restored.length === 1 ? 'file' : 'files'}`;
      toast.success(files && conversation ? `Restored ${count} and the conversation` : files ? `Restored ${count}` : 'Conversation rewound');
      onDone(conversation ? messageText(point.message.parts) : null);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setPending(null);
      void qc.invalidateQueries({ queryKey: ['workspace'] });
      void qc.invalidateQueries({ queryKey: checkpointsKey(sessionId) });
    }
  };

  return (
    <>
      {points.length === 0 ? (
        <p className="text-body text-fg-muted">Nothing to rewind yet: no message of yours has led to files being written or edited.</p>
      ) : (
        <div role="radiogroup" aria-label="Messages" className="-mx-3 flex max-h-80 flex-col gap-0.5 overflow-y-auto">
          {points.map(({ message, paths }) => (
            <label
              key={message.id}
              className={cn(
                // Relative: the visually hidden radio stays inside its row.
                'relative flex flex-col gap-0.5 rounded-lg px-3 py-2 has-focus-visible:shadow-[var(--at-shadow-focus)]',
                message.id === selected ? 'bg-fill-ghost-selected' : 'hover:bg-fill-ghost-hover',
              )}
            >
              <input type="radio" name="rewind-point" checked={message.id === selected} onChange={() => setSelected(message.id)} className="sr-only" />
              <span className="line-clamp-2 text-body break-words whitespace-pre-wrap text-fg">{messageText(message.parts) || 'Attachments'}</span>
              <span className="truncate text-footnote text-fg-muted">Changed {paths.map((p) => displayPath(p, root)).join(', ')}</span>
            </label>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 text-body text-danger-text">
          {error}
        </p>
      )}
      <DialogFooter>
        {CHOICES.map(({ label, choice, primary }) => (
          <Button
            key={label}
            variant={primary ? 'primary' : 'secondary'}
            disabled={!point || (pending !== null && pending !== label)}
            loading={pending === label}
            onClick={() => void restore(label, choice)}
          >
            {label}
          </Button>
        ))}
      </DialogFooter>
    </>
  );
}
