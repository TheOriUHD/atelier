/**
 * The menu of a Code or Cowork session in the sidebar (design/components.md › Sidebar): open it elsewhere, pin, mark
 * unread, rename, fork, file it under a group, archive, delete. Its keys work while it is open: the letter beside an
 * item, and the numbers in the submenus.
 */
import { Archive, ArchiveRestore, Check, CopyPlus, EyeOff, FolderTree, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import type { KeyboardEvent } from 'react';
import type { SessionGroup, SessionSummary, WorkspaceSummary } from '@atelier/protocol';
import { Icon, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator, MenuSubmenu, toast, type MenuContentProps } from '../components/ui/index.ts';
import { desktop } from '../lib/platform.ts';
import { describeError, rpc } from '../lib/rpc.ts';
import { environmentOf } from '../features/code/workspaces.ts';
import { SESSION_ROUTE } from './navigation.ts';
import { SOLO_PARAM } from './solo.ts';
import { useCodeSplit } from './split-nav.ts';

interface Props {
  session: SessionSummary;
  /** The folder the session runs in, when known. */
  workspace: WorkspaceSummary | undefined;
  groups: readonly SessionGroup[];
  onRename(): void;
  onDelete(): void;
  onNewGroup(): void;
  close(): void;
  /** Where it opens instead of at the ⋯ button (a right-click's pointer). */
  anchor?: MenuContentProps['anchor'];
}

const NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function SessionMenuContent({ session, workspace, groups, onRename, onDelete, onNewGroup, close, anchor }: Props) {
  const navigate = useNavigate();
  const fail = (e: unknown) => void toast.error(describeError(e).message);
  const update = (patch: { pinned?: boolean; groupId?: string | null; archived?: boolean; unread?: boolean }) =>
    void rpc()
      .call('sessions.update', { id: session.id, ...patch })
      .catch(fail);
  const unread = !!session.finishedUnseen;
  const archived = session.archivedAt != null;

  const fork = () =>
    void rpc()
      .call('sessions.fork', { id: session.id })
      .then((copy) => navigate({ to: SESSION_ROUTE[copy.mode], params: { sessionId: copy.id } }))
      .catch(fail);
  const markRead = () => void rpc().call('sessions.markSeen', { id: session.id }).catch(fail);

  // Split view: this session next to the active one (Code sessions only; where none is open it simply opens).
  const codeSplit = useCodeSplit();
  const splittable = session.mode === 'code' && !codeSplit.cells.includes(session.id);
  const split = () => {
    if (!codeSplit.addNextTo(session.id)) void navigate({ to: SESSION_ROUTE[session.mode], params: { sessionId: session.id } });
  };

  // Opening elsewhere is the desktop app's: another window, the folder in an editor or in Finder.
  const local = !!desktop && !!workspace && environmentOf(workspace, desktop.device.id) === 'local' && workspace.available;
  const newWindow = () => void desktop?.openWindow(`#/${session.mode}/${session.id}?${SOLO_PARAM}`);
  const editor = (which: 'cursor' | 'vscode') => async () => {
    if (!(await desktop!.files.openIn(which, workspace!.root))) toast.error(`Couldn’t open the folder in ${which === 'cursor' ? 'Cursor' : 'VS Code'}. Is it installed?`);
  };
  const finder = async () => {
    if (!(await desktop!.files.reveal(workspace!.root))) toast.error('That folder isn’t one you opened on this computer.');
  };
  const openers: { label: string; run(): void | Promise<void> }[] = local
    ? [
        { label: 'Cursor', run: editor('cursor') },
        { label: 'VS Code', run: editor('vscode') },
        { label: 'Finder', run: finder },
      ]
    : [];

  // Where else it can open: beside the session open now, or in another window (the desktop app's).
  const places: { label: string; run(): void | Promise<void> }[] = [
    ...(splittable ? [{ label: 'Split view', run: split }] : []),
    ...(desktop ? [{ label: 'New window', run: newWindow }] : []),
  ];

  // The first nine groups answer to their number; "Ungrouped" and "New group…" have no key.
  const file = (group: SessionGroup | null) => () => update({ groupId: group?.id ?? null });

  const keyed = (e: KeyboardEvent, actions: Record<string, () => void>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const action = actions[e.key.toLowerCase()];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    close();
    action();
  };
  const numbered = (actions: (() => void)[]) => Object.fromEntries(actions.slice(0, 9).map((a, i) => [NUMBERS[i]!, a]));

  return (
    <MenuContent
      align="start"
      anchor={anchor}
      className="w-60"
      onClick={(e) => e.preventDefault()}
      onKeyDown={(e) =>
        keyed(e, {
          p: () => update({ pinned: !session.pinnedAt }),
          u: () => (unread ? markRead() : update({ unread: true })),
          r: onRename,
          f: fork,
          a: () => update({ archived: !archived }),
          d: onDelete,
        })
      }
    >
      {(desktop || splittable) && (
        <>
          <MenuSubmenu label="Open in" onKeyDown={(e) => keyed(e, numbered([...places, ...openers].map((p) => () => void p.run())))}>
            {places.map((p, i) => (
              <MenuItem key={p.label} shortcut={NUMBERS[i]} onClick={() => void p.run()}>
                {p.label}
              </MenuItem>
            ))}
            {openers.length > 0 && (
              <>
                <MenuSeparator />
                {/* A label belongs to a group (Base UI throws without one). */}
                <MenuGroup>
                  <MenuLabel>Open in</MenuLabel>
                  {openers.map((o, i) => (
                    <MenuItem key={o.label} shortcut={NUMBERS[places.length + i]} onClick={() => void o.run()}>
                      {o.label}
                    </MenuItem>
                  ))}
                </MenuGroup>
              </>
            )}
          </MenuSubmenu>
          <MenuSeparator />
        </>
      )}
      <MenuItem icon={session.pinnedAt ? PinOff : Pin} shortcut="P" onClick={() => update({ pinned: !session.pinnedAt })}>
        {session.pinnedAt ? 'Unpin' : 'Pin'}
      </MenuItem>
      <MenuItem icon={EyeOff} shortcut="U" onClick={() => (unread ? markRead() : update({ unread: true }))}>
        {unread ? 'Mark as read' : 'Mark as unread'}
      </MenuItem>
      <MenuItem icon={Pencil} shortcut="R" onClick={onRename}>
        Rename
      </MenuItem>
      <MenuItem icon={CopyPlus} shortcut="F" onClick={fork}>
        Fork
      </MenuItem>
      <MenuSeparator />
      <MenuSubmenu label="Move to group" icon={FolderTree} onKeyDown={(e) => keyed(e, numbered(groups.map((g) => file(g))))}>
        {groups.map((g, i) => (
          <MenuItem
            key={g.id}
            onClick={file(g)}
            shortcut={
              <span className="flex items-center gap-2">
                {session.groupId === g.id && <Icon icon={Check} size="sm" className="text-interactive" />}
                {NUMBERS[i]}
              </span>
            }
          >
            {g.name}
          </MenuItem>
        ))}
        {groups.length > 0 && <MenuSeparator />}
        <MenuItem disabled={!session.groupId} onClick={file(null)}>
          Ungrouped
        </MenuItem>
        <MenuItem onClick={onNewGroup}>New group…</MenuItem>
      </MenuSubmenu>
      <MenuSeparator />
      <MenuItem icon={archived ? ArchiveRestore : Archive} shortcut="A" onClick={() => update({ archived: !archived })}>
        {archived ? 'Unarchive' : 'Archive'}
      </MenuItem>
      <MenuItem icon={Trash2} danger shortcut="D" onClick={onDelete}>
        Delete
      </MenuItem>
    </MenuContent>
  );
}
