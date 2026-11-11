/**
 * design/components.md › LiveView: what computer use is looking at while a task works in an app or a web page. The
 * latest screenshot of that window or tab, what it is doing right now, ✕ to hide it (the task goes on) and, in the
 * desktop app, pop-out into a small window that stays on top of the others, as ChatGPT's live view does.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Eye, PictureInPicture2, X } from 'lucide-react';
import type { Message } from '@atelier/protocol';
import { asRecord, computerActions } from '@atelier/client/tools.ts';
import { Icon, IconButton, Lightbox, cn } from '../../components/ui/index.ts';
import { useLiveSession } from '../../lib/live-session.ts';
import { blobUrl, desktop } from '../../lib/platform.ts';
import { latestRun } from './output-files.ts';

/** Tools whose results can carry a picture of the window or tab. */
const SCREEN_TOOLS = new Set(['Screenshot', 'ComputerAction', 'OpenApp', 'Browser']);
/** Steps of computer use, for what it is doing now. */
const COMPUTER_TOOLS = new Set([...SCREEN_TOOLS, 'ComputerAccess', 'FullControl']);

export interface LiveScreen {
  blob: string;
  mime: string;
  /** The app or page: "Calculator", "Amazon.de: Cart". Null before any screenshot said. */
  title: string | null;
  /** The step running now ("Clears the calculator"); null between steps. */
  doing: string | null;
}

/** The app of "Calculator’s window “Calculator”", the page of "Tab 3 · Cart · https://…", "Your screen" for a display. */
export function screenTitle(tool: string, text: string): string | null {
  if (tool === 'Browser') {
    const page = /^Tab \S+ · (.+?) · \S+/.exec(text);
    return page ? page[1]! : null;
  }
  const shot = /Screenshot of (.+?), \d+×\d+ pixels/.exec(text);
  if (!shot) return null;
  const window = /^(.+?)’s window/.exec(shot[1]!);
  return window ? window[1]! : 'Your screen';
}

const BROWSER_DOING: Record<string, string> = {
  open: 'Opening a page',
  navigate: 'Going to a page',
  back: 'Going back',
  read: 'Reading the page',
  find: 'Looking through the page',
  click: 'Clicking in the page',
  type: 'Typing in the page',
  key: 'Pressing a key in the page',
  scroll: 'Scrolling the page',
  select: 'Choosing from a list',
  screenshot: 'Looking at the page',
};

/** What a step does, in a few words: the first summary the model gave a batch, or what the tool does. */
export function stepText(name: string, input: unknown): string | null {
  const args = asRecord(input);
  switch (name) {
    case 'ComputerAction': {
      const summary = computerActions(input).map((a) => (typeof a.summary === 'string' ? a.summary.trim() : '')).find(Boolean);
      return summary ?? 'Working in the app';
    }
    case 'OpenApp':
      return typeof args.app === 'string' ? `Opening ${args.app}` : 'Opening an app';
    case 'Screenshot':
      return 'Looking at the window';
    case 'Browser':
      return BROWSER_DOING[String(args.action)] ?? null;
    default:
      return null;
  }
}

/** The latest picture computer use took in `messages` (one run), what it shows and the step running now. */
export function liveScreen(messages: readonly Message[]): LiveScreen | null {
  const calls = new Map<string, { name: string; input: unknown }>();
  const answered = new Set<string>();
  let image: { blob: string; mime: string } | null = null;
  let title: string | null = null;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_call') calls.set(part.id, { name: part.name, input: part.input });
      else if (part.type === 'tool_result') {
        answered.add(part.callId);
        const call = calls.get(part.callId);
        if (!call || !SCREEN_TOOLS.has(call.name) || part.isError) continue;
        const shot = part.content.findLast((c) => c.type === 'image');
        const text = part.content.find((c) => c.type === 'text')?.text ?? '';
        title = screenTitle(call.name, text) ?? title;
        if (shot?.type === 'image') image = { blob: shot.blob, mime: shot.mime };
      }
    }
  }
  if (!image) return null;
  const pending = [...calls].findLast(([id, call]) => !answered.has(id) && COMPUTER_TOOLS.has(call.name));
  return { ...image, title, doing: pending ? stepText(pending[1].name, pending[1].input) : null };
}

const hiddenKey = (sessionId: string) => `atelier.liveView.hidden.${sessionId}`;

