import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, defaultUserPrefs, type SessionSummary } from '@atelier/protocol';
import { resetBackend, snapshot } from '../settings/test-backend.ts';
import { coverageText, ReportDialog } from './report-dialog.tsx';
import { useReports } from './report-store.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const chat: SessionSummary = {
  id: 's1',
  mode: 'code',
  workspaceId: null,
  permissionMode: null,
  title: 'Fix the build',
  projectId: null,
  model: null,
  effort: null,
  connectorsOff: [],
  research: false,
  status: 'idle',
  pinnedAt: null,
  createdAt: 0,
  updatedAt: Date.now(),
};

function setup(info: Record<string, unknown> = { reports: true }) {
  const submitted: unknown[] = [];
  const prepared: unknown[] = [];
  resetBackend({
    'app.info': () => ({ name: 'Atelier', version: '0.9.0', surface: 'web', platform: 'linux', dataDir: '', ...info }),
    'settings.get': () => snapshot(defaultSettings()),
    'prefs.get': () => defaultUserPrefs(),
    'sessions.list': () => [chat],
    'reports.prepare': (input: { diagnostics: boolean; chatSessionId: string | null }) => {
      prepared.push(input);
      return {
        diagnostics: input.diagnostics ? { collectedAt: 1, backend: { kind: 'server', os: { platform: 'linux' }, hardware: {}, runtime: {} } } : null,
        chat: input.chatSessionId ? { session: { mode: 'code', title: 'Fix the build', status: 'idle', createdAt: 0, updatedAt: 0 }, coverage: { total: 900, included: 120, omitted: [{ from: 3, to: 782 }], shortened: 4 }, messages: [] } : null,
      };
    },
    'reports.submit': (input: unknown) => {
      submitted.push(input);
      return { id: 'I-7F3K2Q', receivedAt: 1 };
    },
  });
  const rootRoute = createRootRoute({ component: ReportDialog });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { submitted, prepared };
}

beforeEach(() => {
  useReports.setState({ open: false, kind: 'issue', drafts: { issue: { title: '', description: '', contact: '' }, feature: { title: '', description: '', contact: '' } }, shots: [] });
});

describe('the report dialog', () => {
  it('asks for a real title and description before sending', async () => {
    const { submitted } = setup();
    act(() => useReports.getState().open_('issue'));
    fireEvent.change(await screen.findByPlaceholderText(/Chat stops after attaching/), { target: { value: 'Broken' } });
    fireEvent.change(screen.getByPlaceholderText(/What did you do/), { target: { value: 'Chat doesnt work. AAAAAAAAAAAAAAAA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Make the title a few words long.')).toBeTruthy();
    expect(screen.getByText('Leave out the repeated characters.')).toBeTruthy();
    expect(submitted).toHaveLength(0);
  });

  it('sends an issue with diagnostics and the chosen conversation, and shows its id', async () => {
    const { submitted } = setup();
    act(() => useReports.getState().open_('issue'));
    fireEvent.change(await screen.findByPlaceholderText(/Chat stops after attaching/), { target: { value: 'Code session stops early' } });
    fireEvent.change(screen.getByPlaceholderText(/What did you do/), { target: { value: 'It ends its turn with half the list still open.' } });
    // Diagnostics are on for an issue; a conversation is the person's choice.
    expect(screen.getByRole('switch', { name: 'Diagnostics' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('switch', { name: 'A conversation' }));
    expect(await screen.findByText(/120 of its 900 messages/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('report-id')).toHaveProperty('textContent', 'I-7F3K2Q');
    expect(submitted[0]).toMatchObject({ kind: 'issue', title: 'Code session stops early', diagnostics: { backend: { kind: 'server' } }, chat: { coverage: { total: 900 } }, app: { version: expect.any(String), surface: 'web', mode: 'web' } });
    // The draft is gone once it is sent.
    expect(useReports.getState().drafts.issue.title).toBe('');
  });

  it('leaves diagnostics off for a feature request unless the person turns them on', async () => {
    const { submitted, prepared } = setup();
    act(() => useReports.getState().open_('feature'));
    fireEvent.change(await screen.findByPlaceholderText(/Search inside attached PDFs/), { target: { value: 'Search inside PDFs' } });
    fireEvent.change(screen.getByPlaceholderText(/What would it let you do/), { target: { value: 'I want to find a sentence in a PDF I attached last week.' } });
    expect(screen.getByRole('switch', { name: 'Diagnostics' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByTestId('report-id');
    expect(submitted[0]).toMatchObject({ kind: 'feature', diagnostics: null, chat: null });
    expect(prepared).toHaveLength(0);
  });

  it('says so when an admin turned reports off, or the server is too old', async () => {
    setup({ reports: false });
    act(() => useReports.getState().open_('issue'));
    expect(await screen.findByText('An admin turned off reports on this server.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true));
  });

  it('describes how much of a conversation goes', () => {
    expect(coverageText({ coverage: { total: 12, included: 12, omitted: [], shortened: 0 } })).toBe('All 12 messages.');
    expect(coverageText({ coverage: { total: 900, included: 120, omitted: [], shortened: 3 } })).toBe('120 of its 900 messages: how it started and the newest ones, some shortened to fit.');
  });
});
