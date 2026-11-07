/**
 * Co-op around the message box (design/components.md › Co-op): who is typing, the host's computer being away, what a
 * guest's message box says once it can't send, and a guest's model choice in the box's footer.
 */
import { Info, WifiOff, X } from 'lucide-react';
import type { ModelInfo } from '@atelier/protocol';
import { Icon, IconButton, cn } from '../../components/ui/index.ts';
import { showCoopNotice, type LiveSessionState } from '../../lib/live-session.ts';
import { useModels } from '../../lib/queries.ts';
import { possessive, typingLine, useTypingNames, type CoopView } from './coop.ts';

/**
 * "Ben is typing…" at the foot of the conversation, just above the message box. It floats over the column's bottom
 * padding, so the conversation doesn't move when someone starts or stops typing.
 */
export function CoopTyping({ live, coop, className }: { live: Pick<LiveSessionState, 'typing'>; coop: CoopView; className?: string }) {
  const names = useTypingNames(live.typing, coop);
  const line = typingLine(names);
  return (
    <div
      aria-live="polite"
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-1 mx-auto w-full max-w-[calc(var(--at-transcript-max)+48px)] truncate px-6 text-footnote text-fg-muted transition-opacity duration-(--at-duration-base) ease-standard max-md:px-4',
        !line && 'opacity-0',
        className,
      )}
    >
      {line}
    </div>
  );
}

/**
 * Above the message box: the host's computer being away (nothing is lost, it waits), or what the host's backend refused
 * last (a model the person may not use…), until dismissed.
 */
export function CoopBanner({ coop, live, className }: { coop: CoopView; live?: Pick<LiveSessionState, 'coopNotice'>; className?: string }) {
  if (!coop.shared || coop.ended) return null;
  const frame = cn('mx-auto mb-2 flex w-full items-center gap-2 rounded-lg bg-fill-ghost-hover py-1 pr-1 pl-2.5 text-footnote text-fg-secondary', className ?? 'max-w-(--at-layout-composer-width-chat)');
  return (
    <>
      {coop.hostAway && (
        <div role="status" className={frame}>
          <Icon icon={WifiOff} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 py-0.5">
            {possessive(coop.hostName)} computer is asleep or offline: the session continues when it’s back. Anything you send until then stays in the message box.
          </span>
        </div>
      )}
      {live?.coopNotice && (
        <div role="status" className={frame}>
          <Icon icon={Info} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">{live.coopNotice}</span>
          <IconButton icon={X} label="Dismiss" size="xs" className="text-current" onClick={() => coop.sessionId && showCoopNotice(coop.sessionId, null)} />
        </div>
      )}
    </>
  );
}

/** What a guest's message box says in place of the box when they can't send: co-op ended, or they watch. */
export function coopReadOnly(coop: CoopView): string | null {
  if (!coop.shared || coop.isHost) return null;
  if (coop.ended) return coop.state?.settings.guestsKeepCopy ? 'Co-op ended. Your copy is in your sidebar.' : 'Co-op ended.';
  if (coop.role === 'viewer') return `You’re watching. ${coop.hostName} decides who can chat.`;
  return null;
}

/** The model a guest's own messages are answered with, when it is one of theirs. */
export function useGuestModel(coop: CoopView): ModelInfo | undefined {
  const { data: models } = useModels();
  const me = coop.people.find((p) => p.id === coop.me);
  if (coop.isHost || !me || me.models !== 'own') return undefined;
  return models?.find((m) => m.ref === me.model);
}

/**
 * When a guest's own model has a smaller window than the conversation fills, it reads the newest part only: the
 * context popover says so.
 */
export function coopContextNote(coop: CoopView, own: ModelInfo | undefined, used: number | undefined): string | undefined {
  if (!coop.shared || coop.isHost || !own || used === undefined) return undefined;
  return own.contextLength < used ? 'Your model sees the newest part of the conversation.' : undefined;
}

/** The `/` commands a guest keeps: the rest (compact, loop, rewind, side chats) act on the host's session as the host. */
const GUEST_COMMANDS = new Set(['clear', 'model']);
export function coopCommands<C extends { name: string }>(coop: CoopView, commands: C[]): C[] {
  return coop.shared && !coop.isHost ? commands.filter((c) => GUEST_COMMANDS.has(c.name)) : commands;
}
