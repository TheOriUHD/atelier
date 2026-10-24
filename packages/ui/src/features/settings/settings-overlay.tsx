import { useCallback, useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type Ref } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { ChevronLeft, Search, X } from 'lucide-react';
import { Button, Icon, IconButton, Spinner, cn } from '../../components/ui/index.ts';
import { dialogBackdropClass, dialogPopupClass } from '../../components/ui/styles.ts';
import { useCloseSettings, useOpenSettings } from '../../app/navigation.ts';
import { useNarrow } from '../../lib/narrow.ts';
import { useAccount, usePrefs, useSettings } from '../../lib/queries.ts';
import { AccountPage } from './account-page.tsx';
import { AdminCodePage } from './admin-code-page.tsx';
import { CapabilitiesPage } from './capabilities-page.tsx';
import { CloudPage } from './cloud-page.tsx';
import { CodePage } from './code-page.tsx';
import { ConnectorsPage } from './connectors-page.tsx';
import { FoldersPage } from './folders-page.tsx';
import { GeneralPage } from './general-page.tsx';
import { MemoryPage } from './memory-page.tsx';
import { ModelsPage } from './models-page.tsx';
import { settingsPage, visiblePages, type SettingsPage, type SettingsPageId } from './pages.ts';
import { PersonalModelsPage } from './personal-models-page.tsx';
import { PluginsPage } from './plugins-page.tsx';
import { PrivacyPage } from './privacy-page.tsx';
import { ProvidersPage } from './providers-page.tsx';
import { useRowFlash } from './row-flash.ts';
import { searchSettings, type SettingEntry } from './search-index.ts';
import { SecretsPage } from './secrets-page.tsx';
import { ServerPage } from './server-page.tsx';
import { SettingsFileErrors } from './settings-errors.tsx';
import { ShortcutsPage } from './shortcuts-page.tsx';
import { DeveloperPage } from './developer-page.tsx';
import { SkillsPage } from './skills-page.tsx';
import { SystemPage } from './system-page.tsx';
import { UsagePage } from './usage-page.tsx';
import { UsersPage } from './users-page.tsx';

const PAGE_COMPONENTS: Record<SettingsPageId, ComponentType> = {
  general: GeneralPage,
  shortcuts: ShortcutsPage,
  account: AccountPage,
  privacy: PrivacyPage,
  memory: MemoryPage,
  usage: UsagePage,
  code: CodePage,
  folders: FoldersPage,
  cloud: CloudPage,
  'personal-models': PersonalModelsPage,
  skills: SkillsPage,
  system: SystemPage,
  providers: ProvidersPage,
  models: ModelsPage,
  capabilities: CapabilitiesPage,
  'admin-code': AdminCodePage,
  connectors: ConnectorsPage,
  plugins: PluginsPage,
  secrets: SecretsPage,
  users: UsersPage,
  server: ServerPage,
  developer: DeveloperPage,
};

/**
 * The Settings dialog (1024×800): searchable nav on the left, the page on the right. It is open
 * while the root search has `?settings=<page>`; `&row=<id>` scrolls to and flashes that row.
 * Narrow screens fill the screen with the nav as a list (`?settings=` without a page) or one page.
 */
export function SettingsOverlay() {
  const search = useSearch({ strict: false });
  const close = useCloseSettings();
  const { account } = useAccount();
  const admin = account?.role === 'admin';
  const open = search.settings !== undefined;
  // Keep showing the last page while the dialog animates out.
  const [shown, setShown] = useState(search.settings);
  if (open && search.settings !== shown) setShown(search.settings);

  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={dialogBackdropClass} />
        <BaseDialog.Popup
          aria-label="Settings"
          className={cn(
            dialogPopupClass,
            'flex h-(--at-layout-settings-dialog-h) w-(--at-layout-settings-dialog-w) overflow-hidden bg-surface',
            'max-md:inset-0 max-md:size-full max-md:max-h-none max-md:max-w-none max-md:translate-0 max-md:flex-col max-md:rounded-none max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:ring-0',
          )}
        >
          <SettingsBody page={settingsPage(shown, admin)} list={shown === ''} admin={admin} row={open ? search.row : undefined} onClose={close} />
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

function SettingsBody({ page, list, admin, row, onClose }: { page: SettingsPage; list: boolean; admin: boolean; row: string | undefined; onClose(): void }) {
  const { data: snapshot } = useSettings();
  const { prefs } = usePrefs();
  const { account } = useAccount();
  const loaded = !!(snapshot && prefs && account);
  const navigate = useNavigate();
  const router = useRouter();
  const narrow = useNarrow();
  const content = useRef<HTMLDivElement>(null);
  const clearRow = useCallback(
    () => void navigate({ to: '.', search: (prev) => ({ ...prev, row: undefined }), replace: true }),
    [navigate],
  );
  useRowFlash(content, loaded ? row : undefined, clearRow);
  const Page = PAGE_COMPONENTS[page.id];

  // Narrow screens: the list's history entry, when a page was opened from it. Back returns there, else it replaces the page with the list.
  const listEntry = useRef<number | null>(null);
  const back = () => {
    if (listEntry.current === router.history.location.state.__TSR_index - 1) router.history.back();
    else void navigate({ to: '.', search: (prev) => ({ ...prev, settings: '', row: undefined }), replace: true });
  };
  // The list and a page replace each other: focus moves to Back, or to the page it came back from.
  const backButton = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  const shown = useRef({ list, page: page.id });
  useEffect(() => {
    const was = shown.current;
    shown.current = { list, page: page.id };
    if (!narrow || was.list === list) return;
    if (list) nav.current?.querySelector<HTMLElement>(`[data-page="${was.page}"]`)?.focus();
    else backButton.current?.focus();
  }, [narrow, list, page.id]);

  const body = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={content} key={page.id} className="min-h-0 flex-1 overflow-y-auto px-6 pt-[60px] pb-12 max-md:px-4 max-md:pt-4">
        {loaded ? (
          <>
            <SettingsFileErrors errors={snapshot.errors} />
            <Page />
          </>
        ) : (
          <div className="flex justify-center pt-20 text-fg-muted">
            <Spinner size="md" label="Loading settings" />
          </div>
        )}
      </div>
      {!narrow && <IconButton icon={X} label="Close" iconSize="md" className="absolute top-3 right-3" onClick={onClose} />}
    </div>
  );
  if (!narrow)
    return (
      <>
        <SettingsNav current={page.id} admin={admin} />
        {body}
      </>
    );
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line-subtle px-2">
        {!list && (
          <Button ref={backButton} variant="ghost" size="sm" leadingIcon={ChevronLeft} onClick={back}>
            Settings
          </Button>
        )}
        <h1 className="min-w-0 flex-1 truncate px-2 text-section-heading text-fg">{list ? 'Settings' : page.label}</h1>
        <IconButton icon={X} label="Close" iconSize="md" onClick={onClose} />
      </header>
      {list ? (
        <SettingsNav ref={nav} current={null} admin={admin} onOpen={() => (listEntry.current = router.history.location.state.__TSR_index)} />
      ) : (
        body
      )}
    </>
  );
}

