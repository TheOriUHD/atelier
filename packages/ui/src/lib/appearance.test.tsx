import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs, type UserPrefs } from '@atelier/protocol';
import { emit, resetBackend } from '../features/settings/test-backend.ts';
import { useAppearance } from './appearance.ts';
import { useLiveQueries, usePrefs } from './queries.ts';

vi.mock('./rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../features/settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** What the app shell does: the signed-in person's appearance preferences, kept live. */
function Shell() {
  useLiveQueries();
  useAppearance(usePrefs().prefs);
  return null;
}

const prefs = (appearance: Partial<UserPrefs['appearance']>, code: Partial<UserPrefs['code']> = {}): UserPrefs => {
  const base = defaultUserPrefs();
  return { ...base, appearance: { ...base.appearance, ...appearance }, code: { ...base.code, ...code } };
};

function renderShell() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Shell />
    </QueryClientProvider>,
  );
}

describe('appearance', () => {
  it('follows the person’s preferences, and their changes from any device', async () => {
    resetBackend({ 'prefs.get': () => prefs({ theme: 'dark', chatFont: 'sans', textSize: 'l', transcriptWidth: 'wide', motion: 'reduced' }) });
    renderShell();
    const html = document.documentElement;

    await waitFor(() => expect(html.dataset.theme).toBe('dark'));
    expect({ ...html.dataset }).toMatchObject({ chatFont: 'sans', textSize: 'l', transcriptWidth: 'wide', motion: 'reduced' });

    act(() => emit('prefs.changed', prefs({ theme: 'light', chatFont: 'dyslexic' })));

    await waitFor(() => expect(html.dataset.theme).toBe('light'));
    expect(html.dataset.chatFont).toBe('dyslexic');
  });

  it('applies the interface font, the code font and the syntax themes from Settings › Code', async () => {
    resetBackend({
      'prefs.get': () => prefs({ interfaceFont: 'dyslexic' }, { font: ' Fira Code ', syntaxTheme: { light: 'github-light', dark: 'dracula' } }),
    });
    renderShell();
    const html = document.documentElement;

    await waitFor(() => expect(html.dataset.uiFont).toBe('dyslexic'));
    expect({ ...html.dataset }).toMatchObject({ syntaxLight: 'github-light', syntaxDark: 'dracula' });
    expect(html.style.getPropertyValue('--at-font-code')).toBe('"Fira Code", var(--at-font-mono)');

    // An empty code font goes back to the bundled one.
    act(() => emit('prefs.changed', prefs({ interfaceFont: 'system' })));

    await waitFor(() => expect(html.dataset.uiFont).toBe('system'));
    expect(html.style.getPropertyValue('--at-font-code')).toBe('');
    expect({ ...html.dataset }).toMatchObject({ syntaxLight: 'atelier-light', syntaxDark: 'atelier-dark' });
  });
});
