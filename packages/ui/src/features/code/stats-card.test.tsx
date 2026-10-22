import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatsSummary } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, model, resetBackend } from '../settings/test-backend.ts';
import { StatsCard, bookComparison } from './stats-card.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const EMPTY: StatsSummary = { sessions: 0, messages: 0, tokens: 0, activeDays: 0, peakHour: null, favoriteModel: null, days: [], models: [] };
const ALL: StatsSummary = {
  sessions: 12,
  messages: 340,
  tokens: 58_200_000_000,
  activeDays: 9,
  peakHour: 21,
  favoriteModel: 'cloud/opus',
  days: [
    { day: '2026-10-12', sessions: 3, messages: 41 },
    { day: '2026-10-14', sessions: 1, messages: 2 },
  ],
  models: [
    { ref: 'cloud/opus', tokens: 43_650_000_000, requests: 900 },
    { ref: 'local/qwen3', tokens: 14_550_000_000, requests: 300 },
  ],
};
const WEEK: StatsSummary = { ...ALL, sessions: 2, messages: 43, tokens: 1_500, activeDays: 2, peakHour: null, favoriteModel: null, models: [] };

function renderCard(stats: Record<'all' | 'week', StatsSummary>) {
  resetBackend({
    'stats.summary': ({ days }: { days: number | null }) => (days === 7 ? stats.week : stats.all),
    'models.list': () => [model('cloud', 'opus', { displayName: 'Opus 5.5' })],
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <StatsCard mode="code" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 14, 12));
});
afterEach(() => vi.useRealTimers());

describe('StatsCard', () => {
  it('stays away until the person has a session in the mode', async () => {
    renderCard({ all: EMPTY, week: EMPTY });
    await vi.waitFor(() => expect(callsTo('stats.summary')).toHaveLength(1));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('shows the totals, an accessible heatmap of 26 weeks and a sense of scale', async () => {
    renderCard({ all: ALL, week: WEEK });
    const card = await screen.findByRole('region', { name: 'Your Code stats' });
    await within(card).findByText('Opus 5.5');
    const tiles = within(card).getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling!.textContent]);
    expect(tiles).toEqual([
      ['Sessions', '12'],
      ['Messages', '340'],
      ['Total tokens', '58.2B'],
      ['Active days', '9'],
      ['Peak hour', expect.stringMatching(/^9\sPM$/)],
      ['Favorite model', 'Opus 5.5'],
    ]);
    const heatmap = within(card).getByRole('group', { name: 'Activity in the last 26 weeks' });
    const days = within(heatmap).getAllByRole('img');
    // 25 full weeks, then Sunday to today (a Wednesday).
    expect(days).toHaveLength(25 * 7 + 4);
    expect(days.at(-1)!.getAttribute('aria-label')).toBe('1 session, 2 messages on Oct 14');
    expect(days.at(-3)!.getAttribute('aria-label')).toBe('3 sessions, 41 messages on Oct 12');
    expect(days.at(-3)!.className).toContain('bg-interactive');
    expect(days.at(-2)!.getAttribute('aria-label')).toBe('No sessions on Oct 13');
    expect(days.at(-2)!.className).toContain('bg-fill-ghost-hover');
    expect(within(card).getByText('You’ve used ~1,098× more tokens than the Encyclopædia Britannica.')).toBeTruthy();
  });

  it('switches the period and lists tokens by model', async () => {
    renderCard({ all: ALL, week: WEEK });
    const card = await screen.findByRole('region', { name: 'Your Code stats' });
    fireEvent.click(within(card).getByRole('radio', { name: 'Models' }));
    await within(card).findByText('Opus 5.5');
    expect(within(card).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['Opus 5.543.7B75%', 'qwen314.6B25%']);

    fireEvent.click(within(card).getByRole('radio', { name: '7d' }));
    expect(await within(card).findByText('No tokens used in this period.')).toBeTruthy();
    expect(callsTo('stats.summary')).toContainEqual(expect.objectContaining({ mode: 'code', days: 7 }));
    fireEvent.click(within(card).getByRole('radio', { name: 'Overview' }));
    expect(within(card).getByText('You’ve used about 7% of The Little Prince in tokens.')).toBeTruthy();
  });
});

describe('bookComparison', () => {
  it('picks the longest book the tokens outgrow', () => {
    expect(bookComparison(0)).toBeNull();
    expect(bookComparison(230)).toBe('You’ve used about 1% of The Little Prince in tokens.');
    expect(bookComparison(150_000)).toBe('You’ve used about as many tokens as The Hobbit.');
    expect(bookComparison(400_000)).toBe('You’ve used ~3.1× more tokens than The Hobbit.');
    expect(bookComparison(20_000_000)).toBe('You’ve used ~14× more tokens than the whole Harry Potter series.');
  });
});