/** One line, always: a label too long for the 192px column is cut off with an ellipsis, never wrapped (pages.ts keeps them short). */
const NAV_ITEM_CLASS = 'flex h-8 w-full min-w-0 items-center gap-3 rounded-lg px-2 text-left text-body whitespace-nowrap text-fg-secondary outline-none focus-ring max-md:h-11';

/**
 * 192 wide: search on top, then grouped pages. While searching, matching rows replace the pages.
 * Narrow screens show it full width as the list of pages (`current` null); `onOpen` hears when it opens one.
 */
function SettingsNav({ ref, current, admin, onOpen }: { ref?: Ref<HTMLElement>; current: SettingsPageId | null; admin: boolean; onOpen?(): void }) {
  const openSettings = useOpenSettings();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const results = searchSettings(query, admin);
  const pages = visiblePages(admin);
  const groups = [...new Set(pages.map((p) => p.group))];
  const searching = query.trim() !== '';

  const choose = (entry: SettingEntry) => {
    setQuery('');
    onOpen?.();
    openSettings(entry.page, entry.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) {
      // Clear the search instead of closing the dialog.
      e.stopPropagation();
      setQuery('');
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) => (results.length ? (h + step + results.length) % results.length : 0));
    } else if (e.key === 'Enter' && results[highlight]) {
      e.preventDefault();
      choose(results[highlight]);
    }
  };

  return (
    <nav ref={ref} aria-label="Settings pages" className="flex w-(--at-layout-settings-nav-width) shrink-0 flex-col overflow-y-auto bg-bg p-3 max-md:min-h-0 max-md:w-full max-md:flex-1 max-md:px-4">
      <div className="relative">
        <Icon icon={Search} size="md" className="pointer-events-none absolute top-1.5 left-2 text-fg-muted" />
        <input
          type="search"
          aria-label="Search settings"
          // The results list exists only while searching.
          aria-controls={searching ? 'settings-search-results' : undefined}
          placeholder="Search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          className={cn(
            'h-8 w-full rounded-lg bg-fill-field pr-2 pl-9 text-body text-fg inset-ring inset-ring-fill-field-ring outline-none',
            'transition-[background-color,box-shadow] duration-(--at-duration-fast) ease-standard placeholder:text-fg-muted focus-visible:shadow-focus',
            '[&::-webkit-search-cancel-button]:appearance-none',
          )}
        />
      </div>
      {searching ? (
        <div id="settings-search-results" aria-live="polite" className="mt-3 flex flex-col gap-px">
          {results.map((entry, i) => (
            <button
              key={entry.id}
              type="button"
              data-highlighted={i === highlight || undefined}
              onClick={() => choose(entry)}
              onMouseMove={() => setHighlight(i)}
              className="flex w-full flex-col rounded-lg px-2 py-1.5 text-left outline-none focus-ring data-highlighted:bg-fill-ghost-hover"
            >
              <span className="text-body text-fg">{entry.label}</span>
              <span className="text-footnote text-fg-muted">{settingsPage(entry.page, admin).label}</span>
            </button>
          ))}
          {results.length === 0 && <p className="px-2 py-1.5 text-footnote text-fg-muted">No settings match “{query.trim()}”.</p>}
        </div>
      ) : (
        groups.map((group) => (
          <div key={group} className="flex flex-col gap-px">
            <h2 className="px-2.5 pt-6 pb-3 text-footnote text-fg-muted">{group}</h2>
            {pages.filter((p) => p.group === group).map((p) => (
              <button
                key={p.id}
                type="button"
                data-page={p.id}
                aria-current={p.id === current ? 'page' : undefined}
                onClick={() => {
                  onOpen?.();
                  openSettings(p.id);
                }}
                className={cn(NAV_ITEM_CLASS, p.id === current ? 'bg-fill-ghost-selected font-medium text-fg' : 'hover:bg-fill-ghost-hover')}
              >
                <Icon icon={p.icon} size="md" className="shrink-0" />
                <span className="min-w-0 truncate">{p.label}</span>
              </button>
            ))}
          </div>
        ))
      )}
    </nav>
  );
}
