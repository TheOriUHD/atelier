/**
 * The Browser pane (design/components.md › Code panes; desktop app only): local dev servers and docs in tabs beside the
 * conversation. Each tab is an Electron `<webview>` — a separate, sandboxed page in its own persistent session, which
 * the main process hardens as it attaches (apps/desktop/src/browser.ts) — so menus and popovers still draw over it.
 * Links that open a new window open a tab here; downloads are refused. Pages can only be http(s), or a workspace's
 * files the app serves to the pane (Files › Open in Browser pane; workspace-pages.ts).
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ExternalLink, Globe, Plus, RotateCw, X } from 'lucide-react';
import { Icon, IconButton, MenuItem, TextField, cn, toast } from '../../components/ui/index.ts';
import { desktop } from '../../lib/platform.ts';
import { PaneFrame, type PaneFrameState } from './pane-dock.tsx';

/** The partition the main process gives every Browser pane page (it enforces it, whatever is asked). */
export const BROWSER_PARTITION = 'persist:atelier-browser';

/** What the pane uses of Electron's `<webview>` element. */
interface WebviewElement extends HTMLElement {
  src: string;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  goBack(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  getWebContentsId(): number;
}

interface Tab {
  id: number;
  /** What the address field shows: the page's URL, or what was typed. */
  url: string;
  /** The address the tab's page started at; null until the first one is entered. */
  page: string | null;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  /** Why the page didn't load, if it didn't. */
  error: string | null;
}

/** The desktop app's scheme for workspace files (apps/desktop/src/workspace-pages.ts). */
const PAGES_PREFIX = 'atelier-files://';

/** Pages asked for from elsewhere (the Files pane), waiting for the session's Browser pane to open them. */
export class BrowserPages {
  private items: string[] = [];
  private listeners = new Set<() => void>();

  push(url: string): void {
    this.items.push(url);
    for (const listener of [...this.listeners]) listener();
  }

  /** What waits, oldest first; it is not kept after. */
  take(): string[] {
    return this.items.splice(0);
  }

  /** Pages pushed before the pane opened are announced just after it subscribes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.items.length) queueMicrotask(() => this.listeners.has(listener) && listener());
    return () => this.listeners.delete(listener);
  }
}

/**
 * What was typed in the address field as a URL: http(s), or a workspace file's address as the pane showed it. Local addresses (`localhost:3000`, `*.test`) get http,
 * anything else that looks like a host gets https. Null for anything that can't be a web address.
 */
export function addressUrl(typed: string): string | null {
  const text = typed.trim();
  if (!text || /\s/.test(text)) return null;
  if (text.startsWith(PAGES_PREFIX)) return /^atelier-files:\/\/[\w-]+\//.test(text) && URL.canParse(text) ? text : null;
  if (/^https?:\/\//i.test(text)) return URL.canParse(text) ? new URL(text).toString() : null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return null;
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|[\w-]+(\.[\w-]+)*\.(localhost|test))(:\d+)?(\/|$)/i.test(text) || /^:\d+/.test(text);
  if (!local && !/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(text)) return null;
  const url = `${local ? 'http' : 'https'}://${text.startsWith(':') ? `localhost${text}` : text}`;
  return URL.canParse(url) ? new URL(url).toString() : null;
}

/** Tabs the pane holds; more are refused with a notice (pages can open them in a loop). */
const MAX_TABS = 20;

const blank = (id: number, url = ''): Tab => ({ id, url, page: url || null, title: url || 'New tab', favicon: null, loading: !!url, canGoBack: false, error: null });

export function BrowserPane({ frame, pages }: { frame: PaneFrameState; pages?: BrowserPages }) {
  const [tabs, setTabs] = useState<Tab[]>(() => [blank(1)]);
  const [active, setActive] = useState(1);
  const views = useRef(new Map<number, WebviewElement>());
  const address = useRef<HTMLInputElement>(null);
  const nextId = useRef(2);
  const current = tabs.find((t) => t.id === active) ?? tabs[0]!;
  const update = (id: number, patch: Partial<Tab>) => setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  // Tabs as of the last render, plus those opened since (pages can ask for several at once).
  const count = useRef(tabs.length);
  useLayoutEffect(() => {
    count.current = tabs.length;
  }, [tabs.length]);
  const openTab = (url = '') => {
    if (count.current >= MAX_TABS) return void toast(`The Browser pane holds up to ${MAX_TABS} tabs; close one to open another.`, { id: 'browser-tabs' });
    count.current++;
    const id = nextId.current++;
    setTabs((list) => [...list, blank(id, url)]);
    setActive(id);
    if (!url) requestAnimationFrame(() => address.current?.focus());
  };
  const closeTab = (id: number) => {
    const at = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) return frame.close();
    setTabs(rest);
    if (active === id) setActive(rest[Math.max(0, at - 1)]!.id);
  };

