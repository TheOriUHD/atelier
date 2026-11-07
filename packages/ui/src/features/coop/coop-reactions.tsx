/**
 * Reactions in a co-op session (design/components.md › Co-op): small emoji pills under a message, each with how many
 * put it there, and a button among the message's actions to add one. Everyone in the session may react, those who
 * watch too.
 */
import { SmilePlus } from 'lucide-react';
import { REACTIONS } from '@atelier/protocol';
import { IconButton, Popover, PopoverContent, PopoverTrigger, cn } from '../../components/ui/index.ts';
import { rpc } from '../../lib/rpc.ts';
import { reportError, useCoopView } from './coop.ts';

export type Reaction = { emoji: string; participants: string[] };

function react(sessionId: string, messageId: string, emoji: string, on: boolean) {
  void rpc()
    .call('chat.react', { sessionId, messageId, emoji, on })
    .catch((e: unknown) => reportError(sessionId, e));
}

/** The pills: the emoji and a count, ringed in blue where the viewer is one of them; a click adds or takes theirs. */
export function ReactionPills({ sessionId, messageId, reactions, align = 'start' }: { sessionId: string; messageId: string; reactions: readonly Reaction[] | undefined; align?: 'start' | 'end' }) {
  const coop = useCoopView();
  if (!coop.shared || !reactions?.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', align === 'end' && 'justify-end')}>
      {reactions.map((r) => {
        const mine = !!coop.me && r.participants.includes(coop.me);
        const names = r.participants.map((id) => (id === coop.me ? 'You' : coop.person(id).name)).join(', ');
        return (
          <button
            key={r.emoji}
            type="button"
            aria-pressed={mine}
            aria-label={`${r.emoji} ${r.participants.length}: ${names}`}
            title={names}
            onClick={() => react(sessionId, messageId, r.emoji, !mine)}
            className={cn(
              'flex h-6 items-center gap-1 rounded-full px-2 text-caption text-fg-secondary tabular-nums outline-none focus-ring inset-ring hover:bg-fill-ghost-hover',
              mine ? 'bg-interactive-subtle text-interactive-text inset-ring-interactive/40' : 'inset-ring-line',
            )}
          >
            <span aria-hidden>{r.emoji}</span>
            <span aria-hidden>{r.participants.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Among a message's actions: the emoji to put on it (or take off, for one the viewer put there). */
export function ReactButton({ sessionId, messageId, reactions }: { sessionId: string; messageId: string; reactions: readonly Reaction[] | undefined }) {
  const coop = useCoopView();
  if (!coop.shared || coop.ended) return null;
  const mine = (emoji: string) => !!coop.me && !!reactions?.some((r) => r.emoji === emoji && r.participants.includes(coop.me!));
  return (
    <Popover>
      <PopoverTrigger render={<IconButton icon={SmilePlus} label="React" size="xs" />} />
      <PopoverContent side="top" align="start" aria-label="React" className="flex gap-0.5 p-1">
        {REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={emoji}
            aria-pressed={mine(emoji)}
            onClick={() => react(sessionId, messageId, emoji, !mine(emoji))}
            className="flex size-8 items-center justify-center rounded-lg text-[18px] outline-none focus-ring hover:bg-fill-ghost-hover aria-pressed:bg-fill-ghost-selected"
          >
            {emoji}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
