/** The panel's frame: the sidebar (a top bar on a phone), the theme toggle, and the page for the address. */
import { Bug, Download, LayoutDashboard, Lightbulb, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorNote, Segmented, cx } from './components/ui';
import { api, CHANGED, useApi } from './lib/api';
import { Link, parse, useLocation } from './lib/router';
import { useTheme, type Theme } from './lib/theme';
import { DownloadsPage } from './pages/Downloads';
import { Inbox } from './pages/Inbox';
import { Overview } from './pages/Overview';
import { ReportPage } from './pages/Report';
import type { ListResponse } from './types';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, match: (p: string) => p === '/' },
  {
    href: '/issues',
    label: 'Issues',
    icon: Bug,
    match: (p: string) => p === '/issues' || p.startsWith('/r/I-'),
    unseen: 'issue' as const,
  },
  {
    href: '/features',
    label: 'Feature requests',
    icon: Lightbulb,
    match: (p: string) => p === '/features' || p.startsWith('/r/F-'),
    unseen: 'feature' as const,
  },
  { href: '/downloads', label: 'Downloads', icon: Download, match: (p: string) => p === '/downloads' },
];

/** How many reports of each kind are unread, for the badges; asked again on every page change. */
function useUnseen(pathname: string) {
  const [unseen, setUnseen] = useState<{ issue: number; feature: number } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const changed = () => setTick((t) => t + 1);
    window.addEventListener(CHANGED, changed);
    return () => window.removeEventListener(CHANGED, changed);
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<ListResponse>('/api/reports?kind=issue&limit=1'),
      api<ListResponse>('/api/reports?kind=feature&limit=1'),
    ])
      .then(([i, f]) => live && setUnseen({ issue: i.facets.unseen, feature: f.facets.unseen }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pathname, tick]);
  return unseen;
}

const THEMES: { value: Theme; label: ReactNode; title: string }[] = [
  { value: 'system', label: <Monitor size={14} aria-label="System" />, title: 'Follow the system' },
  { value: 'light', label: <Sun size={14} aria-label="Light" />, title: 'Light' },
  { value: 'dark', label: <Moon size={14} aria-label="Dark" />, title: 'Dark' },
];

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 rounded-md px-1 py-0.5">
      <img src="/favicon.svg" alt="" className="size-5 rounded-[5px]" />
      <span className="text-body-strong text-fg">Atelier</span>
      <span className="text-footnote text-fg-muted">Admin</span>
    </Link>
  );
}

export function App() {
  const { pathname } = useLocation();
  const route = parse(pathname);
  const [theme, setTheme] = useTheme();
  const me = useApi<{ email: string; dev: boolean }>('/api/me');
  const unseen = useUnseen(pathname);
  const main = useRef<HTMLElement>(null);
  // A block body: what scrollTo returns must not become the effect's cleanup.
  useEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [pathname]);

  const page =
    route.page === 'overview' ? (
      <Overview />
    ) : route.page === 'downloads' ? (
      <DownloadsPage />
    ) : route.page === 'inbox' ? (
      <Inbox key={route.kind} kind={route.kind} />
    ) : route.page === 'report' ? (
      <ReportPage key={route.id} id={route.id} />
    ) : (
      <div className="py-16 text-center text-fg-muted">
        Nothing here.{' '}
        <Link href="/" className="text-interactive-text underline">
          Overview
        </Link>
      </div>
    );

  const nav = NAV.map((item) => {
    const active = item.match(pathname);
    const count = item.unseen && unseen ? unseen[item.unseen] : 0;
    return { ...item, active, count };
  });

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-sidebar md:flex">
        <div className="flex h-12 items-center px-3">
          <Brand />
        </div>
        <nav className="flex flex-col gap-0.5 px-2 pt-1" aria-label="Pages">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              className={cx(
                'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-body',
                item.active
                  ? 'bg-fill-ghost-selected text-fg'
                  : 'text-fg-secondary hover:bg-fill-ghost-hover hover:text-fg',
              )}
            >
              <item.icon size={16} aria-hidden className="shrink-0" />
              <span className="flex-1 truncate">{item.label}</span>
              {item.count > 0 && (
                <span
                  className="rounded-full bg-accent px-1.5 text-badge leading-[18px] text-on-accent tabular"
                  title={`${item.count} unread`}
                >
                  {item.count}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-2 border-t border-line-subtle p-3">
          <Segmented label="Theme" value={theme} onChange={setTheme} options={THEMES} />
          <div className="truncate text-caption text-fg-muted" title={me.data?.email}>
            {me.data ? (me.data.dev ? 'Local development, no Access' : me.data.email) : ' '}
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-line bg-sidebar md:hidden">
          <div className="flex h-12 items-center justify-between px-4">
            <Brand />
            <Segmented label="Theme" value={theme} onChange={setTheme} options={THEMES} />
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Pages">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.active ? 'page' : undefined}
                className={cx(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-control-sm',
                  item.active ? 'bg-fill-ghost-selected text-fg' : 'text-fg-secondary',
                )}
              >
                <item.icon size={14} aria-hidden />
                {item.label}
                {item.count > 0 && (
                  <span className="rounded-full bg-accent px-1.5 text-badge text-on-accent tabular">{item.count}</span>
                )}
              </Link>
            ))}
          </nav>
        </header>
        <main ref={main} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-5 md:px-8 md:py-7">
            {me.error ? (
              <div className="mx-auto max-w-md py-16">
                <ErrorNote>{me.error}</ErrorNote>
              </div>
            ) : (
              page
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