  // Pages asked for from elsewhere: the first in the tab shown if it is empty, the rest in new tabs.
  const openPages = (urls: string[]) => {
    for (const [i, url] of urls.entries()) {
      if (i === 0 && !current.page) update(current.id, { url, page: url, title: url, error: null, loading: true });
      else openTab(url);
    }
  };

  const opener = useRef(openTab);
  const pageOpener = useRef(openPages);
  useLayoutEffect(() => {
    opener.current = openTab;
    pageOpener.current = openPages;
  });
  useEffect(() => pages?.subscribe(() => pageOpener.current(pages.take())), [pages]);
  // Pages that open a new window (target=_blank, window.open) get a tab here instead; downloads are refused.
  useEffect(() => {
    if (!desktop?.browser) return;
    // A page that hasn't loaded yet has no id to ask for (Electron throws): it can't be the one asking.
    const idOf = (v: WebviewElement) => {
      try {
        return v.getWebContentsId();
      } catch {
        return null;
      }
    };
    const mine = (webContentsId: number) => [...views.current.values()].some((v) => idOf(v) === webContentsId);
    const offOpen = desktop.browser.onOpen(({ webContentsId, url }) => mine(webContentsId) && opener.current(url));
    const offDownload = desktop.browser.onDownloadBlocked(({ webContentsId, filename }) => mine(webContentsId) && toast.error(`Downloads are off in the Browser pane (${filename}).`));
    return () => {
      offOpen();
      offDownload();
    };
  }, []);

  const go = (e: FormEvent) => {
    e.preventDefault();
    const url = addressUrl(current.url);
    if (!url) return update(current.id, { error: 'Enter a web address, such as localhost:3000.' });
    if (!current.page) return update(current.id, { url, page: url, title: url, error: null, loading: true });
    update(current.id, { url, error: null, loading: true });
    void views.current.get(current.id)?.loadURL(url).catch(() => {});
  };

