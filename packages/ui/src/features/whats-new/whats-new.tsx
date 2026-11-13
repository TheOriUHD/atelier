import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { APP } from '@atelier/protocol';
import { Badge, Button, Dialog, DialogContent, Icon } from '../../components/ui/index.ts';
import { solo } from '../../app/solo.ts';
import { rpc } from '../../lib/rpc.ts';
import { useReducedMotion } from '../../lib/motion.ts';
import { openExternal } from '../../lib/platform.ts';
import { usePrefs, useSetPref } from '../../lib/queries.ts';
import { MAX_VERSIONS, releaseNotesSince, type Highlight, type HighlightMedia, type ReleaseNotes } from './release-notes.ts';

const TITLE_ID = 'whats-new-title';
const isClip = (src: string) => /\.(mp4|webm)(?:[?#]|$)/i.test(src);

/** A feature's clip: silent and looping, playing only while it is in view; with reduced motion, still until played. */
function FeatureMedia({ media }: { media: HighlightMedia }) {
  const reduced = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (!el || reduced || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver(([entry]) => (entry?.isIntersecting ? void el.play().catch(() => {}) : el.pause()), { threshold: 0.35 });
    watch.observe(el);
    return () => watch.disconnect();
  }, [reduced]);
  const frame = 'block aspect-[16/10] w-full rounded-xl border border-line-subtle bg-sunken object-cover';
  if (!isClip(media.src)) return <img src={reduced && media.poster ? media.poster : media.src} alt={media.alt} loading="lazy" className={frame} />;
  return <video ref={video} src={media.src} poster={media.poster} aria-label={media.alt} muted loop playsInline preload="metadata" controls={reduced} className={frame} />;
}

/** A larger feature: its clip across the dialog's width, then what it is. */
function Feature({ item }: { item: Highlight & { media: HighlightMedia } }) {
  return (
    <li className="flex flex-col gap-3">
      <FeatureMedia media={item.media} />
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Icon icon={item.icon} size="md" />
        </span>
        <div className="min-w-0">
          <h3 className="text-section-heading text-fg">{item.title}</h3>
          <p className="mt-1 text-body text-fg-secondary">{item.body}</p>
        </div>
      </div>
    </li>
  );
}

/** One version's notes: its features first, then the other highlights, then the smaller changes. */
function VersionNotes({ notes, latest }: { notes: ReleaseNotes; latest: boolean }) {
  const features = notes.highlights.filter((h): h is Highlight & { media: HighlightMedia } => !!h.media);
  const others = notes.highlights.filter((h) => !h.media);
  return (
    <section aria-label={`Atelier ${notes.version}`} className={latest ? undefined : 'mt-6 border-t border-line-subtle pt-5'}>
      {!latest && (
        <header className="mb-4">
          <h2 className="flex items-center gap-2 text-body-strong text-fg">
            <Badge tone="neutral">{notes.version}</Badge>
          </h2>
          <p className="mt-1.5 text-body text-fg-secondary">{notes.intro}</p>
        </header>
      )}
      {features.length > 0 && (
        <ul className="mb-5 flex flex-col gap-6">
          {features.map((item) => (
            <Feature key={item.title} item={item} />
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className={features.length ? 'flex flex-col border-t border-line-subtle pt-3.5' : 'flex flex-col'}>
          {others.map((item) => (
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
      )}
      {notes.also.length > 0 && (
        <section aria-label={latest ? 'Also in this version' : `Also in ${notes.version}`} className="mt-2 border-t border-line-subtle pt-4">
          <h3 className="mb-2 text-footnote text-fg-muted">{latest ? 'Also in this version' : `Also in ${notes.version}`}</h3>
          <ul className="flex flex-col gap-1.5">
            {notes.also.map((line) => (
              <li key={line} className="relative pl-4 text-body text-fg-secondary before:absolute before:top-[0.6em] before:left-0.5 before:size-1 before:rounded-full before:bg-fg-muted">
                {line}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/**
 * What's new, as a dialog: the newest version first, then every earlier one since the person's last update (newest
 * first, at most MAX_VERSIONS in all; the full changelog has the rest). `notes` is newest first and never empty.
 */
export function WhatsNewDialog({ notes, open, onOpenChange }: { notes: readonly ReleaseNotes[]; open: boolean; onOpenChange(open: boolean): void }) {
  const shown = notes.slice(0, MAX_VERSIONS);
  const latest = shown[0];
  if (!latest) return null;
  const left = notes.length - shown.length;
  const wide = shown.some((n) => n.highlights.some((h) => h.media));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width={wide ? 720 : 600}
        // The top, not the buttons at the bottom: focus there would scroll the notes past their title.
        initialFocus={() => document.getElementById(TITLE_ID)}
        title={
          <span id={TITLE_ID} tabIndex={-1} className="flex items-center gap-2.5 outline-none">
            What’s new in Atelier
            <Badge tone="neutral">{latest.version}</Badge>
          </span>
        }
        description={latest.intro}
      >
        <VersionNotes notes={latest} latest />
        {shown.length > 1 && (
          <>
            {/* The versions in between, which the person skipped: each with its own notes, newest first. */}
            <h2 className="mt-7 -mb-2 text-footnote text-fg-muted">Also new since your last update</h2>
            {shown.slice(1).map((n) => (
              <VersionNotes key={n.version} notes={n} latest={false} />
            ))}
          </>
        )}
        {left > 0 && (
          <p className="mt-6 border-t border-line-subtle pt-4 text-body text-fg-secondary">
            And {left} earlier {left === 1 ? 'version' : 'versions'}: the full changelog has {left === 1 ? 'it' : 'them'}.
          </p>
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

/** What the sidebar's "What's new" shows: everything the latest update brought, as the dialog showed it. */
export function useWhatsNewNotes(): ReleaseNotes[] {
  const { prefs } = usePrefs();
  const whatsNew = prefs?.whatsNew;
  // Once this version's notes were seen, `from` is the version before it; before that, everything since `seen`.
  return releaseNotesSince(whatsNew?.seen === APP.version ? whatsNew.from : (whatsNew?.seen ?? null), APP.version);
}

/**
 * Shows what's new once, the first time a person opens a new version: everything since the version they had, newest
 * first. A new install has nothing to catch up on, so it only records the version; someone who already uses Atelier (they
 * have a conversation) sees the notes after an update. A version without notes, such as a development build, says
 * nothing. Reopened from the sidebar's More menu.
 */
export function WhatsNewHost() {
  const { prefs } = usePrefs();
  const setPref = useSetPref();
  const [open, setOpen] = useState(false);
  /** Closed in this window: not shown again until the next version, even if remembering it failed. */
  const [closed, setClosed] = useState(false);
  // An older server's preferences have no such part: nothing to remember the answer in, so nothing is shown.
  const seen = prefs?.whatsNew?.seen;
  const notes = releaseNotesSince(seen, APP.version);
  const has = notes.length > 0;
  const settled = seen === null || seen === undefined ? undefined : seen === APP.version;
  const used = useQuery({
    queryKey: ['whatsNew', 'used'],
    queryFn: async () => (await rpc().call('sessions.list', { archived: 'all', limit: 1 })).length > 0,
    enabled: has && !solo && seen === null,
    staleTime: Infinity,
  });
  // The version, then the one they came from (`from`), so the sidebar can show this update's notes again. Apart: a server
  // from before 0.7 refuses `from` as no preference of its own, and would refuse the version along with it, so the notes
  // came back every time the app read the preferences again.
  const record = () => {
    const from = seen ?? null;
    setPref.mutate({ path: ['whatsNew', 'seen'], value: APP.version }, { onSuccess: () => setPref.mutate({ path: ['whatsNew', 'from'], value: from }) });
  };

  useEffect(() => {
    if (!has || solo || settled || closed) return;
    if (seen === null) {
      if (used.data === undefined) return;
      if (!used.data) return void record();
    } else if (seen === undefined) return;
    const timer = setTimeout(() => setOpen(true), 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `record` only wraps the stable mutation
  }, [has, settled, closed, seen, used.data]);

  if (!has) return null;
  return (
    <WhatsNewDialog
      notes={notes}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next || settled) return;
        setClosed(true);
        record();
      }}
    />
  );
}
