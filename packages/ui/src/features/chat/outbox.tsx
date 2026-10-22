/**
 * Messages sent while the agent works: each shows as waiting at the end of the conversation, joins it
 * at the agent's next step, and can be taken back (its text returns to the message box) or sent now, which interrupts
 * the step in progress; the agent carries on from there.
 */
import type { RefObject } from 'react';
import { CornerDownLeft, FileText, X } from 'lucide-react';
import { messageText, type OutboxMessage, type Part } from '@atelier/protocol';
import { Button, Icon, IconButton, toast } from '../../components/ui/index.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import type { ComposerHandle } from './composer.tsx';
import type { Attachments } from './use-attachments.ts';

/** What a waiting message's actions do; the page owns the message box they put text back into. */
export interface OutboxActions {
  onTakeBack(id: string): void;
  onSendNow(id: string): void;
}

export function Outbox({ items, actions }: { items: readonly OutboxMessage[]; actions: OutboxActions }) {
  if (!items.length) return null;
  return (
    <>
      {items.map((item) => {
        const text = messageText(item.parts);
        const files = item.parts.filter((p) => p.type === 'image' || p.type === 'document').length;
        return (
          <div key={item.id} data-testid="waiting-message" className="flex flex-col items-end gap-1.5">
            <div data-selectable className="max-w-[85%] rounded-2xl px-4 py-3 text-user-text break-words whitespace-pre-wrap text-fg-secondary inset-ring inset-ring-line">
              {text}
              {files > 0 && (
                <span className="mt-1 flex items-center gap-1 text-footnote text-fg-muted">
                  <Icon icon={FileText} className="size-3.5" />
                  {files === 1 ? '1 file' : `${files} files`}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 text-footnote text-fg-muted">
              <span className="mr-1">Waiting for the next step</span>
              <IconButton icon={X} label="Take back and edit" size="xs" onClick={() => actions.onTakeBack(item.id)} />
              <Button size="sm" variant="ghost" leadingIcon={CornerDownLeft} onClick={() => actions.onSendNow(item.id)}>
                Send now
              </Button>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Puts what was waiting back into the message box: the text on lines of its own, the files as attachments again. */
function putBack(parts: readonly Part[], composer: RefObject<ComposerHandle | null>, attachments: Attachments): void {
  const text = messageText(parts);
  if (text) composer.current?.append(text);
  attachments.restore([...parts]);
}

/**
 * The page's send, stop and the waiting messages' actions. While the agent works a message is queued (the backend
 * sends it plainly when the run ended meanwhile); Stop leaves nothing waiting and gives the texts back to the box.
 */
export function useSessionSend({
  sessionId,
  busy,
  outbox,
  attachments,
  composer,
  follow,
}: {
  sessionId: string;
  busy: boolean;
  outbox: readonly OutboxMessage[];
  attachments: Attachments;
  composer: RefObject<ComposerHandle | null>;
  follow(): void;
}) {
  const fail = (e: unknown) => toast.error(describeError(e).message);
  return {
    send(text: string) {
      const parts: Part[] = [...attachments.parts(), ...(text ? [{ type: 'text' as const, text }] : [])];
      attachments.clear();
      follow();
      void rpc()
        .call(busy ? 'chat.queue' : 'chat.send', { sessionId, parts })
        .catch(fail);
    },
    stop() {
      const waiting = outbox;
      void rpc()
        .call('chat.stop', { sessionId })
        .then(() => waiting.forEach((m) => putBack(m.parts, composer, attachments)))
        .catch(fail);
    },
    actions: {
      onTakeBack(id: string) {
        void rpc()
          .call('chat.unqueue', { sessionId, id })
          .then(({ parts }) => putBack(parts, composer, attachments))
          .catch(fail);
      },
      onSendNow(id: string) {
        void rpc().call('chat.sendNow', { sessionId, id }).catch(fail);
      },
    } satisfies OutboxActions,
  };
}
