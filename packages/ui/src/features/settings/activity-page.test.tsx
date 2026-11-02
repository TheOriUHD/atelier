import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditFilter } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { keys, queryClient } from '../../lib/queries.ts';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';
import { ActivityPage, dayBounds, toneOf } from './activity-page.tsx';
import { settingEntry } from './search-index.ts';
import { settingsPage, visiblePages } from './pages.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const downloads = vi.hoisted(() => ({ saved: [] as { name: string; text: string }[] }));
vi.mock('../artifacts/artifact-files.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadText: (name: string, text: string) => void downloads.saved.push({ name, text }),
}));

const event = (n: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: `e${n}`,
  at: Date.UTC(2026, 10, 2, 12, 0, 0) - n * 60_000,
  kind: 'settings.changed',
  actorId: 'u1',
  actor: 'ada',
  target: 'server.signup',
  summary: `Changed server.signup ${n}`,
  detail: { from: 'invite', to: 'open' },
  ip: '203.0.113.9',
  ...over,
});

let all: AuditEvent[];
let calls: Record<string, unknown>[];

/** The backend's answer: newest first, a page at a time, honouring the filters like the real one. */
function list(input: AuditFilter & { cursor?: string; limit?: number }) {
  calls.push(input as never);
  const matching = all.filter((e) => (!input.kind || e.kind === input.kind || e.kind.startsWith(`${input.kind}.`)) && (!input.user || e.actor === input.user));
  const start = input.cursor ? Number(input.cursor) : 0;
  const limit = input.limit ?? 50;
  const events = matching.slice(start, start + limit);
  return { events, next: start + limit < matching.length ? String(start + limit) : null, retentionDays: 90 };
}

beforeEach(() => {
  all = Array.from({ length: 5 }, (_, i) => event(i));
  calls = [];
  downloads.saved.length = 0;
  resetBackend({
    'settings.get': () => snapshot(),
    'audit.list': list as never,
    'audit.export': (input: AuditFilter) => ({ exportedAt: 1, retentionDays: 90, truncated: false, events: all.filter((e) => !input.kind || e.kind.startsWith(input.kind)) }),
    'settings.set': () => ({ ok: true }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ActivityPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('Activity page', () => {
  it('lists events with when, who, what and from where, and expands one to show everything it carries', async () => {
    all = [event(0, { kind: 'signin.failed', actor: 'mallory', target: 'mallory', summary: 'Failed sign-in as mallory', detail: { reason: 'unknown username' }, ip: '192.0.2.99' })];
    renderPage();
    const table = await screen.findByRole('table', { name: 'Activity' });
    const row = within(table).getByText('Failed sign-in as mallory').closest('tr')!;
    expect(within(row).getByText('mallory')).toBeTruthy();
    expect(within(row).getByText('192.0.2.99')).toBeTruthy();
    expect(within(row).getByText('Sign-ins')).toBeTruthy();
    const toggle = within(row).getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('unknown username')).toBeTruthy();
    expect(screen.getByText('signin.failed')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText('unknown username')).toBeNull();
  });

  it('says what is missing: nothing yet, nothing for these filters, or why it failed', async () => {
    all = [];
    renderPage();
    expect(await screen.findByText('Nothing has been recorded yet.')).toBeTruthy();
  });

  it('shows the backend’s message when the log cannot be read', async () => {
    resetBackend({
      'settings.get': () => snapshot(),
      'audit.list': () => {
        throw new Error('Only admins can do this.');
      },
    });
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toContain('Only admins can do this.');
  });

  it('asks the backend to filter by type, by person once typing stops, and by dates, and can clear them', async () => {
    all = [event(0, { kind: 'account.created', actor: 'ada' }), event(1, { kind: 'settings.changed', actor: 'bob' })];
    renderPage();
    await screen.findByRole('table', { name: 'Activity' });

    fireEvent.change(screen.getByLabelText('Person'), { target: { value: ' bob ' } });
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ user: 'bob' }));
    expect(await screen.findByText('Changed server.signup 1')).toBeTruthy();
    expect(screen.queryByText('Changed server.signup 0')).toBeNull();

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-11-02' } });
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ user: 'bob', from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 10, 2, 23, 59, 59, 999).getTime() }));

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(calls.at(-1)).not.toHaveProperty('user'));
    expect(calls.at(-1)).not.toHaveProperty('from');
    expect((screen.getByLabelText('Person') as HTMLInputElement).value).toBe('');
  });

  it('does not ask for every key stroke in the person field', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Activity' });
    const before = calls.length;
    for (const v of ['b', 'bo', 'bob']) fireEvent.change(screen.getByLabelText('Person'), { target: { value: v } });
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ user: 'bob' }));
    expect(calls.length - before).toBe(1);
  });

  it('loads more with the button, and without repeating events', async () => {
    all = Array.from({ length: 120 }, (_, i) => event(i));
    renderPage();
    await screen.findByText('Changed server.signup 0');
    expect(screen.queryByText('Changed server.signup 50')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Changed server.signup 50')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Changed server.signup 119')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(120);
  });

  it('loads the next page by itself when the end of the list scrolls into view', async () => {
    let trigger: (() => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          trigger = () => cb([{ isIntersecting: true }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    all = Array.from({ length: 70 }, (_, i) => event(i));
    renderPage();
    await screen.findByText('Changed server.signup 0');
    trigger!();
    expect(await screen.findByText('Changed server.signup 69')).toBeTruthy();
  });

  it('shows cards instead of a table on a phone', async () => {
    const mq = (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('matchMedia', mq);
    renderPage();
    const cards = await screen.findByRole('list', { name: 'Activity' });
    expect(within(cards).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(within(cards).getAllByRole('button')[0]!);
    expect(await screen.findByText('server.signup')).toBeTruthy();
  });

  it('exports what the filters match as a JSON file', async () => {
    all = [event(0, { kind: 'account.created' }), event(1)];
    renderPage();
    await screen.findByRole('table', { name: 'Activity' });
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(downloads.saved).toHaveLength(1));
    expect(callsTo('audit.export')).toEqual([{}]);
    expect(downloads.saved[0]!.name).toMatch(/^atelier-activity-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(downloads.saved[0]!.text)).toMatchObject({ retentionDays: 90, events: [{ id: 'e0' }, { id: 'e1' }] });
  });

  it('exports with the filters that are set', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Activity' });
    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'ada' } });
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ user: 'ada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(callsTo('audit.export')).toEqual([{ user: 'ada' }]));
  });

  it('changes how long events are kept, and shows a stored value that is not a preset', async () => {
    renderPage();
    const retention = await screen.findByLabelText('Keep activity for');
    await waitFor(() => expect(retention.textContent).toContain('90 days'));
    fireEvent.click(retention);
    // Base UI only accepts mouse clicks that started on the option.
    const option = await screen.findByRole('option', { name: '30 days' });
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);
    await waitFor(() => expect(callsTo('settings.set')).toContainEqual({ layer: 'global', path: ['audit', 'retentionDays'], value: 30 }));
  });

  it('shows a retention that is not one of the presets as itself', async () => {
    resetBackend({ 'settings.get': () => snapshot({ audit: { retentionDays: 45 } }), 'audit.list': list as never });
    renderPage();
    const retention = await screen.findByLabelText('Keep activity for');
    await waitFor(() => expect(retention.textContent).toContain('45 days'));
  });
});

