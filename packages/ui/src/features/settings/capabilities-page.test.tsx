import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Settings } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { CapabilitiesPage } from './capabilities-page.tsx';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

let safeguards: Settings['safeguards'];

beforeEach(() => {
  safeguards = defaultSettings().safeguards;
  resetBackend({
    'settings.get': () => snapshot({ safeguards }),
    'settings.set': () => ({ ok: true }),
    'secrets.list': () => [],
  });
});

/** Settings are loaded before a page opens, as the Settings overlay does: switches start controlled. */
async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await client.prefetchQuery({ queryKey: keys.settings, queryFn: () => rpc().call('settings.get', {}) });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CapabilitiesPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('Capabilities › Instructions', () => {
  it("saves the administrator's instructions for every conversation once Save is pressed", async () => {
    await renderPage();
    const field = screen.getByRole('textbox', { name: 'Instructions for every conversation' });
    fireEvent.change(field, { target: { value: 'We are Acme Gardens. Give prices in pounds.' } });
    expect(callsTo('settings.set')).toEqual([]);
    expect(screen.getByText(/43 \/ 20,000 characters · Unsaved changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['prompts', 'organizationInstructions'], value: 'We are Acme Gardens. Give prices in pounds.' }]),
    );
  });
});

describe('Capabilities › Content safeguards', () => {
  it('says that they are instructions a person or a weak model can get around', async () => {
    await renderPage();
    expect(screen.getByText(/Safeguards are instructions to the model, not a filter\. A determined person, or a model that follows instructions poorly, can get around them/)).toBeTruthy();
  });

  it('is off by default, with the usual categories ready for when it is switched on', async () => {
    await renderPage();
    const checked = (name: string) => screen.getByRole('switch', { name }).getAttribute('aria-checked');
    expect(checked('Explicit sexual content')).toBe('true');
    const everyone = screen.getByRole('switch', { name: 'Extra safeguards for everyone' });
    expect(everyone.getAttribute('aria-checked')).toBe('false');
    expect(checked('Hate and violent extremism')).toBe('true');
    expect(checked('Harassment of private people')).toBe('false');
    // The crisis resource only matters to the self-harm category.
    expect(screen.queryByRole('textbox', { name: 'Crisis resource' })).toBeNull();

    fireEvent.click(everyone);
    fireEvent.click(screen.getByRole('switch', { name: 'Younger people' }));
    await waitFor(() =>
      expect(callsTo('settings.set')).toEqual([
        { layer: 'global', path: ['safeguards', 'enabled'], value: true },
        { layer: 'global', path: ['safeguards', 'profile'], value: 'younger' },
      ]),
    );
  });

  it('asks for a crisis resource once the self-harm category is on', async () => {
    safeguards = { ...safeguards, categories: { ...safeguards.categories, selfHarm: true } };
    await renderPage();
    expect(screen.getByRole('textbox', { name: 'Crisis resource' })).toBeTruthy();
  });
});

describe('Capabilities › Web', () => {
  it('shows the news feeds and the developer communities apart from the general engines', async () => {
    resetBackend({
      'settings.get': () => snapshot({ safeguards }),
      'secrets.list': () => [],
      'search.status': () => ({
        mode: 'auto',
        engines: [
          { id: 'duckduckgo', name: 'DuckDuckGo', kind: 'web', state: 'ok' },
          { id: 'bing-news', name: 'Bing News', kind: 'news', state: 'limited', retryAt: Date.now() + 120_000 },
          { id: 'google-news', name: 'Google News', kind: 'news', state: 'ok' },
          { id: 'stack-exchange', name: 'Stack Overflow', kind: 'dev', state: 'ok' },
          { id: 'hacker-news', name: 'Hacker News', kind: 'dev', state: 'unknown' },
          { id: 'github', name: 'GitHub', kind: 'dev', state: 'unknown' },
        ],
      }),
    });
    await renderPage();
    expect(await screen.findByText('Working. Answered by DuckDuckGo.')).toBeTruthy();
    expect(screen.getByText('News: Bing News limited for about 2 minutes, Google News working.')).toBeTruthy();
    expect(screen.getByText('Programming: Stack Overflow working, Hacker News not used yet, GitHub not used yet.')).toBeTruthy();
  });

  it('says where searches and the pages they open go', async () => {
    await renderPage();
    expect(screen.getByText(/news searches also go to Bing News and Google News, and programming searches to Stack Overflow, Hacker News and GitHub\. The server or this computer then opens the first result pages/)).toBeTruthy();
  });
});
