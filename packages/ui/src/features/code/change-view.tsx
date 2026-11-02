/**
 * ChangeView (design/components.md › Code and Work): a permission card's change in the whole file, over the app, scrolled
 * to the change. The file comes from `chat.changePreview`, read when it opens, so it works wherever the session's
 * folder is. The card stays mounted behind it and keeps its keys; `children` are its actions.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ChangePreview } from '@atelier/protocol';
import { IconButton, Spinner, cn } from '../../components/ui/index.ts';
import { dialogBackdropClass, dialogPopupClass } from '../../components/ui/styles.ts';
import { rpc } from '../../lib/rpc.ts';
import { InlineDiff, type DiffRow } from './inline-diff.tsx';

const CHANGE_ONLY = 'so this is only the change.';
const NOTES: Partial<Record<ChangePreview['state'], string>> = {
  new: 'A new file.',
  binary: `This is a binary file, ${CHANGE_ONLY}`,
  tooLarge: `This file is too large to read, ${CHANGE_ONLY}`,
  unreadable: `This file can’t be read from here, ${CHANGE_ONLY}`,
  stale: `The text to replace isn’t in the file as it is now, ${CHANGE_ONLY}`,
};

/** The file, brought to the change when it first shows: only here is it certain to be in the page, the dialog's portal comes a step later. */
function FileRows({ rows, language }: { rows: DiffRow[]; language: string }) {
  const file = useRef<HTMLDivElement>(null);
  useEffect(() => {
    file.current?.querySelector('[data-kind="remove"], [data-kind="add"]')?.scrollIntoView({ block: 'center' });
  }, []);
  return (
    <div ref={file}>
      <InlineDiff rows={rows} language={language} lineNumbers={rows.some((r) => r.line !== undefined)} className="overflow-x-visible" />
    </div>
  );
}

export function ChangeView({
  sessionId,
  interactionId,
  title,
  language,
  change,
  onClose,
  children,
}: {
  sessionId: string;
  interactionId: string;
  title: string;
  language: string;
  /** What the card shows, for a file that can't be: the card's question stands either way. */
  change: DiffRow[];
  onClose(): void;
  children: ReactNode;
}) {
  // Fresh each time it opens: the point is the file as it is now, and an answered card has nothing to keep.
  const preview = useQuery({ queryKey: ['changePreview', sessionId, interactionId], queryFn: () => rpc().call('chat.changePreview', { sessionId, interactionId }), gcTime: 0, retry: false });
  const scroller = useRef<HTMLDivElement>(null);
  const rows = preview.data?.rows.length ? preview.data.rows : change;
  const note = preview.isError ? NOTES.unreadable : preview.data && NOTES[preview.data.state];

  return (
    <BaseDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={dialogBackdropClass} />
        <BaseDialog.Popup
          data-ask-view
          // Focus on the code, never a button: arrow keys read on, and an Enter can't approve anything.
          initialFocus={scroller}
          className={cn(
            dialogPopupClass,
            'flex h-dvh w-screen flex-col overflow-hidden',
            'max-md:inset-0 max-md:size-full max-md:max-h-none max-md:max-w-none max-md:translate-0 max-md:rounded-none max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:ring-0',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
            <div className="flex min-w-0 flex-col gap-1">
              <BaseDialog.Title className="text-section-heading break-words text-fg">{title}</BaseDialog.Title>
              {note && <p className="text-footnote text-fg-muted">{note}</p>}
            </div>
            <BaseDialog.Close render={<IconButton icon={X} label="Close" iconSize="md" className="shrink-0" />} />
          </div>
          {/* One scroller for both directions: a file's sideways scrollbar shouldn't wait at its last line. There from the start, as focus goes here on opening. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <div ref={scroller} tabIndex={0} role="group" aria-label="The file with the change" className="min-h-0 flex-1 overflow-auto bg-code-background outline-none focus-visible:shadow-focus">
            {preview.isPending ? (
              <div className="flex h-full items-center justify-center text-fg-muted">
                <Spinner label="Reading the file" />
              </div>
            ) : (
              <FileRows rows={rows} language={language} />
            )}
          </div>
          <div className="flex flex-col gap-3 border-t border-line px-4 py-3">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
