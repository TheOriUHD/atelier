/**
 * Session rows for the sidebar and the Cowork page: a row with its menu (pin, rename, project, delete), and the
 * folder-grouped lists of Code sessions and Cowork tasks.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ChevronRight,
  FileText,
  FolderMinus,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SlidersVertical,
  Trash2,
} from 'lucide-react';
import type { SessionStatus, SessionSummary, SidebarView } from '@atelier/protocol';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  Icon,
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MenuTrigger,
  TextField,
  Tooltip,
  cn,
  toast,
} from '../components/ui/index.ts';
import { reducedMotionClass } from '../components/ui/styles.ts';
import { relativeTime } from '../lib/dates.ts';
import { useGroups, useProjects, useSessions, useSidebarView, useWorkspaces } from '../lib/queries.ts';
import { describeError, rpc } from '../lib/rpc.ts';
import { sessionNoun, sessionTitle } from '../lib/sessions.ts';
import { desktop } from '../lib/platform.ts';
import { MODE_HOME, SESSION_ROUTE } from './navigation.ts';
import { NameDialog } from './name-dialog.tsx';
import { ENVIRONMENT_LABELS, arrangeSessions, environmentHint, type ListedGroup } from './sidebar-view.ts';
import { SessionMenuContent } from './session-menu.tsx';
import { useCodeSplit } from './split-nav.ts';

/** Nav and session row: 32 tall, r8, 14px. TanStack Link marks the current route with data-status="active". */
export const rowClass =
  'group/row relative flex h-8 items-center gap-2 rounded-lg text-body text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover data-[status=active]:bg-fill-ghost-selected data-[status=active]:text-fg';

/** The 28px slot that leads every row, so icons, glyphs and labels line up down the sidebar. */
export function RowLead({ children }: { children: ReactNode }) {
  return <span className="flex w-7 shrink-0 justify-center">{children}</span>;
}

/** A group's label (13 muted) with its actions on the right: a folder's "+", the first group's filter. */
export function GroupHeader({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex h-6 items-center gap-0.5 pr-0.5 pb-0.5 pl-1.5">
      <h2 className="min-w-0 flex-1 truncate text-footnote text-fg-muted">{label}</h2>
      {children}
    </div>
  );
}

/**
 * Code and Cowork rows lead with the session's state: a hollow circle when idle, a pulsing clay dot while it runs, a
 * yellow one when it waits for you (a permission or a question) and a blue one when a turn finished while you were
 * elsewhere (`unseen`, until you open it).
 */
export function StatusGlyph({ status, unseen = false }: { status: SessionStatus; unseen?: boolean }) {
  if (status === 'waiting') return <span role="img" aria-label="Needs your attention" className="size-2 rounded-full bg-warning" />;
  if (status === 'running') return <span role="img" aria-label="Running" className={cn('size-2 rounded-full bg-accent animate-pulse', reducedMotionClass)} />;
  if (unseen) return <span role="img" aria-label="Finished" className="size-2 rounded-full bg-interactive" />;
  return <span aria-hidden className="size-2 rounded-full border-[1.5px] border-fg-muted" />;
}

/** A session's glyph in a list; the one you are in has nothing to announce that you aren't looking at. */
function SessionGlyph({ session }: { session: SessionSummary }) {
  const params = useParams({ strict: false });
  const { cells } = useCodeSplit();
  return <StatusGlyph status={session.status} unseen={!!session.finishedUnseen && params.sessionId !== session.id && !cells.includes(session.id)} />;
}

/**
 * A session in a list: its leading icon or state, the title, a file glyph when it made an artifact or files, and
 * on hover its menu. Rows without a state glyph show a clay dot while the session runs.
 */
