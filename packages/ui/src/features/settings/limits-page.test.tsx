import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type LimitsStatus, type PersonLimits, type Settings, type SettingsPath, type UserLimits } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { setPath } from '../../lib/json-path.ts';
import { LimitsPage, parseLimit } from './limits-page.tsx';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const row = (key: LimitsStatus['rows'][number]['key'], used: number, max: number, extra: Partial<LimitsStatus['rows'][number]> = {}) => ({
  key,
  used,
  max,
  resetsAt: null,
  reached: used >= max,
  near: used >= max * 0.8,
  ...extra,
});
const person = (id: string, name: string, rows: LimitsStatus['rows'], extra: Partial<PersonLimits> = {}): PersonLimits => ({
  id,
  username: name.toLowerCase(),
  name,
  disabled: false,
  status: { exempt: false, rows, unpriced: 0 },
  own: {},
  ...extra,
});

function renderPage(people: PersonLimits[], effective: Partial<Settings> = {}) {
  let settings = snapshot(effective);
  resetBackend({
    'app.info': () => ({ usageLimits: true }),
    'settings.get': () => settings,
    'settings.set': ({ path, value }: { path: SettingsPath; value: unknown }) => {
      settings = { ...settings, effective: setPath(settings.effective, path, value) };
      return { ok: true };
    },
    'settings.reset': () => ({ ok: true }),
    'limits.everyone': () => people,
    'users.update': ({ id }: { id: string }) => ({ id }),
    'users.list': () => [],
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <LimitsPage />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

describe('reading an amount', () => {
  it('takes whole numbers with commas and k or M, and dollars with cents', () => {
    expect(parseLimit('tokensPerDay', '500000')).toBe(500_000);
    expect(parseLimit('tokensPerDay', '1,500,000')).toBe(1_500_000);
    expect(parseLimit('tokensPer30Days', '500k')).toBe(500_000);
    expect(parseLimit('tokensPer30Days', '2M')).toBe(2_000_000);
    expect(parseLimit('requestsPerHour', '30')).toBe(30);
    expect(parseLimit('costUsdPerDay', '$2.50')).toBe(2.5);
    expect(parseLimit('costUsdPerDay', '5')).toBe(5);
    for (const bad of ['', '0', '-3', 'lots', '1.5.2']) expect(parseLimit('tokensPerDay', bad), bad).toBeNull();
    expect(parseLimit('costUsdPerDay', '0')).toBeNull();
    expect(parseLimit('requestsPerHour', '0')).toBeNull();
  });
});

describe('Limits page', () => {
  it('saves a limit as it is typed, and an emptied one goes', async () => {
    renderPage([], { limits: { tokensPerDay: 100_000 } });
    const perDay = await screen.findByRole('textbox', { name: 'Tokens per person per day' });
    await waitFor(() => expect((perDay as HTMLInputElement).value).toBe('100000'));
    fireEvent.focus(perDay);
    fireEvent.change(perDay, { target: { value: '' } });
    fireEvent.blur(perDay);
    await waitFor(() => expect(callsTo('settings.reset')).toEqual([{ layer: 'global', path: ['limits', 'tokensPerDay'] }]));

    const month = screen.getByRole('textbox', { name: 'Tokens per person per 30 days' });
    fireEvent.focus(month);
    fireEvent.change(month, { target: { value: '2M' } });
    fireEvent.blur(month);
    await waitFor(() => expect(callsTo('settings.set')).toContainEqual({ layer: 'global', path: ['limits', 'tokensPer30Days'], value: 2_000_000 }));

    const cost = screen.getByRole('textbox', { name: 'Cost per person per day' });
    fireEvent.focus(cost);
    fireEvent.change(cost, { target: { value: '2.50' } });
    fireEvent.blur(cost);
    await waitFor(() => expect(callsTo('settings.set')).toContainEqual({ layer: 'global', path: ['limits', 'costUsdPerDay'], value: 2.5 }));
  });

  it('asks again who is near a limit when a limit for everyone changes', async () => {
    renderPage([person('a', 'Ada', [row('tokensPerDay', 100, 1000)])]);
    await screen.findByRole('textbox', { name: 'Tokens per person per day' });
    await waitFor(() => expect(callsTo('limits.everyone')).toHaveLength(1));
    const perDay = screen.getByRole('textbox', { name: 'Tokens per person per day' });
    fireEvent.focus(perDay);
    fireEvent.change(perDay, { target: { value: '500' } });
    fireEvent.blur(perDay);
    await waitFor(() => expect(callsTo('limits.everyone').length).toBeGreaterThan(1));
  });

  it('refuses what is not an amount and says what to enter', async () => {
    renderPage([]);
    const hourly = await screen.findByRole('textbox', { name: 'Requests per person per hour' });
    fireEvent.focus(hourly);
    fireEvent.change(hourly, { target: { value: 'many' } });
    fireEvent.blur(hourly);
    expect(await screen.findByText('Enter a whole number, or leave it empty for no limit.')).toBeTruthy();
    expect(callsTo('settings.set')).toEqual([]);
  });

  it('lists people with the one nearest its limit, and marks who is near or at one, those first', async () => {
    renderPage([
      person('a', 'Ada', [row('tokensPerDay', 100, 1000)]),
      person('b', 'Bob', [row('tokensPerDay', 850, 1000), row('requestsPerHour', 1, 30)]),
      person('c', 'Cy', [row('costUsdPerDay', 5, 5)]),
      person('d', 'Di', [], { status: { exempt: true, rows: [], unpriced: 0 } }),
      person('e', 'Ed', [], { disabled: true }),
    ]);
    const table = await screen.findByRole('table', { name: 'People' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['Cycy', 'Bobbob', 'Adaada', 'DiExemptdi']);
    expect(rows[0]!.textContent).toContain('At limit');
    expect(rows[0]!.textContent).toContain('Cost/day · $5.00 of $5.00');
    expect(rows[1]!.textContent).toContain('Near limit');
    expect(rows[1]!.textContent).toContain('Tokens/day · 850 of 1K tokens');
    expect(rows[2]!.textContent).not.toMatch(/limit\b.*limit/i);
    expect(within(rows[3]!).getByText('No limits')).toBeTruthy();
    expect(within(table).getByRole('progressbar', { name: 'Bob: Tokens per day' }).getAttribute('aria-valuenow')).toBe('85');
  });

  it('raises one limit for a person, lifts another and leaves the rest to everyone', async () => {
    renderPage([person('b', 'Bob', [row('tokensPerDay', 850, 1000)])], { limits: { tokensPerDay: 1000, requestsPerHour: 30 } });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the limits of Bob' }));
    const dialog = await screen.findByRole('dialog', { name: 'Limits for Bob' });
    expect(within(dialog).getAllByText('1K tokens').length + within(dialog).getAllByText('30 requests').length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Tokens per day for Bob' }));
    pick(await screen.findByRole('option', { name: 'Own limit' }));
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Tokens per day amount' }), { target: { value: '5k' } });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Requests per hour for Bob' }));
    pick(await screen.findByRole('option', { name: 'No limit' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('users.update')).toEqual([{ id: 'b', limits: { tokensPerDay: 5000, requestsPerHour: null } }]));
  });

  it('exempts a person from every limit, keeping what was set for them', async () => {
    const own: UserLimits = { costUsdPerDay: 3 };
    renderPage([person('b', 'Bob', [], { own })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the limits of Bob' }));
    const dialog = await screen.findByRole('dialog', { name: 'Limits for Bob' });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'No limits for this person' }));
    await waitFor(() => expect(within(dialog).queryAllByRole('combobox')).toEqual([]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('users.update')).toEqual([{ id: 'b', limits: { exempt: true, costUsdPerDay: 3 } }]));
  });

  it('does not save an own limit that is not a number', async () => {
    renderPage([person('b', 'Bob', [])]);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the limits of Bob' }));
    const dialog = await screen.findByRole('dialog', { name: 'Limits for Bob' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Cost per day for Bob' }));
    pick(await screen.findByRole('option', { name: 'Own limit' }));
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Cost per day amount' }), { target: { value: 'lots' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/Enter a positive number/)).toBeTruthy();
    expect(callsTo('users.update')).toEqual([]);
  });
});
