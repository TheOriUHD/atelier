import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type ProviderConfig, type Settings, type SettingsPath, type UsageRow } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { setPath } from '../../lib/json-path.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { callsTo, model, resetBackend, snapshot, user } from './test-backend.ts';
import { byModel, formatTokens, formatUsd, modeShares, tokensByDay, totals } from './usage-data.ts';
import { UsagePage } from './usage-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

// Recharts needs a laid-out page; the chart's input is what matters here.
vi.mock('./usage-chart.tsx', () => ({
  default: ({ data, modes }: { data: { day: string }[]; modes: string[] }) => (
    <p>
      Chart of {data.length} days from {data[0]!.day}: {modes.join(', ')}
    </p>
  ),
}));

/** `YYYY-MM-DD` of the local day `ago` days back. */
function day(ago: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const usage = (extra: Partial<UsageRow>): UsageRow => ({
  day: day(0),
  providerId: 'fake',
  modelId: 'qwen3',
  mode: 'chat',
  requests: 1,
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: null,
  unpriced: 1,
  tokensPerSecond: null,
  timed: 0,
  ...extra,
});

const ROWS = [
  usage({ providerId: 'anthropic', modelId: 'claude-sonnet', requests: 3, input: 1000, output: 500, cacheRead: 8000, cacheWrite: 500, costUsd: 0.042, unpriced: 0, tokensPerSecond: 60, timed: 3 }),
  usage({ day: day(1), mode: 'code', requests: 2, input: 400, output: 100, unpriced: 2, tokensPerSecond: 30, timed: 2 }),
  usage({ day: day(1), providerId: 'anthropic', modelId: 'claude-sonnet', mode: 'code', input: 100, output: 100, costUsd: 0.001, unpriced: 0, tokensPerSecond: 90, timed: 1 }),
];

const provider = (id: string, name: string): ProviderConfig => ({ id, type: 'ollama', name, baseUrl: 'http://127.0.0.1:11434', headers: {}, enabled: true });

/** The backend's settings, whose price table each write replaces. */
function settingsBackend(pricing: Settings['pricing'] = {}) {
  let settings = snapshot({ providers: [provider('anthropic', 'Anthropic'), provider('fake', 'Homelab')], pricing });
  return {
    'settings.get': () => settings,
    'settings.set': ({ path, value }: { path: SettingsPath; value: unknown }) => {
      settings = { ...settings, effective: setPath(settings.effective, path, value) };
      return { ok: true };
    },
    'models.list': () => [model('anthropic', 'claude-sonnet', { displayName: 'Claude Sonnet' }), model('fake', 'qwen3'), model('fake', 'llama4')],
  };
}

beforeEach(() => resetBackend({ ...settingsBackend(), 'usage.summary': () => ROWS }));

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await client.prefetchQuery({ queryKey: keys.settings, queryFn: () => rpc().call('settings.get', {}) });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <UsagePage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

const cells = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));

const timezoneOffset = new Date().getTimezoneOffset();

