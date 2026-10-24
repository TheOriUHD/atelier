/** Pieces the Chat and Code session pages share: the header, following the stream, the context meter and the built-in commands. */
import { useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowDown, Box, ChevronDown, FoldVertical, Pencil, Pin, PinOff, Repeat, SquarePen, Trash2, X } from 'lucide-react';
import { formatInterval, parseLoopCommand, type SessionSummary } from '@atelier/protocol';
import { ConfirmDialog, Icon, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, ThinkingDots, cn, toast } from '../../components/ui/index.ts';
import { trafficLightInset, useSidebarHidden } from '../../app/chrome.tsx';
import { MODE_HOME } from '../../app/navigation.ts';
import { RenameDialog } from '../../app/session-rows.tsx';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useSplitCell } from '../../lib/split-cell.tsx';
import { isLocal } from '../auth/screen-lock.ts';
import { usePrefs } from '../../lib/queries.ts';
import { sessionNoun, sessionTitle } from '../../lib/sessions.ts';
import type { SlashCommand } from './composer-menu.tsx';

/** How long a smooth scroll to the bottom keeps the reader's own scroll events from ending the following. */
const SMOOTH_MS = 700;

/**
 * Follows new content while the reader is at the bottom; stays put once they scroll up. `followSmooth` is for the
 * moment a message is sent (and the arrow button): it brings the reader down to the new message with a scroll
 * animation instead of leaving them where they were.
 */
export function useFollowScroll(content: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Until then the page scrolls to the bottom with an animation, and its scroll events aren't the reader's.
  const smoothUntil = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !atBottom) return;
    if (Date.now() < smoothUntil.current && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }, [content, atBottom]);
  return {
    ref,
    atBottom,
    follow: () => setAtBottom(true),
    followSmooth: () => {
      smoothUntil.current = Date.now() + SMOOTH_MS;
      setAtBottom(true);
      // At the bottom already, nothing about the state changes: bring the end into view in case the content grew.
      const el = ref.current;
      if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    },
    onScroll: (e: UIEvent<HTMLElement>) => {
      if (Date.now() < smoothUntil.current) return;
      const el = e.currentTarget;
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
    },
  };
}

/** The arrow that brings a reader who scrolled up back down; while the model works it shows that it still does. */
export function ScrollToBottom({ onClick, working = false }: { onClick(): void; working?: boolean }) {
  return (
    <button
      type="button"
      aria-label={working ? 'Scroll to bottom, still working' : 'Scroll to bottom'}
      onClick={onClick}
      className={cn(
        'absolute bottom-6 left-1/2 flex h-8 -translate-x-1/2 items-center justify-center gap-1.5 rounded-full bg-popover text-fg-secondary shadow-popover outline-none focus-ring hover:text-fg',
        working ? 'px-3' : 'w-8',
      )}
    >
      <Icon icon={ArrowDown} />
      {working && <ThinkingDots aria-hidden="true" />}
    </button>
  );
}

/** Summarizes the conversation so far (Code: `/compact [focus]` and the context popover's Compact session). */
export function compactSession(sessionId: string, focus?: string): void {
  // The conversation itself shows the command, the compacting line and the divider: only a failure needs a word here.
  void rpc()
    .call('chat.compact', { sessionId, ...(focus ? { focus } : {}) })
    .catch((e: unknown) => toast.error(describeError(e).message));
}

export function compactCommand(sessionId: string): SlashCommand {
  return {
    name: 'compact',
    description: 'Summarize the conversation so far to free up context',
    argumentHint: '[focus]',
    icon: FoldVertical,
    run: (focus) => compactSession(sessionId, focus),
  };
}

/**
 * `/loop [interval] <prompt>` (Code and Cowork): sends the prompt now and again every interval while the session is
 * idle. `/loop` alone shows the session's loops (`list`), `/loop stop [n]` stops them. The backend keeps the loops.
 */
export function loopCommand(sessionId: string, list: () => void): SlashCommand {
  return {
    name: 'loop',
    description: 'Send a prompt now and again every interval while the session is idle',
    argumentHint: '[interval] <prompt>',
    icon: Repeat,
    run: (args) => void runLoopCommand(sessionId, args, list),
  };
}

