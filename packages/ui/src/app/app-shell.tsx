import { useEffect } from 'react';
import { Outlet } from '@tanstack/react-router';
import { useAppearance } from '../lib/appearance.ts';
import type { ShortcutId } from '@atelier/protocol';
import { desktop, type MenuCommand } from '../lib/platform.ts';
import { pressIs, useShortcutBindings } from '../lib/shortcuts.ts';
import { SidebarToggle, trafficLightInset, useSidebarHidden } from './chrome.tsx';
import { useNarrow } from '../lib/narrow.ts';
import { useLiveQueries, usePrefs } from '../lib/queries.ts';
import { useUi } from '../lib/ui-store.ts';
import { SettingsOverlay } from '../features/settings/settings-overlay.tsx';
import { useTaskNotifications } from '../features/work/notifications.ts';
import { KeepAwakeSync } from '../features/code/keep-awake.tsx';
import { SshPrompts } from '../features/ssh/ssh-prompts.tsx';
import { TrustWorkspaceHost } from '../features/workspaces/trust.tsx';
import { WhatsNewHost } from '../features/whats-new/whats-new.tsx';
import { CommandPalette } from './command-palette.tsx';
import { useLockNow } from '../features/auth/screen-lock.ts';
import { rememberTab, tabOf } from './last-tab.ts';
import { solo } from './solo.ts';
import { useMode, useNewChat, useNewTemporaryChat, useOpenSettings } from './navigation.ts';
import { Sidebar, SidebarDrawer } from './sidebar.tsx';

export function AppShell() {
  useLiveQueries();
  const { prefs } = usePrefs();
  useAppearance(prefs);
  useAppShortcuts();
  useTaskNotifications();
  const narrow = useNarrow();
  const sidebarHidden = useSidebarHidden();
  // The next start opens in the tab you are in now.
  const mode = useMode();
  useEffect(() => (solo ? undefined : rememberTab(tabOf(mode))), [mode]);

  return (
    <div className="flex h-full overflow-hidden bg-bg text-fg">
      {!solo && (narrow ? <SidebarDrawer /> : !sidebarHidden && <Sidebar />)}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {sidebarHidden && !solo && <SidebarToggle className={trafficLightInset ? 'absolute top-3 left-[78px] z-10' : 'absolute top-3 left-3 z-10'} />}
        <Outlet />
      </main>
      <CommandPalette />
      <SettingsOverlay />
      {desktop && <KeepAwakeSync />}
      {desktop && <SshPrompts />}
      {/* Also in the browser: a codespace is opened there, and its question must be asked there. */}
      <TrustWorkspaceHost />
      <WhatsNewHost />
    </div>
  );
}

/** The app's shortcuts and the menu command each one sends. The screen lock is the desktop's ("Run on this computer"). */
const APP_SHORTCUTS: [ShortcutId, MenuCommand][] = [
  ['new-chat', 'new-chat'],
  ['new-temporary-chat', 'new-temporary-chat'],
  ['search', 'command-palette'],
  ['settings', 'settings'],
  ['toggle-sidebar', 'toggle-sidebar'],
];

/**
 * App shortcuts, as the person set them (Settings › Keyboard shortcuts). On desktop the native menu owns the
 * accelerators and forwards them here; the page tells it the bindings.
 */
function useAppShortcuts(): void {
  const newChat = useNewChat();
  const newTemporaryChat = useNewTemporaryChat();
  const openSettings = useOpenSettings();
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const lockNow = useLockNow(openSettings);
  const bindings = useShortcutBindings();

  useEffect(() => desktop?.setShortcuts?.(bindings), [bindings]);

  useEffect(() => {
    const run = (command: MenuCommand) => {
      if (command === 'new-chat') newChat();
      else if (command === 'new-temporary-chat') newTemporaryChat();
      else if (command === 'settings') openSettings();
      else if (command === 'toggle-sidebar') toggleSidebar();
      else if (command === 'lock') lockNow();
      else setPaletteOpen(true);
    };
    if (desktop) return desktop.onMenu(run);
    const onKey = (e: KeyboardEvent) => {
      const command = APP_SHORTCUTS.find(([id]) => pressIs(bindings[id], e))?.[1];
      if (!command) return;
      e.preventDefault();
      run(command);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newChat, newTemporaryChat, openSettings, toggleSidebar, setPaletteOpen, lockNow, bindings]);
}