export function SessionRow({
  session,
  lead,
  showsStatus,
}: {
  session: SessionSummary;
  lead: ReactNode;
  showsStatus?: boolean;
}) {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const active = params.sessionId === session.id;
  // The other sessions of a split view are open too, though the route names the first. Picking one replaces the
  // split's active cell, so a click is the split's to answer.
  const split = useCodeSplit();
  const inSplit = split.cells.includes(session.id);
  const chat = session.mode === 'chat';
  const [menuOpen, setMenuOpen] = useState(false);
  // A right-click opens the same menu at the pointer; the ⋯ button opens it beside itself.
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const anchor = useMemo(
    () => (pointer ? { getBoundingClientRect: () => DOMRect.fromRect({ x: pointer.x, y: pointer.y, width: 0, height: 0 }) } : undefined),
    [pointer],
  );
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { data: projects } = useProjects();
  // The task lists (Code, Cowork) file sessions under the person's groups and open their folders elsewhere.
  const { data: groups } = useGroups({ enabled: !chat });
  const { data: workspaces } = useWorkspaces();
  const [namingGroup, setNamingGroup] = useState(false);
  const running = !showsStatus && (session.status === 'running' || session.status === 'waiting');

  const update = (patch: { pinned?: boolean; projectId?: string | null }) =>
    rpc()
      .call('sessions.update', { id: session.id, ...patch })
      .catch((e: unknown) => toast.error(describeError(e).message));

  return (
    <>
      <Tooltip
        content={`${sessionTitle(session)} · ${relativeTime(session.updatedAt)}`}
        side="right"
        disabled={menuOpen}
      >
        <Link
          to={SESSION_ROUTE[session.mode]}
          params={{ sessionId: session.id }}
          activeOptions={{ includeSearch: false }}
          onClick={(e) => {
            if (session.mode !== 'code' || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            if (split.open(session.id)) e.preventDefault();
          }}
          onContextMenu={(e) => {
            // Right-clicks in the open menu reach here through the React tree, though it is portalled elsewhere.
            if (!e.currentTarget.contains(e.target as Node)) return;
            e.preventDefault();
            setPointer({ x: e.clientX, y: e.clientY });
            setMenuOpen(true);
          }}
          className={cn(rowClass, 'pr-1 pl-0.5', inSplit && 'bg-fill-ghost-selected text-fg')}
        >
          <RowLead>{lead}</RowLead>
          <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
          {(session.produced || running) && (
            <span
              className={cn(
                'flex shrink-0 items-center gap-1.5 pr-1.5',
                !menuOpen && 'group-hover/row:hidden group-focus-visible/row:hidden',
                menuOpen && 'hidden',
              )}
            >
              {session.produced && (
                <Icon
                  icon={FileText}
                  label={chat ? 'Made an artifact' : 'Made files'}
                  className="size-3.5 text-fg-muted"
                />
              )}
              {running && <span role="img" aria-label="Running" className="size-1.5 rounded-full bg-accent" />}
            </span>
          )}
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              aria-label={`Options for ${sessionTitle(session)}`}
              onClick={(e) => {
                e.preventDefault();
                setPointer(null);
              }}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg',
                // Touch screens have no hover: narrow ones always show it.
                menuOpen ? 'flex' : 'hidden group-hover/row:flex group-focus-visible/row:flex max-md:flex',
              )}
            >
              <Icon icon={MoreHorizontal} />
            </MenuTrigger>
            {/* Clicks in the portalled menu bubble through the React tree to the row link; don't let them open the chat. */}
            {chat ? (
              <MenuContent align="start" anchor={anchor} className="w-56" onClick={(e) => e.preventDefault()}>
                <MenuItem
                  icon={session.pinnedAt ? PinOff : Pin}
                  onClick={() => void update({ pinned: !session.pinnedAt })}
                >
                  {session.pinnedAt ? 'Unpin' : 'Pin'}
                </MenuItem>
                <MenuItem icon={Pencil} onClick={() => setRenaming(true)}>
                  Rename
                </MenuItem>
                {!!projects?.length && (
                  <MenuSubmenu label="Add to project" icon={FolderPlus}>
                    {projects.map((p) => (
                      <MenuItem
                        key={p.id}
                        disabled={p.id === session.projectId}
                        onClick={() => void update({ projectId: p.id })}
                      >
                        {p.name}
                      </MenuItem>
                    ))}
                  </MenuSubmenu>
                )}
                {session.projectId && (
                  <MenuItem icon={FolderMinus} onClick={() => void update({ projectId: null })}>
                    Remove from project
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem icon={Trash2} danger onClick={() => setDeleting(true)}>
                  Delete
                </MenuItem>
              </MenuContent>
            ) : (
              <SessionMenuContent
                session={session}
                workspace={workspaces?.find((w) => w.id === session.workspaceId)}
                groups={groups ?? []}
                onRename={() => setRenaming(true)}
                onDelete={() => setDeleting(true)}
                onNewGroup={() => setNamingGroup(true)}
                close={() => setMenuOpen(false)}
                anchor={anchor}
              />
            )}
          </Menu>
        </Link>
      </Tooltip>
      <RenameDialog session={session} open={renaming} onOpenChange={setRenaming} />
      <NameDialog
        open={namingGroup}
        onOpenChange={setNamingGroup}
        title="New group"
        label="Group name"
        confirm="Create and move"
        onSubmit={async (name) => {
          const group = await rpc().call('groups.create', { name });
          await rpc().call('sessions.update', { id: session.id, groupId: group.id });
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${sessionNoun(session)}?`}
        description={`“${sessionTitle(session)}” and its artifacts will be deleted. This can’t be undone.`}
        onConfirm={async () => {
          await rpc().call('sessions.delete', { id: session.id });
          if (active) void navigate({ to: MODE_HOME[session.mode] });
        }}
      />
    </>
  );
}

export function RenameDialog({
  session,
  open,
  onOpenChange,
}: {
  session: SessionSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const next = title.trim();
    if (!next || next === session.title) return onOpenChange(false);
    setSaving(true);
    try {
      await rpc().call('sessions.update', { id: session.id, title: next });
      onOpenChange(false);
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setTitle(session.title);
        onOpenChange(next);
      }}
    >
      <DialogContent title={`Rename ${sessionNoun(session)}`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField
            aria-label="Title"
            value={title}
            maxLength={200}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={saving} disabled={!title.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Code sessions (in the sidebar) or Cowork tasks (on the Cowork page): pinned first, then arranged by the person's view
 * options: by folder (each with a "+" that starts a session there; in "No folder", one with no folder), by their own
 * groups, by date, by state, or in one list; filtered by status and environment and sorted.
 */
export function FolderGroups({ mode, className }: { mode: 'work' | 'code'; className?: string }) {
  const { view, set } = useSidebarView();
  const { data: sessions } = useSessions({ mode, archived: view.status });
  const { data: workspaces } = useWorkspaces();
  const { data: customGroups } = useGroups();
  const noun = mode === 'work' ? 'task' : 'session';
  const { pinned, groups } = arrangeSessions(sessions ?? [], {
    view,
    workspaces: workspaces ?? [],
    groups: customGroups ?? [],
    thisDevice: desktop?.device.id,
  });
  const empty = !pinned.length && !groups.length;
  const options = <ViewOptions view={view} set={set} noun={noun} />;

  return (
    <div className={className}>
      {pinned.length > 0 && (
        <section aria-label="Pinned" className="mt-4 flex flex-col gap-px first:mt-0">
          <GroupHeader label="Pinned" />
          {pinned.map((s) => (
            <SessionRow key={s.id} session={s} lead={<SessionGlyph session={s} />} showsStatus />
          ))}
        </section>
      )}
      {groups.map((g, i) => (
        <ListedGroupSection key={g.key} group={g} mode={mode} noun={noun}>
          {i === 0 && options}
        </ListedGroupSection>
      ))}
      {empty && (
        <section aria-label="Sessions" className="mt-4 flex flex-col gap-px first:mt-0">
          <GroupHeader label={noun === 'task' ? 'Tasks' : 'Sessions'}>{options}</GroupHeader>
          <p className="px-1.5 py-1.5 text-footnote text-fg-muted">
            {view.status === 'archived' ? `No archived ${noun}s.` : sessions?.length ? 'Nothing matches these view options.' : `No ${noun}s yet.`}
          </p>
        </section>
      )}
    </div>
  );
}

/** One group of the list: its header (with the "+" and, for the person's own groups, a name, a fold and a menu) and rows. */
function ListedGroupSection({ group, mode, noun, children }: { group: ListedGroup; mode: 'work' | 'code'; noun: string; children?: ReactNode }) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const custom = group.custom;
  const collapsed = !!custom?.collapsed;
  const fail = (e: unknown) => void toast.error(describeError(e).message);
  const start = group.start
    ? () => void navigate({ to: MODE_HOME[mode], search: group.start! })
    : custom
      ? () => void navigate({ to: MODE_HOME[mode], search: { group: custom.id } })
      : null;
  return (
    <section aria-label={group.label} className="mt-4 flex flex-col gap-px first:mt-0">
      <div className="flex h-6 items-center gap-0.5 pr-0.5 pb-0.5 pl-1.5">
        {custom ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => void rpc().call('groups.update', { id: custom.id, collapsed: !collapsed }).catch(fail)}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-xs text-left outline-none focus-ring"
          >
            <h2 className="truncate text-footnote text-fg-muted">{group.label}</h2>
            <Icon icon={ChevronRight} size="sm" className={cn('shrink-0 text-fg-muted transition-transform', !collapsed && 'rotate-90')} />
          </button>
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-footnote text-fg-muted">{group.label}</h2>
        )}
        {start && (
          <IconButton
            icon={Plus}
            label={group.workspace ? `New ${noun} in ${group.workspace.name}` : custom ? `New ${noun} in ${custom.name}` : `New ${noun} with no folder`}
            size="xs"
            className="text-fg-muted"
            onClick={start}
          />
        )}
        {custom && (
          <Menu>
            <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`Options for ${custom.name}`} size="xs" className="text-fg-muted" />} />
            <MenuContent align="end" className="w-44">
              <MenuItem icon={Pencil} onClick={() => setRenaming(true)}>
                Rename group
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={Trash2} danger onClick={() => setDeleting(true)}>
                Delete group
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
        {children}
      </div>
      {!collapsed && group.sessions.map((s) => <SessionRow key={s.id} session={s} lead={<SessionGlyph session={s} />} showsStatus />)}
      {!collapsed && custom && !group.sessions.length && <p className="px-1.5 py-1.5 text-footnote text-fg-muted">No {noun}s in this group.</p>}
      {custom && (
        <>
          <NameDialog
            open={renaming}
            onOpenChange={setRenaming}
            title="Rename group"
            label="Group name"
            confirm="Save"
            initial={custom.name}
            onSubmit={async (name) => void (await rpc().call('groups.update', { id: custom.id, name }))}
          />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={`Delete ${custom.name}?`}
            description={`Its ${noun}s aren’t deleted: they go back to Ungrouped.`}
            confirmLabel="Delete group"
            onConfirm={async () => {
              try {
                await rpc().call('groups.delete', { id: custom.id });
              } catch (e) {
                fail(e);
              }
            }}
          />
        </>
      )}
    </section>
  );
}

const STATUS_LABELS = { active: 'Active', archived: 'Archived', all: 'All' } as const;
const GROUP_LABELS = { date: 'Date', folder: 'Folder', state: 'State', custom: 'Custom groups', none: 'None' } as const;
const SORT_LABELS = { name: 'Name', created: 'Date created', activity: 'Last activity' } as const;
const ENVIRONMENTS = ['local', 'cloud', 'remote', 'ssh'] as const;

/** The sliders button of the first group: what to list (status, environment) and how (grouping, order). */
function ViewOptions({ view, set, noun }: { view: SidebarView; set(patch: Partial<SidebarView>): void; noun: string }) {
  const everything = view.environments.length >= ENVIRONMENTS.length;
  const toggleEnvironment = (environment: (typeof ENVIRONMENTS)[number], on: boolean) => {
    const next = on ? [...new Set([...view.environments, environment])] : view.environments.filter((e) => e !== environment);
    if (next.length) set({ environments: ENVIRONMENTS.filter((e) => next.includes(e)) });
  };
  const changed = view.status !== 'active' || !everything || view.groupBy !== 'folder' || view.sortBy !== 'activity' || view.showEmptyGroups;
  return (
    <Menu>
      <MenuTrigger
        render={<IconButton icon={SlidersVertical} label={`View options for ${noun}s`} size="xs" className={changed ? 'text-fg' : 'text-fg-muted'} />}
      />
      <MenuContent align="end" className="w-64">
        <MenuSubmenu label="Status" hint={STATUS_LABELS[view.status]}>
          <MenuRadioGroup value={view.status} onValueChange={(v: SidebarView['status']) => set({ status: v })}>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} closeOnClick>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubmenu>
        <MenuSubmenu label="Environment" hint={environmentHint(view.environments)}>
          <MenuCheckboxItem checked={everything} onCheckedChange={(on) => set({ environments: on ? [...ENVIRONMENTS] : ['local'] })}>
            All environments
          </MenuCheckboxItem>
          <MenuSeparator />
          {ENVIRONMENTS.map((environment) => (
            <MenuCheckboxItem
              key={environment}
              checked={view.environments.includes(environment)}
              onCheckedChange={(on) => toggleEnvironment(environment, on)}
            >
              {ENVIRONMENT_LABELS[environment]}
            </MenuCheckboxItem>
          ))}
        </MenuSubmenu>
        <MenuSubmenu label="Group by" hint={GROUP_LABELS[view.groupBy]}>
          <MenuRadioGroup value={view.groupBy} onValueChange={(v: SidebarView['groupBy']) => set({ groupBy: v })}>
            {(['date', 'folder', 'state', 'custom'] as const).map((value) => (
              <MenuRadioItem key={value} value={value} closeOnClick>
                {GROUP_LABELS[value]}
              </MenuRadioItem>
            ))}
            <MenuSeparator />
            <MenuRadioItem value="none" closeOnClick>
              {GROUP_LABELS.none}
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuSubmenu>
        <MenuSubmenu label="Sort by" hint={SORT_LABELS[view.sortBy]}>
          <MenuRadioGroup value={view.sortBy} onValueChange={(v: SidebarView['sortBy']) => set({ sortBy: v })}>
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} closeOnClick>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubmenu>
        <MenuSeparator />
        <MenuCheckboxItem checked={view.showEmptyGroups} onCheckedChange={(on) => set({ showEmptyGroups: on })}>
          Show empty groups
        </MenuCheckboxItem>
      </MenuContent>
    </Menu>
  );
}
