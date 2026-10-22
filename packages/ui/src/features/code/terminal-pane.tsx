/**
 * The Terminal pane (design/components.md › Code panes): one shell, or several in tabs. "+" in the header starts another;
 * the tab strip shows once there is more than one, each tab with its own ×. Closing the last tab closes the pane. Files ›
 * Open in terminal starts one in a folder of the workspace.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Plus, X } from 'lucide-react';
import type { WorkspaceSummary } from '@atelier/protocol';
import { IconButton, MenuItem, Spinner, cn } from '../../components/ui/index.ts';
import { PaneMessage } from './file-tree.tsx';
import { PaneFrame, PaneTitle, type PaneFrameState } from './pane-dock.tsx';
import type { TerminalHandle } from './terminal-panel.tsx';

const TerminalPanel = lazy(() => import('./terminal-panel.tsx'));

/**
 * Commands waiting for the terminal (a code block's Run button): the pane may not be open yet, or its shell still
 * starting, so they are kept until a shell takes them.
 */
export class TerminalCommands {
  private items: string[] = [];
  private listeners = new Set<() => void>();

  push(command: string): void {
    this.items.push(command);
    for (const listener of [...this.listeners]) listener();
  }

  /** What waits, oldest first; it is not kept after. */
  take(): string[] {
    return this.items.splice(0);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Folders to start a terminal in (Files › Open in terminal), waiting for the session's Terminal pane. */
export class TerminalFolders {
  private items: string[] = [];
  private listeners = new Set<() => void>();

  push(dir: string): void {
    this.items.push(dir);
    for (const listener of [...this.listeners]) listener();
  }

  /** What waits, oldest first, without taking it. */
  peek(): readonly string[] {
    return this.items;
  }

  take(): string[] {
    return this.items.splice(0);
  }

  /** Folders pushed before the pane opened are announced just after it subscribes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.items.length) queueMicrotask(() => this.listeners.has(listener) && listener());
    return () => this.listeners.delete(listener);
  }
}

interface Tab {
  id: number;
  /** Where its shell starts, relative to the workspace root; the root when absent. */
  dir?: string;
}

export function TerminalPane({
  frame,
  workspace,
  commands,
  folders,
}: {
  frame: PaneFrameState;
  workspace: WorkspaceSummary | undefined;
  commands?: TerminalCommands;
  folders?: TerminalFolders;
}) {
  // Opened for a folder: its terminal is the first, rather than one in the root beside it.
  const [seed] = useState(() => [...(folders?.peek() ?? [])]);
  const [tabs, setTabs] = useState<Tab[]>(() => (seed.length ? seed.map((dir, i) => ({ id: i + 1, dir })) : [{ id: 1 }]));
  const [active, setActive] = useState(() => Math.max(1, seed.length));
  const seeded = useRef(seed.length);
  const handles = useRef(new Map<number, TerminalHandle>());
  const usable = workspace?.available ? workspace : null;
  // Waiting commands go to the shown shell once it exists, and are run (not just typed) there.
  const activeTab = useRef(active);
  useEffect(() => {
    activeTab.current = active;
  }, [active]);
  const drain = useCallback(() => {
    const handle = handles.current.get(activeTab.current);
    if (!handle || !commands) return;
    for (const command of commands.take()) handle.run(command);
  }, [commands]);
  const available = !!usable;
  useEffect(() => {
    if (!available || !commands) return;
    drain();
    return commands.subscribe(drain);
  }, [available, commands, drain]);
  const lastId = useRef(Math.max(1, seed.length));
  const add = useCallback((dir?: string) => {
    const id = ++lastId.current;
    setTabs((current) => [...current, dir ? { id, dir } : { id }]);
    setActive(id);
  }, []);
  useEffect(
    () =>
      folders?.subscribe(() => {
        const dirs = folders.take().slice(seeded.current);
        seeded.current = 0;
        for (const dir of dirs) add(dir);
      }),
    [folders, add],
  );
  const close = (tab: number) => {
    const rest = tabs.filter((t) => t.id !== tab);
    if (!rest.length) return frame.close();
    setTabs(rest);
    if (active === tab) setActive(rest[Math.max(0, tabs.findIndex((t) => t.id === tab) - 1)]!.id);
  };
  const name = (tab: number) => (tabs.length > 1 ? `Terminal ${tab}` : 'Terminal');

  const newTab = usable && <IconButton icon={Plus} label="New terminal" size="xs" className="shrink-0 text-fg-secondary" onClick={() => add()} />;

  return (
    <PaneFrame
      frame={frame}
      title="Terminal"
      start={
        tabs.length > 1 ? (
          // The tabs are the header, "+" after the last one.
          <div role="group" aria-label="Terminals" className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {tabs.map(({ id: tab, dir }) => (
              <div
                key={tab}
                title={dir}
                className={cn(
                  'flex h-7 shrink-0 items-center rounded-lg pr-1 text-control-sm text-fg-secondary hover:bg-fill-ghost-hover',
                  active === tab && 'bg-fill-ghost-selected text-fg hover:bg-fill-ghost-selected',
                )}
              >
                <button
                  type="button"
                  aria-current={active === tab || undefined}
                  onClick={() => {
                    setActive(tab);
                    handles.current.get(tab)?.focus();
                  }}
                  className="h-full rounded-lg pr-1.5 pl-2.5 outline-none focus-ring"
                >
                  {name(tab)}
                </button>
                <IconButton icon={X} label={`Close ${name(tab)}`} size="xs" className="size-5 text-fg-muted" onClick={() => close(tab)} />
              </div>
            ))}
            {newTab}
          </div>
        ) : (
          <>
            <PaneTitle>Terminal</PaneTitle>
            {newTab}
          </>
        )
      }
      menu={
        usable && (
          <>
            <MenuItem icon={Plus} onClick={() => add()}>
              New terminal
            </MenuItem>
            <MenuItem icon={Eraser} onClick={() => handles.current.get(active)?.clear()}>
              Clear
            </MenuItem>
          </>
        )
      }
    >
      {!usable ? (
        <PaneMessage>{workspace ? 'This folder’s computer is offline.' : 'This session has no folder.'}</PaneMessage>
      ) : (
        <>
          {tabs.map(({ id: tab, dir }) => (
            <div
              key={tab}
              // Hidden terminals keep running (and keep their size) behind the shown one.
              className={cn('flex min-h-0 flex-1 flex-col', active !== tab && 'hidden')}
            >
              <Suspense fallback={<Spinner label="Starting the terminal" className="m-4 text-fg-muted" />}>
                <TerminalPanel
                  workspaceId={usable.id}
                  dir={dir}
                  label={name(tab)}
                  ref={(handle) => {
                    if (handle) {
                      handles.current.set(tab, handle);
                      drain();
                    } else handles.current.delete(tab);
                  }}
                />
              </Suspense>
            </div>
          ))}
        </>
      )}
    </PaneFrame>
  );
}
