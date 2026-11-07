/**
 * Messages sent while the agent works: each shows as waiting at the end of the conversation, joins it
 * at the agent's next step, and can be taken back (its text returns to the message box) or sent now, which interrupts
 * the step in progress; the agent carries on from there.
 *
 * In co-op (design/components.md › Co-op) each shows its author. A turn takes its own author's messages; the others'
 * wait for turns of their own, unless their author asks them to join the one that runs. Only the author takes one back
 * (the host may remove anyone's).
 */
import type { RefObject } from 'react';
import { CornerDownLeft, FileText, Merge, X } from 'lucide-react';
import { messageText, type OutboxMessage, type Part } from '@atelier/protocol';
import { Button, Icon, IconButton } from '../../components/ui/index.ts';
import { rpc } from '../../lib/rpc.ts';
import { Avatar } from '../coop/avatar.tsx';
import { reportError, useCoopView, wroteIt, type CoopView } from '../coop/coop.ts';
import { answerWithName } from '../coop/coop-models.tsx';
import { useModels } from '../../lib/queries.ts';
import type { ComposerHandle } from './composer.tsx';
import type { Attachments } from './use-attachments.ts';

/** What a waiting message's actions do; the page owns the message box they put text back into. */
export interface OutboxActions {
  onTakeBack(id: string): void;
  onSendNow(id: string): void;
  /** Co-op: the viewer's message joins the turn running for someone else instead of waiting for its own. */
  onJoinTurn?(id: string): void;
  /** Co-op, the host: takes someone else's waiting message away (it doesn't come into the host's message box). */
  onRemove?(id: string): void;
}

/**
 * `turnFor`: whom the running turn is for (co-op), so a message knows whether it joins that turn or waits for its own.
 */
