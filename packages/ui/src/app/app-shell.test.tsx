import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { requestTrust } from '../features/workspaces/trust.tsx';
import { AppShell } from './app-shell.tsx';

// The shell's own pieces are not under test here, only what it mounts for every window.
vi.mock('@tanstack/react-router', () => ({ Outlet: () => null }));
vi.mock('../lib/appearance.ts', () => ({ useAppearance: () => {} }));
vi.mock('../lib/narrow.ts', () => ({ useNarrow: () => false }));
vi.mock('../lib/queries.ts', () => ({ useLiveQueries: () => {}, usePrefs: () => ({ prefs: undefined }) }));
vi.mock('../lib/ui-store.ts', () => ({ useUi: () => () => {} }));
vi.mock('../features/settings/settings-overlay.tsx', () => ({ SettingsOverlay: () => null }));
vi.mock('../features/work/notifications.ts', () => ({ useTaskNotifications: () => {} }));
vi.mock('../features/code/keep-awake.tsx', () => ({ KeepAwakeSync: () => null }));
vi.mock('../features/ssh/ssh-prompts.tsx', () => ({ SshPrompts: () => null }));
vi.mock('../features/auth/screen-lock.ts', () => ({ useLockNow: () => () => {} }));
vi.mock('./chrome.tsx', () => ({ SidebarToggle: () => null, trafficLightInset: false, useSidebarHidden: () => true }));
vi.mock('./command-palette.tsx', () => ({ CommandPalette: () => null }));
vi.mock('../features/whats-new/whats-new.tsx', () => ({ WhatsNewHost: () => null }));
vi.mock('./sidebar.tsx', () => ({ Sidebar: () => null, SidebarDrawer: () => null }));
vi.mock('./navigation.ts', () => ({ useMode: () => 'chat', useNewChat: () => () => {}, useNewTemporaryChat: () => () => {}, useOpenSettings: () => () => {} }));

describe('the app shell', () => {
  it('asks "Trust this workspace?" in the browser too, where a codespace is opened', async () => {
    // No desktop bridge: this is a page in a browser.
    render(<AppShell />);
    let answer!: Promise<boolean>;
    act(() => {
      answer = requestTrust('acme/api', 'a GitHub codespace');
    });
    const dialog = await screen.findByRole('dialog', { name: 'Trust this workspace?' });
    expect(dialog.textContent).toContain('acme/api');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Without a window to ask in, the question would have been answered yes by itself.
    expect(await answer).toBe(false);
  });
});
