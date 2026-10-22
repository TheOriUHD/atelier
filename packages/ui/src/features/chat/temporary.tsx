/** Temporary chats: the ghost toggle on the new-chat page, the strip that marks one, and the words that explain it. */
import { Ghost, X } from 'lucide-react';
import { APP, type TemporaryMode } from '@atelier/protocol';
import { Icon, IconButton, cn } from '../../components/ui/index.ts';
import { BrandMark } from '../../components/brand-mark.tsx';
import { openExternal } from '../../lib/platform.ts';
import { trafficLightInset, useSidebarHidden } from '../../app/chrome.tsx';

export const TEMPORARY_LEARN_MORE = `${APP.docs}/chat/#temporary-chats`;

/** What a temporary chat keeps and doesn't, for the mode the person chose in Settings › Privacy. */
export function temporaryExplanation(mode: TemporaryMode): string {
  return mode === 'fresh'
    ? 'Temporary chats stay out of your history and are deleted when you leave them. This one starts fresh: no memory, personal instructions or projects.'
    : 'Temporary chats stay out of your history and memory, and are deleted when you leave them.';
}

/**
 * Beside the window's own buttons on Windows and Linux: centred on their strip (`titlebar-area-height`, shorter than the
 * header) so it lines up with them; on macOS, where there is no such strip, on the header.
 */
export const TITLEBAR_ALIGNED = 'flex h-[env(titlebar-area-height,var(--at-layout-header-height))] items-center';

/** Top right of the new-chat page: switches between a new chat and a new temporary chat. */
export function TemporaryToggle({ on, onChange, className }: { on: boolean; onChange(on: boolean): void; className?: string }) {
  return (
    <span className={TITLEBAR_ALIGNED}>
      <IconButton
        icon={Ghost}
        label="Temporary chat"
        size="sm"
        iconSize="md"
        aria-pressed={on}
        className={cn('app-no-drag', on ? 'text-fg' : 'text-fg-secondary', className)}
        onClick={() => onChange(!on)}
      />
    </span>
  );
}

/** The window's top strip while in a temporary chat: always visible, so it is never mistaken for an ordinary one. */
export function TemporaryBar({ onLeave }: { onLeave(): void }) {
  const sidebarHidden = useSidebarHidden();
  return (
    <header
      aria-label="Temporary chat"
      className={cn(
        'app-drag relative flex h-(--at-layout-header-height) shrink-0 items-start justify-end bg-fill-primary pl-4 text-on-primary',
        'pr-[calc(var(--at-window-controls)+1rem)]',
        sidebarHidden && (trafficLightInset ? 'pl-[112px]' : 'pl-11'),
      )}
    >
      <span className={cn(TITLEBAR_ALIGNED, 'pointer-events-none absolute inset-x-0 justify-center gap-2 text-body font-medium select-none')}>
        <Icon icon={Ghost} />
        Temporary chat
      </span>
      <span className={TITLEBAR_ALIGNED}>
        <IconButton icon={X} label="Leave temporary chat" size="sm" className="app-no-drag relative text-on-primary hover:bg-on-primary/10" onClick={onLeave} />
      </span>
    </header>
  );
}

/** The new temporary chat's greeting: the mark and a serif heading, like the usual one. */
export function TemporaryHeading() {
  return (
    <h1 className="mb-[30px] flex items-center gap-3 font-chat text-greeting leading-10 text-fg max-md:my-auto">
      <BrandMark className="size-8" />
      You’re in a temporary chat
    </h1>
  );
}

/** Under the composer: what happens to this chat, and where to read more. */
export function TemporaryNote({ mode, className }: { mode: TemporaryMode; className?: string }) {
  return (
    <p className={cn('mx-auto max-w-[480px] text-center text-footnote text-fg-muted', className)}>
      {temporaryExplanation(mode)}{' '}
      <button type="button" onClick={() => openExternal(TEMPORARY_LEARN_MORE)} className="rounded-xs text-interactive-text outline-none focus-ring hover:underline">
        Learn more
      </button>
    </p>
  );
}
