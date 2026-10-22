/**
 * A passage of an earlier message that a reply quotes: a bar down its left side and the text, in the composer (with a
 * remove button) and above the sent message (without).
 */
import { X } from 'lucide-react';
import { Icon, cn } from '../../components/ui/index.ts';

/** In the composer: a small card next to the files, removable. */
export function QuoteTile({ text, onRemove }: { text: string; onRemove(): void }) {
  return (
    <div
      role="group"
      aria-label="Quoted text"
      className="group/tile relative flex max-h-[120px] min-h-14 w-[200px] shrink-0 gap-2.5 self-start overflow-hidden rounded-xl bg-bg p-3 inset-ring inset-ring-line"
    >
      <span aria-hidden className="w-0.5 shrink-0 self-stretch rounded-full bg-fg-muted/40" />
      <p className="line-clamp-5 min-w-0 text-body break-words text-fg-secondary">{text}</p>
      <button
        type="button"
        aria-label="Remove quoted text"
        onClick={onRemove}
        className="absolute top-1.5 right-1.5 hidden size-6 items-center justify-center rounded-full bg-popover text-fg-secondary shadow-sm outline-none group-hover/tile:flex focus-visible:flex focus-ring"
      >
        <Icon icon={X} size="sm" className="size-3.5" />
      </button>
    </div>
  );
}

/** In the transcript: above the message that replied. */
export function QuoteBlock({ text, className }: { text: string; className?: string }) {
  return (
    <div role="group" aria-label="Quoted text" className={cn('flex max-w-[85%] gap-2.5 text-body text-fg-secondary', className)}>
      <span aria-hidden className="w-0.5 shrink-0 self-stretch rounded-full bg-fg-muted/40" />
      <p className="line-clamp-4 min-w-0 break-words whitespace-pre-wrap">{text}</p>
    </div>
  );
}