  return (
    <PaneFrame
      frame={frame}
      title="Browser"
      start={
        <div role="group" aria-label="Browser tabs" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              title={tab.title}
              className={cn(
                'flex h-7 max-w-40 min-w-0 shrink items-center rounded-md pr-0.5 text-control-sm text-fg-secondary hover:bg-fill-ghost-hover',
                active === tab.id && 'max-w-48 shrink-0 bg-fill-ghost-selected text-fg hover:bg-fill-ghost-selected',
              )}
            >
              <button
                type="button"
                aria-current={active === tab.id || undefined}
                onClick={() => setActive(tab.id)}
                className="flex h-full min-w-0 items-center gap-1.5 rounded-md px-2 outline-none focus-ring"
              >
                {tab.favicon ? <img src={tab.favicon} alt="" className="size-4 shrink-0 rounded-xs" /> : <Icon icon={Globe} className="text-fg-muted" />}
                <span className="truncate">{tab.title}</span>
              </button>
              {active === tab.id && <IconButton icon={X} label={`Close ${tab.title}`} size="xs" className="size-5 text-fg-muted" onClick={() => closeTab(tab.id)} />}
            </div>
          ))}
          <IconButton icon={Plus} label="New tab" size="xs" className="shrink-0 text-fg-secondary" onClick={() => openTab()} />
        </div>
      }
      menu={
        <>
          <MenuItem icon={Plus} onClick={() => openTab()}>
            New tab
          </MenuItem>
          <MenuItem icon={ExternalLink} disabled={!current.page || current.url.startsWith(PAGES_PREFIX)} onClick={() => desktop?.openExternal(views.current.get(current.id)?.getURL() ?? current.page!)}>
            Open in your browser
          </MenuItem>
        </>
      }
    >
      <form onSubmit={go} className="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle px-1.5">
        <IconButton icon={ArrowLeft} label="Back" size="xs" disabled={!current.canGoBack} className="text-fg-secondary" onClick={() => views.current.get(current.id)?.goBack()} />
        <IconButton icon={RotateCw} label="Reload" size="xs" disabled={!current.page} className="text-fg-secondary" onClick={() => views.current.get(current.id)?.reload()} />
        <TextField
          ref={address}
          aria-label="Address"
          placeholder="localhost:3000"
          value={current.url}
          spellCheck={false}
          maxLength={2048}
          onChange={(e) => update(current.id, { url: e.target.value })}
          onFocus={(e) => e.currentTarget.select()}
          className="h-7 flex-1 font-mono text-code"
        />
      </form>
      <div className="relative min-h-0 flex-1 bg-bg">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="region"
            aria-label={tab.title}
            // Not display:none: a webview hidden that way loses its page.
            className={cn('absolute inset-0 flex flex-col', active !== tab.id && 'invisible')}
          >
            {tab.error && (
              <p role="alert" className="shrink-0 px-4 py-2 text-footnote text-danger-text">
                {tab.error}
              </p>
            )}
            {tab.page ? (
              <Webview
                start={tab.page}
                register={(view) => (view ? views.current.set(tab.id, view) : views.current.delete(tab.id))}
                onChange={(patch) => update(tab.id, patch)}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <Icon icon={Globe} size="lg" className="text-fg-muted" />
                <p className="text-body text-fg">Open a page beside the conversation</p>
                <p className="max-w-64 text-footnote text-fg-muted">Type an address above: a local dev server such as localhost:3000, or documentation.</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </PaneFrame>
  );
}

/**
 * One page. The element is made here rather than by React, so its attributes are in place before it attaches and
 * React never moves or recreates it (either would reload the page).
 */
function Webview({ start, register, onChange }: { start: string; register(view: WebviewElement | null): void; onChange(patch: Partial<Tab>): void }) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(onChange);
  useLayoutEffect(() => {
    changed.current = onChange;
  });

  useLayoutEffect(() => {
    const view = document.createElement('webview') as WebviewElement;
    view.setAttribute('partition', BROWSER_PARTITION);
    // Window opens reach the main process, which turns them into tabs here.
    view.setAttribute('allowpopups', '');
    view.setAttribute('src', start);
    view.className = 'size-full';
    const on = (event: string, fn: (e: Event & Record<string, unknown>) => void) => view.addEventListener(event, fn as EventListener);
    const sync = () => changed.current({ url: view.getURL(), canGoBack: view.canGoBack() });
    on('did-start-loading', () => changed.current({ loading: true, error: null }));
    on('did-stop-loading', () => changed.current({ loading: false, title: view.getTitle() || view.getURL() }));
    on('did-navigate', sync);
    on('did-navigate-in-page', sync);
    on('page-title-updated', (e) => changed.current({ title: String(e.title) }));
    on('page-favicon-updated', (e) => {
      const url = (e.favicons as string[] | undefined)?.[0];
      if (url && desktop?.browser) void desktop.browser.favicon(url).then((favicon) => favicon && changed.current({ favicon }));
    });
    on('did-fail-load', (e) => {
      // -3: a navigation that was replaced by another; not a failure.
      if (e.errorCode !== -3 && e.isMainFrame) changed.current({ loading: false, error: `This page didn’t load (${String(e.errorDescription) || e.errorCode}).` });
    });
    host.current!.append(view);
    register(view);
    return () => {
      register(null);
      view.remove();
    };
    // The page is made once; later addresses go through loadURL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pages without a background of their own show on white, as in a browser.
  return <div ref={host} className="min-h-0 flex-1 bg-[white]" />;
}
