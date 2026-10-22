/**
 * The right-click menu of a file or folder in the Files pane (design/components.md › Files): attach it to the message,
 * copy its path, open it elsewhere (the Browser pane, an editor, Finder), and for a folder a terminal in it. The tree and
 * the search results share it; the keyboard's menu key or Shift+F10 opens it under the row.
 */
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { AtSign, Copy, FolderSearch, SquareArrowOutUpRight, SquareTerminal } from 'lucide-react';
import type { WorkspaceSummary } from '@atelier/protocol';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSubmenu, toast } from '../../components/ui/index.ts';
import { desktop, isMac, os } from '../../lib/platform.ts';
import { absolutePath } from '../work/output-files.ts';
import { opensInBrowser } from './workspace-pages.ts';
import { environmentOf } from './workspaces.ts';

/** What the pane's rows can do beyond opening in the viewer; absent handlers leave their items out. */
export interface FileActions {
  workspace: WorkspaceSummary;
  /** Shows a workspace file in the Browser pane. */
  onOpenInBrowser?(path: string): void;
  /** Puts a reference to the file or folder in the session's message box. */
  onAttach?(path: string, kind: 'file' | 'dir'): void;
  /** Starts a terminal in the folder, in the session's Terminal pane. */
  onOpenTerminal?(dir: string): void;
}

export interface FileTarget {
  /** Relative to the workspace root, with `/`. */
  path: string;
  kind: 'file' | 'dir';
}

const REVEAL_LABEL = isMac ? 'Show in Finder' : os === 'win32' ? 'Show in Explorer' : 'Show in folder';

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A row's handlers and the menu to render beside it. */
export function useFileMenu(target: FileTarget, actions: FileActions) {
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const anchor = useMemo(
    () => (pointer ? { getBoundingClientRect: () => DOMRect.fromRect({ x: pointer.x, y: pointer.y, width: 0, height: 0 }) } : undefined),
    [pointer],
  );
  const underRow = (el: HTMLElement) => {
    const row = el.getBoundingClientRect();
    setPointer({ x: row.left + 8, y: row.bottom });
  };
  return {
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      // Right-clicks in the open menu reach here through the React tree, though it is portalled elsewhere.
      if (!e.currentTarget.contains(e.target as Node)) return;
      e.preventDefault();
      // The keyboard's menu key has no pointer: the menu opens under the row.
      if (e.clientX || e.clientY) setPointer({ x: e.clientX, y: e.clientY });
      else underRow(e.currentTarget);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget || !(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
      e.preventDefault();
      underRow(e.currentTarget);
    },
    menu: pointer && (
      <Menu open onOpenChange={(open) => !open && setPointer(null)}>
        <MenuContent anchor={anchor} className="w-56">
          <FileMenuItems target={target} actions={actions} />
        </MenuContent>
      </Menu>
    ),
  };
}

function FileMenuItems({ target: { path, kind }, actions: { workspace, onOpenInBrowser, onAttach, onOpenTerminal } }: { target: FileTarget; actions: FileActions }) {
  const name = baseName(path);
  // Editors and Finder are the desktop app's, for folders on this computer (as the sidebar's session menu).
  const local = !!desktop && environmentOf(workspace, desktop.device.id) === 'local' && workspace.available;
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).catch(() => toast.error('Couldn’t copy to the clipboard.'));
  const editor = (which: 'cursor' | 'vscode') => async () => {
    if (!(await desktop!.files.openIn(which, absolutePath(workspace, path)))) toast.error(`Couldn’t open ${name} in ${which === 'cursor' ? 'Cursor' : 'VS Code'}. Is it installed?`);
  };
  const reveal = async () => {
    if (!(await desktop!.files.reveal(absolutePath(workspace, path)))) toast.error(`${name} isn’t in a folder you opened on this computer.`);
  };
  const openers: { label: string; run(): void | Promise<void> }[] = [
    ...(kind === 'file' && onOpenInBrowser && opensInBrowser(path) ? [{ label: 'Browser pane', run: () => onOpenInBrowser(path) }] : []),
    ...(local
      ? [
          { label: 'Cursor', run: editor('cursor') },
          { label: 'VS Code', run: editor('vscode') },
        ]
      : []),
  ];
  const terminal = kind === 'dir' && onOpenTerminal;
  return (
    <>
      {onAttach && (
        <MenuItem icon={AtSign} onClick={() => onAttach(path, kind)}>
          Attach as context
        </MenuItem>
      )}
      <MenuSubmenu label="Copy" icon={Copy}>
        <MenuItem onClick={() => copy(absolutePath(workspace, path))}>Absolute path</MenuItem>
        <MenuItem onClick={() => copy(path)}>Relative path</MenuItem>
        <MenuItem onClick={() => copy(name)}>Filename</MenuItem>
      </MenuSubmenu>
      {(openers.length > 0 || local) && <MenuSeparator />}
      {openers.length > 0 && (
        <MenuSubmenu label="Open in" icon={SquareArrowOutUpRight}>
          {openers.map((o) => (
            <MenuItem key={o.label} onClick={() => void o.run()}>
              {o.label}
            </MenuItem>
          ))}
        </MenuSubmenu>
      )}
      {local && (
        <MenuItem icon={FolderSearch} onClick={() => void reveal()}>
          {REVEAL_LABEL}
        </MenuItem>
      )}
      {terminal && (
        <>
          <MenuSeparator />
          <MenuItem icon={SquareTerminal} onClick={() => terminal(path)}>
            Open in terminal
          </MenuItem>
        </>
      )}
    </>
  );
}