describe('Activity page helpers', () => {
  it('turns a day into the start or end of that day in the viewer’s time zone, and ignores anything else', () => {
    expect(dayBounds('2026-11-02', false)).toBe(new Date(2026, 10, 2).getTime());
    expect(dayBounds('2026-11-02', true)).toBe(new Date(2026, 10, 2, 23, 59, 59, 999).getTime());
    expect(dayBounds('', false)).toBeUndefined();
    expect(dayBounds('yesterday', true)).toBeUndefined();
    expect(dayBounds('2026-13-45', true)).toBeUndefined();
  });

  it('makes failed and blocked sign-ins stand out', () => {
    expect(toneOf('signin.failed')).toBe('warning');
    expect(toneOf('signin.blocked')).toBe('danger');
    expect(toneOf('signin.success')).toBe('neutral');
  });
});

describe('the Activity page in Settings', () => {
  const shown = (admin: boolean) => visiblePages(admin).map((p) => p.id);

  it('is an admin page, offered only where the backend keeps the log (not on a desktop app’s own backend, not on an older server)', () => {
    expect(shown(true)).not.toContain('activity');
    queryClient.setQueryData(keys.appInfo, { auditLog: false });
    expect(shown(true)).not.toContain('activity');
    queryClient.setQueryData(keys.appInfo, { auditLog: true });
    expect(shown(true)).toContain('activity');
    expect(shown(false)).not.toContain('activity');
    expect(settingsPage('activity', true).label).toBe('Activity');
    queryClient.setQueryData(keys.appInfo, {});
    expect(settingsPage('activity', true).id).toBe('general');
  });

  it('can be found in Settings search', () => {
    expect(settingEntry('activity.log').keywords).toContain('audit');
  });
});