async function runLoopCommand(sessionId: string, args: string, list: () => void): Promise<void> {
  const command = parseLoopCommand(args);
  try {
    switch (command.action) {
      case 'error':
        toast.error(command.message);
        return;
      case 'list':
        list();
        return;
      case 'stop': {
        const { stopped } = await rpc().call('loops.stop', { sessionId, target: command.target });
        if (stopped) toast.success(stopped === 1 ? 'Stopped the loop.' : `Stopped ${stopped} loops.`);
        else toast.error(command.target ? `There is no loop “${command.target}” in this session.` : 'This session has no loops running.');
        return;
      }
      case 'start': {
        const { intervalMs } = await rpc().call('loops.start', { sessionId, prompt: command.prompt, intervalMs: command.intervalMs });
        const rounded = intervalMs > command.intervalMs ? ' (the shortest interval)' : '';
        toast.success(`Loop started: every ${formatInterval(intervalMs)}${rounded}`, { description: command.prompt });
      }
    }
  } catch (e) {
    toast.error(describeError(e).message);
  }
}

export function clearCommand(startNew: () => void): SlashCommand {
  return { name: 'clear', description: 'Start a new session', icon: SquarePen, run: startNew };
}

export function modelCommand(openPicker: () => void): SlashCommand {
  return { name: 'model', description: 'Choose the model', icon: Box, run: openPicker };
}

/** 48px header: the title menu (pin, rename, delete), then `children` (Code adds the workspace and pane toggle). */
export function SessionHeader({ session, children }: { session: SessionSummary | null; children?: ReactNode }) {
  const sidebarHidden = useSidebarHidden();
  const { prefs } = usePrefs();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // In a split view each cell has its own header, and the second one doesn't sit under the window's controls.
  const cell = useSplitCell();

  return (
    <header
      className={cn(
        'app-drag flex h-(--at-layout-header-height) shrink-0 items-center gap-2 pl-4',
        !cell || cell.last ? 'pr-[calc(var(--at-window-controls)+1rem)]' : 'pr-4',
        sidebarHidden && (!cell || cell.first) && (trafficLightInset ? 'pl-[112px]' : 'pl-11'),
      )}
    >
      {session && (
        <Menu>
          <MenuTrigger className="app-no-drag flex h-7 max-w-[min(480px,60%)] min-w-0 items-center gap-1 rounded-md px-2 text-body text-fg outline-none focus-ring hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover">
            <span className="truncate">{sessionTitle(session)}</span>
            <Icon icon={ChevronDown} className="text-fg-muted" />
          </MenuTrigger>
          <MenuContent className="w-52">
            <MenuItem icon={session.pinnedAt ? PinOff : Pin} onClick={() => void rpc().call('sessions.update', { id: session.id, pinned: !session.pinnedAt })}>
              {session.pinnedAt ? 'Unpin' : 'Pin'}
            </MenuItem>
            <MenuItem icon={Pencil} onClick={() => setRenaming(true)}>
              Rename
            </MenuItem>
            {!isLocal() && <MenuItem disabled={prefs?.remoteControl === false} onClick={() => void rpc().call('sessions.update', { id: session.id, remoteControl: session.remoteControl === false }).catch((error: unknown) => toast.error(describeError(error).message))}>
              {prefs?.remoteControl === false ? 'Remote control disabled in account' : `Remote control: ${session.remoteControl === false ? 'Off' : 'On'}`}
            </MenuItem>}
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onClick={() => setDeleting(true)}>
              Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
      {children}
      {cell && <IconButton icon={X} label="Close split view" size="sm" className="app-no-drag text-fg-secondary" onClick={cell.close} />}
      {session && (
        <>
          <RenameDialog session={session} open={renaming} onOpenChange={setRenaming} />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={`Delete ${sessionNoun(session)}?`}
            description={`“${sessionTitle(session)}” and its artifacts will be deleted. This can’t be undone.`}
            onConfirm={async () => {
              await rpc().call('sessions.delete', { id: session.id });
              void navigate({ to: MODE_HOME[session.mode] });
            }}
          />
        </>
      )}
    </header>
  );
}
