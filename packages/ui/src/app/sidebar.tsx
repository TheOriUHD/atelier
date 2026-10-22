import { useEffect, useId, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Drawer } from '@base-ui/react/drawer';
import {
  Blocks,
  BriefcaseBusiness,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  CodeXml,
  FolderClosed,
  Keyboard,
  ListFilter,
  Lock,
  LogOut,
  MessageCircle,
  MessagesSquare,
  MoreHorizontal,
  PinOff,
  Plus,
  Search,
  Settings as SettingsIcon,
  Shapes,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { APP, type Mode, type Project, type SessionSummary, type UserPrefs } from '@atelier/protocol';
import {
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  SegmentedControl,
  cn,
  toast,
} from '../components/ui/index.ts';
import { dialogBackdropClass } from '../components/ui/styles.ts';
import { recentGroup } from '../lib/dates.ts';
import { blobUrl, isMac } from '../lib/platform.ts';
import { useAccount, usePrefs, useProjects, useSessions, useSetPref } from '../lib/queries.ts';
import { describeError, rpc } from '../lib/rpc.ts';
import { useUi } from '../lib/ui-store.ts';
import { logout } from '../features/auth/sign-in.ts';
import { isLocal, useLockNow } from '../features/auth/screen-lock.ts';
import { SidebarToggle, trafficLightInset } from './chrome.tsx';
import { MODE_HOME, modeOf, useMode, useOpenSettings } from './navigation.ts';
import { UpdateNotice } from './update-notice.tsx';
import { VersionNotice } from './version-notice.tsx';
import { useCodeSplit } from './split-nav.ts';
import { FolderGroups, GroupHeader, RowLead, SessionRow, rowClass } from './session-rows.tsx';
import { ShortcutsDialog } from './shortcuts-dialog.tsx';
import { releaseNotesFor } from '../features/whats-new/release-notes.ts';
import { WhatsNewDialog } from '../features/whats-new/whats-new.tsx';

type Tab = 'chat' | 'code';

/** Code has its own tab; Chat's holds everything else, Cowork included. */
const tabOf = (mode: Mode): Tab => (mode === 'code' ? 'code' : 'chat');

/**
 * design/components.md › Homes, sidebar and mode tabs. Chat (Cowork included) and Code each have their own nav
 * rows and lists; the profile sits at the bottom.
 */
export function Sidebar({ className }: { className?: string }) {
  const tab = tabOf(useMode());
  const split = useCodeSplit();
  return (
    <nav
      aria-label="Sidebar"
      // The 0.5px divider is drawn over the edge so it does not take width from the 272px rows.
      className={cn(
        'relative flex w-(--at-layout-sidebar-width) shrink-0 flex-col bg-sidebar after:absolute after:inset-y-0 after:right-0 after:w-[0.5px] after:bg-line',
        className,
      )}
    >
      <div
        className={cn(
          'app-drag flex h-(--at-layout-header-height) shrink-0 items-center gap-2.5 pr-2',
          trafficLightInset ? 'pl-[78px]' : 'pl-3',
        )}
      >
        <SidebarToggle />
        {/* Beside the macOS window buttons only the short name fits; the Code tab shows the mode. */}
        <span className="truncate font-serif text-[20px] leading-6 font-semibold tracking-[-0.2px] text-fg select-none">
          {tab === 'code' && !trafficLightInset ? 'Atelier Code' : 'Atelier'}
        </span>
        <ModeTabs tab={tab} />
      </div>
      <div className="mt-1 px-2">
        <SearchButton />
      </div>
      <div className="mt-2 flex flex-col gap-px px-2">
        {tab === 'chat' ? (
          <>
            <NavLink to="/" icon={Plus} exact>
              New
            </NavLink>
            <NavLink to="/projects" icon={FolderClosed}>
              Projects
            </NavLink>
            <NavLink to="/artifacts" icon={Shapes}>
              Artifacts
            </NavLink>
            <NavLink to="/work" icon={BriefcaseBusiness} exact>
              Cowork
            </NavLink>
            <NavLink to="/customize" icon={Blocks}>
              Customize
            </NavLink>
          </>
        ) : (
          <>
            <NavLink to="/code" icon={Plus} exact onClick={(e) => split.openNew() && e.preventDefault()}>
              New
            </NavLink>
            <NavLink to="/customize" search={{ mode: 'code' }} icon={Blocks}>
              Customize
            </NavLink>
          </>
        )}
        <MoreRows />
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pt-5 pb-2">
        {tab === 'chat' ? <ChatList /> : <FolderGroups mode="code" />}
      </div>
      {/* Both can show at once: the server's version above, this app's own update under it. */}
      <VersionNotice />
      <UpdateNotice />
      <ProfileFooter />
    </nav>
  );
}

/** Narrow screens: the sidebar slides in over the page and closes on Escape, a tap outside, a swipe to the left or going somewhere. */
export function SidebarDrawer() {
  const open = useUi((s) => s.drawerOpen);
  const setOpen = useUi((s) => s.setDrawerOpen);
  const router = useRouter();
  useEffect(
    () =>
      // Switching tabs keeps it open on that tab's sessions.
      router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
        if (!fromLocation || tabOf(modeOf(fromLocation.pathname, fromLocation.search)) === tabOf(modeOf(toLocation.pathname, toLocation.search))) setOpen(false);
      }),
    [router, setOpen],
  );
  return (
    <Drawer.Root open={open} onOpenChange={setOpen} swipeDirection="left">
      <Drawer.Portal>
        <Drawer.Backdrop className={dialogBackdropClass} />
        <Drawer.Viewport className="fixed inset-0 z-(--at-layout-z-modal)">
          <Drawer.Popup
            aria-label="Sidebar"
            className={cn(
              'flex h-full w-(--at-layout-sidebar-width) max-w-[calc(100vw-48px)] bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-lg outline-none',
              'translate-x-(--drawer-swipe-movement-x) transition-[translate] duration-(--at-duration-sheet) ease-out data-swiping:duration-0',
              'data-starting-style:-translate-x-full data-ending-style:-translate-x-full',
            )}
          >
            {/* Content: a mouse press is a click, not the start of a swipe (touch still swipes). */}
            <Drawer.Content className="flex min-w-0 flex-1">
              <Sidebar className="w-full" />
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function NavLink({
  to,
  search,
  icon,
  exact,
  onClick,
  children,
}: {
  to: '/' | '/projects' | '/artifacts' | '/work' | '/customize' | '/code';
  search?: { mode: 'code' };
  icon: LucideIcon;
  exact?: boolean;
  /** Called before navigating; preventing the default keeps the page (a split view takes the request). */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: string;
}) {
  return (
    <Link to={to} search={search} activeOptions={{ exact, includeSearch: false }} onClick={onClick} className={cn(rowClass, 'px-0.5')}>
      <RowLead>
        <Icon icon={icon} />
      </RowLead>
      {children}
    </Link>
  );
}

const TABS = [
  { value: 'chat', label: 'Chat', icon: MessagesSquare },
  { value: 'code', label: 'Code', icon: CodeXml },
] as const;

/** Two icon tabs at the header's right; each opens its home. Cowork lives in Chat. */
function ModeTabs({ tab }: { tab: Tab }) {
  const navigate = useNavigate();
  return (
    <SegmentedControl
      variant="icon"
      size="sm"
      aria-label="Mode"
      items={TABS}
      value={tab}
      onValueChange={(next: Tab) => void navigate({ to: MODE_HOME[next] })}
      className="app-no-drag ml-auto shrink-0"
    />
  );
}

function SearchButton() {
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  return (
    <button
      type="button"
      onClick={() => setPaletteOpen(true)}
      className="flex h-8 w-full items-center rounded-lg bg-fill-field px-0.5 text-body text-fg-muted shadow-field-drop inset-ring-[0.5px] inset-ring-line outline-none transition-colors duration-(--at-duration-fast) ease-out focus-ring hover:text-fg-secondary"
    >
      <RowLead>
        <Icon icon={Search} />
      </RowLead>
      <span className="flex-1 pl-1 text-left">Search</span>
    </button>
  );
}

/** "More" opens in place onto the less used places: Settings, Usage, the keyboard shortcuts and what's new. */
function MoreRows() {
  const [open, setOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [news, setNews] = useState(false);
  const notes = releaseNotesFor(APP.version);
  const openSettings = useOpenSettings();
  const list = useId();
  const row = (icon: LucideIcon, label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} className={cn(rowClass, 'px-0.5')}>
      <RowLead>
        <Icon icon={icon} />
      </RowLead>
      {label}
    </button>
  );
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? list : undefined}
        onClick={() => setOpen(!open)}
        className={cn(rowClass, 'px-0.5 text-fg-muted')}
      >
        <RowLead>
          <Icon
            icon={ChevronRight}
            className={cn('transition-transform duration-(--at-duration-fast) ease-standard', open && 'rotate-90')}
          />
        </RowLead>
        More
      </button>
      {open && (
        <div id={list} className="flex flex-col gap-px">
          {row(SettingsIcon, 'Settings', () => openSettings())}
          {row(ChartColumn, 'Usage', () => openSettings('usage'))}
          {row(Keyboard, 'Keyboard shortcuts', () => setShortcuts(true))}
          {notes && row(Sparkles, 'What’s new', () => setNews(true))}
        </div>
      )}
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
      {notes && <WhatsNewDialog notes={notes} open={news} onOpenChange={setNews} />}
    </>
  );
}