export function Outbox({ items, actions, turnFor = null }: { items: readonly OutboxMessage[]; actions: OutboxActions; turnFor?: string | null }) {
  const coop = useCoopView();
  if (!items.length) return null;
  return (
    <>
      {items.map((item) => {
        const text = messageText(item.parts);
        const files = item.parts.filter((p) => p.type === 'image' || p.type === 'document').length;
        const author = coop.shared ? coop.person(item.author) : null;
        return (
          <div key={item.id} data-testid="waiting-message" className="flex flex-col items-end gap-1.5">
            {author && <WaitingAuthor name={author.me ? 'You' : author.name} avatar={author.avatar} answerWith={item.answerWith} />}
            <div data-selectable className="max-w-[85%] rounded-2xl px-4 py-3 text-user-text break-words whitespace-pre-wrap text-fg-secondary inset-ring inset-ring-line">
              {text}
              {files > 0 && (
                <span className="mt-1 flex items-center gap-1 text-footnote text-fg-muted">
                  <Icon icon={FileText} className="size-3.5" />
                  {files === 1 ? '1 file' : `${files} files`}
                </span>
              )}
            </div>
            {coop.shared ? <CoopWaiting item={item} coop={coop} turnFor={turnFor} actions={actions} /> : (
              <div className="flex items-center gap-1 text-footnote text-fg-muted">
                <span className="mr-1">Waiting for the next step</span>
                <IconButton icon={X} label="Take back and edit" size="xs" onClick={() => actions.onTakeBack(item.id)} />
                <Button size="sm" variant="ghost" leadingIcon={CornerDownLeft} onClick={() => actions.onSendNow(item.id)}>
                  Send now
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** A co-op message's author: avatar 16 and name, 12 muted, above the bubble; `detail` after it ("asked for GPT-6"). */
export function AuthorLabel({ name, avatar, detail }: { name: string; avatar: string | null; detail?: string }) {
  return (
    <span className="flex max-w-[85%] items-center gap-1.5 text-caption text-fg-muted">
      <Avatar name={name} avatar={avatar} size="xs" />
      <span className="truncate">
        {name}
        {detail && ` · ${detail}`}
      </span>
    </span>
  );
}

/** A co-op waiting message's author, and the model it asked for. */
function WaitingAuthor({ name, avatar, answerWith }: { name: string; avatar: string | null; answerWith: string | undefined }) {
  const { data: models } = useModels();
  const coop = useCoopView();
  return <AuthorLabel name={name} avatar={avatar} {...(answerWith ? { detail: `asks for ${answerWithName(answerWith, models, coop.state?.hostModels)}` } : {})} />;
}

/** What a waiting message says in co-op, and what the viewer may do with it. */
function CoopWaiting({ item, coop, turnFor, actions }: { item: OutboxMessage; coop: CoopView; turnFor: string | null; actions: OutboxActions }) {
  const mine = wroteIt(item, coop);
  const author = item.author ?? coop.hostId;
  // The running turn takes it at its next step: its own author's, or one asked to join.
  const joins = !!item.joinTurn || (turnFor !== null && author === turnFor);
  const label = joins ? (item.joinTurn && author !== turnFor ? 'Joins this turn at its next step' : 'Waiting for the next step') : mine ? 'Waits for its own turn' : `Waits for ${coop.person(item.author).name}’s turn`;
  return (
    <div className="flex items-center gap-1 text-footnote text-fg-muted">
      <span className="mr-1">{label}</span>
      {mine && <IconButton icon={X} label="Take back and edit" size="xs" onClick={() => actions.onTakeBack(item.id)} />}
      {!mine && coop.isHost && actions.onRemove && <IconButton icon={X} label="Remove" size="xs" onClick={() => actions.onRemove!(item.id)} />}
      {mine && !joins && actions.onJoinTurn && (
        <Button size="sm" variant="ghost" leadingIcon={Merge} onClick={() => actions.onJoinTurn!(item.id)}>
          Join this turn
        </Button>
      )}
      {mine && joins && !item.joinTurn && (
        <Button size="sm" variant="ghost" leadingIcon={CornerDownLeft} onClick={() => actions.onSendNow(item.id)}>
          Send now
        </Button>
      )}
    </div>
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
 * sends it plainly when the run ended meanwhile); Stop leaves nothing waiting and gives the texts back to the box. In
 * co-op a message is always queued (someone else's turn may be running), Stop gives back only the viewer's own, and
 * one the host's computer couldn't take (it is away) goes back into the box.
 */
export function useSessionSend({
  sessionId,
  busy,
  outbox,
  attachments,
  composer,
  follow,
  coop,
}: {
  sessionId: string;
  busy: boolean;
  outbox: readonly OutboxMessage[];
  attachments: Attachments;
  composer: RefObject<ComposerHandle | null>;
  follow(): void;
  coop?: Pick<CoopView, 'shared' | 'me' | 'hostId' | 'isHost'>;
}) {
  const fail = (e: unknown) => reportError(sessionId, e);
  const shared = !!coop?.shared;
  return {
    send(text: string, options: { answerWith?: string } = {}) {
      const parts: Part[] = [...attachments.parts(), ...(text ? [{ type: 'text' as const, text }] : [])];
      attachments.clear();
      follow();
      void rpc()
        .call(busy || shared ? 'chat.queue' : 'chat.send', { sessionId, parts, ...(options.answerWith ? { answerWith: options.answerWith } : {}) })
        .catch((e: unknown) => {
          // Nothing is lost: what couldn't be sent goes back into the box.
          if (shared) putBack(parts, composer, attachments);
          fail(e);
        });
    },
    stop() {
      const waiting = coop?.shared ? outbox.filter((m) => wroteIt(m, coop)) : outbox;
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
      onJoinTurn(id: string) {
        // A guest's Send now joins the turn that runs for someone else; the host's would cut it off, so the host's
        // message is queued again, asking to join.
        if (!coop?.isHost) return void rpc().call('chat.sendNow', { sessionId, id }).catch(fail);
        void rpc()
          .call('chat.unqueue', { sessionId, id })
          .then(({ parts }) => (parts.length ? rpc().call('chat.queue', { sessionId, parts, joinTurn: true }) : undefined))
          .catch(fail);
      },
      onRemove(id: string) {
        void rpc().call('chat.unqueue', { sessionId, id }).catch(fail);
      },
    } satisfies OutboxActions,
  };
}