describe('Usage page', () => {
  it('sums the period, charts the days by mode and lists the models with cost and speed', async () => {
    await renderPage();
    expect(await screen.findByText('6 requests, 10.7K tokens, and $0.04 in the last 30 days.')).toBeTruthy();
    expect(screen.getByText('1.5K input · 8K cache read · 500 cache write · 700 output')).toBeTruthy();
    expect(screen.getByText('2 requests without a price. Add prices below to count their cost.')).toBeTruthy();
    expect(callsTo('usage.summary')).toEqual([{ days: 30, timezoneOffset }]);

    expect(await screen.findByText(`Chart of 30 days from ${day(29)}: chat, code`)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Share of tokens by mode' }).textContent).toBe('Chat93%Code7%');
    await waitFor(() =>
      expect(cells(screen.getByRole('table', { name: 'By model' }))).toEqual([
        ['Claude SonnetAnthropic', '4', '10.2K', '$0.04', '68 tokens/s'],
        ['qwen3Homelab', '2', '500', '—', '30 tokens/s'],
      ]),
    );
  });

  it('asks again for another period', async () => {
    await renderPage();
    await screen.findByText(/in the last 30 days/);
    fireEvent.click(screen.getByRole('combobox', { name: 'Period' }));
    pick(await screen.findByRole('option', { name: 'Last 7 days' }));

    expect(await screen.findByText('6 requests, 10.7K tokens, and $0.04 in the last 7 days.')).toBeTruthy();
    expect(callsTo('usage.summary')).toEqual([
      { days: 30, timezoneOffset },
      { days: 7, timezoneOffset },
    ]);
  });

  it('says so when nothing was used, without a chart or table', async () => {
    resetBackend({ ...settingsBackend(), 'usage.summary': () => [] });
    await renderPage();
    expect(await screen.findByText('No usage in the last 30 days.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'By model' })).toBeNull();
    expect(screen.queryByText(/^Chart of/)).toBeNull();
  });

  it('shows everyone’s usage to admins on request', async () => {
    await renderPage();
    await screen.findByText(/in the last 30 days/);
    fireEvent.click(screen.getByRole('radio', { name: 'Everyone' }));

    expect(await screen.findByRole('heading', { name: 'Everyone’s usage' })).toBeTruthy();
    expect(callsTo('usage.summary').at(-1)).toEqual({ days: 30, timezoneOffset, everyone: true });
  });

  it('shows everyone else only their own usage, without prices', async () => {
    resetBackend({ ...settingsBackend(), 'account.get': () => user({ role: 'user' }), 'usage.summary': () => ROWS });
    await renderPage();
    expect(await screen.findByText('2 requests without a price.')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Whose usage' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Prices' })).toBeNull();
    expect(callsTo('usage.summary')).toEqual([{ days: 30, timezoneOffset }]);
  });

  it('shows why usage couldn’t be loaded', async () => {
    resetBackend({
      ...settingsBackend(),
      'usage.summary': () => {
        throw appError('forbidden', 'Only admins can see everyone’s usage.');
      },
    });
    await renderPage();
    expect((await screen.findByRole('alert')).textContent).toBe('Only admins can see everyone’s usage.');
  });
});

describe('Usage page prices (admins)', () => {
  it('adds a price for a model, checking the amounts', async () => {
    await renderPage();
    expect(await screen.findByText('No prices yet. Requests count their tokens, without a cost.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add price' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add price' }));

    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('Choose a model.')).toBeTruthy();
    expect(dialog.getAllByText('Enter dollars per million tokens, like 3 or 0.25.')).toHaveLength(2);

    fireEvent.click(dialog.getByRole('combobox', { name: 'Model' }));
    pick(await screen.findByRole('option', { name: 'qwen3 · Homelab' }));
    fireEvent.change(dialog.getByRole('textbox', { name: 'Input' }), { target: { value: '0.5' } });
    fireEvent.change(dialog.getByRole('textbox', { name: 'Output' }), { target: { value: '1.5' } });
    fireEvent.change(dialog.getByRole('textbox', { name: 'Cache read' }), { target: { value: 'free' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('Enter dollars per million tokens, like 3 or 0.25.')).toBeTruthy();
    expect(callsTo('settings.set')).toEqual([]);

    fireEvent.change(dialog.getByRole('textbox', { name: 'Cache read' }), { target: { value: '.05' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add price' })).toBeNull());
    expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['pricing'], value: { 'fake/qwen3': { input: 0.5, output: 1.5, cacheRead: 0.05 } } }]);
    expect(cells(screen.getByRole('table', { name: 'Prices' }))).toEqual([['qwen3Homelab', '$0.50', '$1.50', '$0.05', 'as input', '']]);
  });

  it('edits and removes prices, writing the whole table', async () => {
    const prices = { 'anthropic/claude-sonnet': { input: 3, output: 15 }, 'fake/qwen3': { input: 0, output: 0 } };
    resetBackend({ ...settingsBackend(prices), 'usage.summary': () => ROWS });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the price of Claude Sonnet' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit price' }));
    expect(dialog.getByRole('combobox', { name: 'Model' }).textContent).toContain('Claude Sonnet · Anthropic');
    expect((dialog.getByRole('textbox', { name: 'Output' }) as HTMLInputElement).value).toBe('15');
    fireEvent.change(dialog.getByRole('textbox', { name: 'Cache read' }), { target: { value: '0.3' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit price' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Remove the price of qwen3' }));
    await waitFor(() => expect(cells(screen.getByRole('table', { name: 'Prices' }))).toHaveLength(1));
    expect(callsTo('settings.set')).toEqual([
      { layer: 'global', path: ['pricing'], value: { 'anthropic/claude-sonnet': { input: 3, output: 15, cacheRead: 0.3 }, 'fake/qwen3': { input: 0, output: 0 } } },
      { layer: 'global', path: ['pricing'], value: { 'anthropic/claude-sonnet': { input: 3, output: 15, cacheRead: 0.3 } } },
    ]);
  });
});

describe('usage data', () => {
  it('counts every token a request processed and the cost of the priced ones', () => {
    expect(totals(ROWS)).toEqual({ requests: 6, input: 1500, output: 700, cacheRead: 8000, cacheWrite: 500, tokens: 10_700, cost: expect.closeTo(0.043), unpriced: 2 });
  });

  it('lists every day of the period in local time, oldest first, quiet days at zero', () => {
    const now = new Date(2026, 9, 14, 0, 30);
    const rows = [usage({ day: '2026-10-14', mode: 'work' }), usage({ day: '2026-10-12', mode: 'research' }), usage({ day: '2026-09-01' })];
    expect(tokensByDay(rows, 3, now)).toEqual([
      { day: '2026-10-12', chat: 0, work: 0, code: 0, other: 150 },
      { day: '2026-10-13', chat: 0, work: 0, code: 0, other: 0 },
      { day: '2026-10-14', chat: 0, work: 150, code: 0, other: 0 },
    ]);
  });

  it('shares tokens by mode, largest first', () => {
    expect(modeShares([usage({ mode: 'code', input: 300 }), usage({ input: 100 })])).toEqual([
      { mode: 'code', share: expect.closeTo(0.7) },
      { mode: 'chat', share: expect.closeTo(0.3) },
    ]);
  });

  it('averages a model’s speed over its timed requests and leaves cost empty when nothing had a price', () => {
    // Of the second row's three requests only one reported a speed, so it counts once.
    const [qwen] = byModel([usage({ requests: 1, tokensPerSecond: 10, timed: 1 }), usage({ requests: 3, tokensPerSecond: 50, timed: 1 }), usage({ requests: 2 })]);
    expect(qwen).toEqual({ ref: 'fake/qwen3', providerId: 'fake', modelId: 'qwen3', requests: 6, tokens: 450, cost: null, unpriced: 3, tokensPerSecond: 30 });
  });

  it('formats tokens compactly and dollars to the cent', () => {
    expect([formatTokens(980), formatTokens(12_400), formatTokens(3_100_000)]).toEqual(['980', '12.4K', '3.1M']);
    expect([formatUsd(0), formatUsd(0.004), formatUsd(1280)]).toEqual(['$0.00', '<$0.01', '$1,280.00']);
  });
});