type Show = 'all' | 'chat' | 'work';
type Pinned = { kind: 'project'; project: Project } | { kind: 'session'; session: SessionSummary };

const pinnedAt = (p: Pinned) => (p.kind === 'project' ? p.project.pinnedAt : p.session.pinnedAt) ?? 0;

/** Chat's list: pinned projects and conversations, then chats and Cowork tasks by day, filtered from the first group. */
function ChatList() {
  const { data: chats } = useSessions({ mode: 'chat' });
  const { data: tasks } = useSessions({ mode: 'work' });
  const { data: projects } = useProjects();
  const [chosen, setChosen] = useState<Show>('all');
  // The filter only means something with both kinds of conversation.
  const both = !!chats?.length && !!tasks?.length;
  const show = both ? chosen : 'all';
  const sessions = [...(show !== 'work' ? (chats ?? []) : []), ...(show !== 'chat' ? (tasks ?? []) : [])];

  const pinned: Pinned[] = [
    ...(projects ?? []).filter((p) => p.pinnedAt).map((project) => ({ kind: 'project' as const, project })),
    ...sessions.filter((s) => s.pinnedAt).map((session) => ({ kind: 'session' as const, session })),
  ].sort((a, b) => pinnedAt(b) - pinnedAt(a));
  const groups: { label: string; items: SessionSummary[] }[] = [];
  for (const s of sessions.filter((s) => !s.pinnedAt).sort((a, b) => b.updatedAt - a.updatedAt)) {
    const label = recentGroup(s.updatedAt);
    if (groups.at(-1)?.label === label) groups.at(-1)!.items.push(s);
    else groups.push({ label, items: [s] });
  }

  const filter = both && (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={ListFilter}
            label="Filter recents"
            size="xs"
            className={show === 'all' ? 'text-fg-muted' : 'text-fg'}
          />
        }
      />
      <MenuContent align="end" className="w-52">
        <MenuGroup>
          <MenuLabel>Show</MenuLabel>
          <MenuRadioGroup value={show} onValueChange={(v: Show) => setChosen(v)}>
            <MenuRadioItem value="all">All</MenuRadioItem>
            <MenuRadioItem value="chat">Chats</MenuRadioItem>
            <MenuRadioItem value="work">Cowork tasks</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuContent>
    </Menu>
  );

  return (
    <>
      {pinned.length > 0 && (
        <section aria-label="Pinned" className="mb-4 flex flex-col gap-px">
          <GroupHeader label="Pinned" />
          {pinned.map((p) =>
            p.kind === 'project' ? (
              <PinnedProject key={p.project.id} project={p.project} />
            ) : (
              <ChatListRow key={p.session.id} session={p.session} />
            ),
          )}
        </section>
      )}
      {groups.map(({ label, items }, i) => (
        <section key={label} aria-label={label} className="mb-4 flex flex-col gap-px">
          <GroupHeader label={label}>{i === 0 && filter}</GroupHeader>
          {items.map((s) => (
            <ChatListRow key={s.id} session={s} />
          ))}
        </section>
      ))}
    </>
  );
}

