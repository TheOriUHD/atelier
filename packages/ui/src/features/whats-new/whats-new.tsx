import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { APP } from '@atelier/protocol';
import { Badge, Button, Dialog, DialogContent, Icon } from '../../components/ui/index.ts';
import { solo } from '../../app/solo.ts';
import { rpc } from '../../lib/rpc.ts';
import { openExternal } from '../../lib/platform.ts';
import { usePrefs, useSetPref } from '../../lib/queries.ts';
import { releaseNotesFor, type ReleaseNotes } from './release-notes.ts';

const TITLE_ID = 'whats-new-title';

/** The release notes of one version, as a dialog. */
export function WhatsNewDialog({ notes, open, onOpenChange }: { notes: ReleaseNotes; open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width={600}
        // The top, not the buttons at the bottom: focus there would scroll the notes past their title.
        initialFocus={() => document.getElementById(TITLE_ID)}
        title={
          <span id={TITLE_ID} tabIndex={-1} className="flex items-center gap-2.5 outline-none">
            What’s new in Atelier
            <Badge tone="neutral">{notes.version}</Badge>
          </span>
        }
        description={notes.intro}
      >
        <ul className="flex flex-col">
          {notes.highlights.map((item) => (
            <li key={item.title} className="flex gap-3.5 border-t border-line-subtle py-3.5 first:border-t-0 first:pt-0">
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                <Icon icon={item.icon} size="md" />
              </span>
              <div className="min-w-0">
                <h3 className="text-body-strong text-fg">{item.title}</h3>
                <p className="mt-1 text-body text-fg-secondary">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
        {notes.also.length > 0 && (
          <section aria-label="Also in this version" className="mt-2 border-t border-line-subtle pt-4">
            <h3 className="mb-2 text-footnote text-fg-muted">Also in this version</h3>
            <ul className="flex flex-col gap-1.5">
              {notes.also.map((line) => (
                <li key={line} className="relative pl-4 text-body text-fg-secondary before:absolute before:top-[0.6em] before:left-0.5 before:size-1 before:rounded-full before:bg-fg-muted">
                  {line}
                </li>
              ))}
            </ul>
          </section>
        )}
        {/* Stays in view while the notes scroll under it. */}
        <div className="sticky -bottom-6 -mx-6 -mb-6 mt-4 flex items-center justify-between gap-3 border-t border-line-subtle bg-popover px-6 py-4">
          <Button variant="ghost" trailingIcon={ArrowUpRight} onClick={() => openExternal(APP.changelog)}>
            Full changelog
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shows this version's release notes once, the first time a person opens it. A new install has nothing to catch up on, so
 * it only records the version; someone who already uses Atelier (they have a conversation) sees the notes after an update.
 * A version without notes, such as a development build, says nothing. Reopened from the sidebar's More menu.
 */
export function WhatsNewHost() {
  const notes = releaseNotesFor(APP.version);
  const { prefs } = usePrefs();
  const setPref = useSetPref();
  const [open, setOpen] = useState(false);
  // An older server's preferences have no such part: nothing to remember the answer in, so nothing is shown.
  const seen = prefs?.whatsNew?.seen;
  const settled = seen === null || seen === undefined ? undefined : seen === APP.version;
  const used = useQuery({
    queryKey: ['whatsNew', 'used'],
    queryFn: async () => (await rpc().call('sessions.list', { archived: 'all', limit: 1 })).length > 0,
    enabled: !!notes && !solo && seen === null,
    staleTime: Infinity,
  });
  const record = () => setPref.mutate({ path: ['whatsNew', 'seen'], value: APP.version });

  useEffect(() => {
    if (!notes || solo || settled) return;
    if (seen === null) {
      if (used.data === undefined) return;
      if (!used.data) return void record();
    } else if (seen === undefined) return;
    const timer = setTimeout(() => setOpen(true), 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `record` only wraps the stable mutation
  }, [notes, settled, seen, used.data]);

  if (!notes) return null;
  return (
    <WhatsNewDialog
      notes={notes}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) record();
      }}
    />
  );
}