function readHidden(sessionId: string): boolean {
  try {
    return sessionStorage.getItem(hiddenKey(sessionId)) === '1';
  } catch {
    return false;
  }
}

function writeHidden(sessionId: string, hidden: boolean): void {
  try {
    if (hidden) sessionStorage.setItem(hiddenKey(sessionId), '1');
    else sessionStorage.removeItem(hiddenKey(sessionId));
  } catch {
    // Without storage it is hidden for this page only.
  }
}

/** Beside the task while it runs: the window or tab it works in, as it last looked. */
export function LiveView({ sessionId, messages, running }: { sessionId: string; messages: readonly Message[]; running: boolean }) {
  const screen = useMemo(() => (running ? liveScreen(latestRun(messages)) : null), [messages, running]);
  const [hidden, setHidden] = useState(() => readHidden(sessionId));
  const [zoomed, setZoomed] = useState<number | null>(null);
  if (!screen) return null;
  const hide = (value: boolean) => {
    writeHidden(sessionId, value);
    setHidden(value);
  };
  if (hidden) {
    return (
      <button type="button" onClick={() => hide(false)} className="-mx-1.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-footnote text-fg-muted outline-none hover:bg-fill-ghost-hover hover:text-fg focus-ring">
        <Icon icon={Eye} size="sm" />
        Show what it sees
      </button>
    );
  }
  const src = blobUrl(screen.blob);
  return (
    <section aria-label="Live view" className="flex flex-col gap-1.5">
      <h2 className="flex h-5 items-center justify-between gap-2 text-footnote text-fg-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          <span className="truncate">{screen.title ?? 'Live'}</span>
        </span>
        <span className="-mr-1.5 flex shrink-0 items-center">
          {desktop?.openLiveView && <IconButton icon={PictureInPicture2} label="Pop out" size="xs" onClick={() => void desktop?.openLiveView?.(sessionId)} />}
          <IconButton icon={X} label="Hide (the task goes on)" size="xs" onClick={() => hide(true)} />
        </span>
      </h2>
      <button type="button" onClick={() => setZoomed(0)} aria-label="Open the latest screenshot" className="overflow-hidden rounded-lg border border-line bg-fill-ghost-hover outline-none cursor-zoom-in focus-ring">
        <img src={src} alt="" className="block max-h-[220px] w-full object-contain" />
      </button>
      <p aria-live="polite" className={cn('truncate text-footnote', screen.doing ? 'text-fg-secondary' : 'text-fg-muted')}>
        {screen.doing ?? 'Thinking about the next step'}
      </p>
      <Lightbox images={[{ src, alt: screen.title ? `${screen.title}, as computer use last saw it` : 'The latest screenshot' }]} index={zoomed} onIndexChange={setZoomed} />
    </section>
  );
}

/** The popped-out window (`#/live/<id>?solo=1`): the picture alone, filling a small window that stays on top. */
export function LiveViewPage() {
  const { sessionId } = useParams({ from: '/live/$sessionId' });
  const live = useLiveSession(sessionId);
  const running = live.session?.status === 'running' || live.session?.status === 'waiting';
  const screen = useMemo(() => liveScreen(latestRun(live.messages)), [live.messages]);
  useEffect(() => {
    document.title = screen?.title ? `${screen.title} — Atelier` : 'Live view — Atelier';
  }, [screen?.title]);
  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* The strip at the top moves the window; the traffic lights sit at its left on a Mac. */}
      <div className="flex h-9 shrink-0 items-center gap-2 pr-3 pl-[78px] text-footnote [-webkit-app-region:drag]">
        {running && <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
        <span className="truncate text-fg-secondary">{screen?.title ?? 'Live view'}</span>
        <span className="ml-auto shrink-0 truncate text-fg-muted">{running ? (screen?.doing ?? '') : 'Finished'}</span>
      </div>
      <div className="relative min-h-0 flex-1 bg-fill-ghost-hover">
        {screen ? (
          <img src={blobUrl(screen.blob)} alt={screen.title ? `${screen.title}, as computer use last saw it` : 'The latest screenshot'} className="absolute inset-0 size-full object-contain" />
        ) : (
          <p className="flex h-full items-center justify-center px-6 text-center text-body text-fg-muted">The window it works in shows here once it takes a look.</p>
        )}
      </div>
    </div>
  );
}