function ChatListRow({ session }: { session: SessionSummary }) {
  return (
    <SessionRow
      session={session}
      lead={
        <Icon
          icon={session.mode === 'work' ? BriefcaseBusiness : MessageCircle}
          label={session.mode === 'work' ? 'Cowork task' : undefined}
        />
      }
    />
  );
}

function PinnedProject({ project }: { project: Project }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const unpin = () =>
    rpc()
      .call('projects.update', { id: project.id, pinned: false })
      .catch((e: unknown) => toast.error(describeError(e).message));
  return (
    <Link to="/projects/$projectId" params={{ projectId: project.id }} className={cn(rowClass, 'pr-1 pl-0.5')}>
      <RowLead>
        <Icon icon={FolderClosed} label="Project" />
      </RowLead>
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          aria-label={`Options for ${project.name}`}
          onClick={(e) => e.preventDefault()}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg',
            // Touch screens have no hover: narrow ones always show it.
            menuOpen ? 'flex' : 'hidden group-hover/row:flex group-focus-visible/row:flex max-md:flex',
          )}
        >
          <Icon icon={MoreHorizontal} />
        </MenuTrigger>
        <MenuContent align="start" className="w-56" onClick={(e) => e.preventDefault()}>
          <MenuItem icon={PinOff} onClick={() => void unpin()}>
            Unpin
          </MenuItem>
        </MenuContent>
      </Menu>
    </Link>
  );
}

