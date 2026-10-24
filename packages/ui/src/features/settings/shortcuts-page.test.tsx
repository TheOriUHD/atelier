import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs, type UserPrefs } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { isMac } from '../../lib/platform.ts';
import { ShortcutsPage } from './shortcuts-page.tsx';
import { callsTo, resetBackend } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const MOD = isMac ? '⌘' : 'Ctrl';
const mod = isMac ? { metaKey: true } : { ctrlKey: true };

/** A backend that keeps the person's shortcut changes. */
function renderPage(shortcuts: UserPrefs['shortcuts'] = {}) {
  let prefs: UserPrefs = { ...defaultUserPrefs(), shortcuts };
  resetBackend({
    'prefs.get': () => prefs,
    'prefs.set': (input) => {
      const { path, value } = input as { path: string[]; value: string | null };
      prefs = { ...prefs, shortcuts: { ...prefs.shortcuts, [path[1]!]: value } };
      return prefs;
    },
    'prefs.reset': (input) => {
      const { path } = input as { path: string[] };
      const next = { ...prefs.shortcuts };
      if (path[1]) delete next[path[1] as keyof typeof next];
      prefs = { ...prefs, shortcuts: path[1] ? next : {} };
      return prefs;
    },
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}>
      <TooltipProvider>
        <ShortcutsPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The row of an action, by its label. */
const row = (label: string) => screen.getByRole('group', { name: label });
const keys = (label: string) => [...row(label).querySelectorAll('kbd')].map((k) => k.textContent);

describe('Settings › Shortcuts', () => {
  it('records a new shortcut, and refuses one another action or the system uses', async () => {
    renderPage();
    await waitFor(() => expect(keys('Search')).toEqual([MOD, 'K']));
    // The screen lock is only on "Run on this computer"; Send and the other typing keys can't be changed.
    expect(screen.queryByText('Lock Atelier')).toBeNull();
    expect(within(row('Send')).queryByRole('button')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Change the shortcut for Search' }));
    const recorder = screen.getByRole('button', { name: 'Search' });
    expect(document.activeElement).toBe(recorder);
    fireEvent.keyDown(recorder, { key: 'Meta', code: 'MetaLeft', ...mod });
    fireEvent.keyDown(recorder, { key: 'b', code: 'KeyB', ...mod });
    expect(screen.getByRole('alert').textContent).toBe(`${isMac ? '⌘B' : 'Ctrl+B'} already does “Show or hide the sidebar”.`);
    fireEvent.keyDown(recorder, { key: 'c', code: 'KeyC', ...mod });
    expect(screen.getByRole('alert').textContent).toBe(`${isMac ? '⌘C' : 'Ctrl+C'} is Copy.`);
    fireEvent.keyDown(recorder, { key: 'j', code: 'KeyJ' });
    expect(screen.getByRole('alert').textContent).toContain('so the shortcut doesn’t type text');
    expect(callsTo('prefs.set')).toEqual([]);

    fireEvent.keyDown(recorder, { key: 'j', code: 'KeyJ', ...mod });
    await waitFor(() => expect(keys('Search')).toEqual([MOD, 'J']));
    expect(callsTo('prefs.set')).toEqual([{ path: ['shortcuts', 'search'], value: 'Mod+J' }]);
    expect(row('Search').textContent).toContain(`Default: ${MOD} K`);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cancels with Esc, turns one off, resets one and all', async () => {
    renderPage({ search: 'Mod+J' });
    await waitFor(() => expect(keys('Search')).toEqual([MOD, 'J']));

    fireEvent.click(screen.getByRole('button', { name: 'Change the shortcut for New temporary chat' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'New temporary chat' }), { key: 'Escape', code: 'Escape' });
    expect(screen.queryByText('Press the new shortcut')).toBeNull();
    expect(keys('New temporary chat')).toEqual([MOD, 'Shift', 'N']);

    fireEvent.click(screen.getByRole('button', { name: 'Turn off the shortcut for Upload or add files' }));
    await waitFor(() => expect(row('Upload or add files').textContent).toContain('Off'));
    expect(callsTo('prefs.set')).toEqual([{ path: ['shortcuts', 'upload'], value: null }]);

    // Back to the default is no change at all: nothing is kept for it.
    fireEvent.click(screen.getByRole('button', { name: 'Change the shortcut for Upload or add files' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Upload or add files' }), { key: 'u', code: 'KeyU', ...mod });
    await waitFor(() => expect(keys('Upload or add files')).toEqual([MOD, 'U']));
    expect(callsTo('prefs.reset')).toEqual([{ path: ['shortcuts', 'upload'] }]);

    fireEvent.click(screen.getByRole('button', { name: 'Reset the shortcut for Search' }));
    await waitFor(() => expect(keys('Search')).toEqual([MOD, 'K']));

    fireEvent.click(screen.getByRole('button', { name: 'Change the shortcut for Settings' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Settings' }), { key: 'F6', code: 'F6' });
    await waitFor(() => expect(keys('Settings')).toEqual(['F6']));
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));
    await waitFor(() => expect(keys('Settings')).toEqual([MOD, ',']));
    expect(callsTo('prefs.reset').at(-1)).toEqual({ path: ['shortcuts'] });
    expect((screen.getByRole('button', { name: 'Reset all' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