type Theme = UserPrefs['appearance']['theme'];

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Avatar, name · role and the profile menu; a quiet Settings button on the right. */
function ProfileFooter() {
  const { account } = useAccount();
  const { prefs } = usePrefs();
  const setPref = useSetPref();
  const openSettings = useOpenSettings();
  const lockNow = useLockNow(openSettings);
  const name = account?.name || 'You';
  const avatar = account?.avatar;

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-t-[0.5px] border-line px-2">
      <Menu>
        <MenuTrigger className="flex h-8 min-w-0 items-center gap-2 rounded-lg pr-2 pl-0.5 text-body text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover">
          {avatar ? (
            <img src={blobUrl(avatar)} alt="" className="size-6 rounded-full object-cover" />
          ) : (
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-fill-primary text-caption font-medium text-on-primary"
            >
              {name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="truncate">
            {name}
            {account && (
              <span className="text-footnote text-fg-muted"> · {account.role === 'admin' ? 'Admin' : 'Member'}</span>
            )}
          </span>
          <Icon icon={ChevronDown} className="text-fg-muted" />
        </MenuTrigger>
        <MenuContent side="top" align="start" className="w-56">
          <MenuItem icon={SettingsIcon} shortcut={isMac ? '⌘,' : 'Ctrl+,'} onClick={() => openSettings()}>
            Settings
          </MenuItem>
          <MenuSeparator />
          <MenuRadioGroup
            value={prefs?.appearance.theme ?? 'system'}
            onValueChange={(value: Theme) => setPref.mutate({ path: ['appearance', 'theme'], value })}
          >
            {THEMES.map((t) => (
              <MenuRadioItem key={t.value} value={t.value}>
                {t.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          {/* On this computer there is no sign-in to leave; the screen lock takes its place. */}
          {isLocal() ? (
            <MenuItem icon={Lock} shortcut={isMac ? '⇧⌘L' : 'Ctrl+Shift+L'} onClick={lockNow}>
              Lock Atelier
            </MenuItem>
          ) : (
            <MenuItem icon={LogOut} onClick={() => void logout().catch((e: unknown) => toast.error(describeError(e).message))}>
              Log out
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      <IconButton
        icon={SettingsIcon}
        label="Settings"
        className="ml-auto text-fg-secondary"
        onClick={() => openSettings()}
      />
    </div>
  );
}
