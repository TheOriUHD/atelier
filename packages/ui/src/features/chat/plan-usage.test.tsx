import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderType } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { backend, callsTo, resetBackend, user } from '../settings/test-backend.ts';
import { PlanLimitWarning, PlanUsageButton } from './plan-usage.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
const openSettings = vi.hoisted(() => vi.fn());
vi.mock('../../app/navigation.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), useOpenSettings: () => openSettings }));

const NOW = new Date(2026, 9, 24, 12).getTime();

function status(fiveHour: number, weekly = 10) {
  return {
    available: true,
    signedIn: true,
    signingIn: false,
    plan: 'plus',
    limits: {
      primary: { usedPercent: fiveHour, windowMinutes: 300, resetsAt: NOW + 70 * 60_000 },
      secondary: { usedPercent: weekly, windowMinutes: 10_080, resetsAt: NOW + 3 * 86_400_000 },
    },
  };
}

function show(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetBackend({ 'chatgpt.status': () => status(42) });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('plan usage in Chat and Cowork', () => {
  it('opens the plan’s limits from a gauge in the message box, colored as the fullest window fills up', async () => {
    show(<PlanUsageButton provider="chatgpt" />);
    const gauge = await screen.findByRole('button', { name: 'Plan usage limits: 5-hour limit 42% used' });
    fireEvent.click(gauge);
    const limits = await screen.findByRole('region', { name: 'Plan usage limits · Plus' });
    expect(limits.textContent).toContain('Resets in 1 hr 10 min');
    expect(within(limits).getByRole('progressbar', { name: 'Weekly limit' }).getAttribute('aria-valuenow')).toBe('10');
    fireEvent.click(within(limits).getByRole('button', { name: 'Open Usage in Settings' }));
    expect(openSettings).toHaveBeenCalledWith('usage');
    cleanup();

    backend.handlers['chatgpt.status'] = () => status(95);
    show(<PlanUsageButton provider="chatgpt" />);
    expect((await screen.findByRole('button', { name: 'Plan usage limits: 5-hour limit 95% used' })).className).toContain('text-danger-text');
  });

  it.each<[string, ProviderType | null, 'admin' | 'user']>([
    ['another provider', 'ollama', 'admin'],
    ['a person who isn’t an admin, and can’t read the plan', 'chatgpt', 'user'],
  ])('shows nothing for %s', async (_, provider, role) => {
    backend.handlers['account.get'] = () => user({ role });
    show(
      <>
        <PlanUsageButton provider={provider} />
        <PlanLimitWarning provider={provider} busy={false} />
      </>,
    );
    await waitFor(() => expect(callsTo('account.get').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Plan usage limits/ })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(callsTo('chatgpt.status')).toEqual([]);
  });
});

describe('the warning near a limit', () => {
  it('says how much of a limit is used from 90% on, and stays away once dismissed until that window resets', async () => {
    backend.handlers['chatgpt.status'] = () => status(92);
    show(<PlanLimitWarning provider="chatgpt" busy={false} />);
    expect((await screen.findByRole('status')).textContent).toBe('You’ve used 92% of your ChatGPT 5-hour limit. Resets in 1 hr 10 min.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    // The same window: still dismissed.
    show(<PlanLimitWarning provider="chatgpt" busy={false} />);
    await waitFor(() => expect(callsTo('chatgpt.status').length).toBe(2));
    await vi.advanceTimersByTimeAsync(50);
    expect(callsTo('chatgpt.status').length).toBe(2);
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    // A full one in the next window comes back, in red.
    backend.handlers['chatgpt.status'] = () => ({ ...status(100), limits: { ...status(100).limits, primary: { usedPercent: 100, windowMinutes: 300, resetsAt: NOW + 5 * 3_600_000 } } });
    show(<PlanLimitWarning provider="chatgpt" busy={false} />);
    const line = await screen.findByRole('status');
    expect(line.textContent).toBe('You’ve reached your ChatGPT 5-hour limit. Resets in 5 hr.');
    expect(line.className).toContain('text-danger-text');
  });

  it('says nothing below 90%, and reads the limits again when a reply ends', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (busy: boolean) => (
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <PlanLimitWarning provider="chatgpt" busy={busy} />
        </TooltipProvider>
      </QueryClientProvider>
    );
    const view = render(page(true));
    await waitFor(() => expect(callsTo('chatgpt.status').length).toBe(1));
    expect(screen.queryByRole('status')).toBeNull();

    backend.handlers['chatgpt.status'] = () => status(91);
    view.rerender(page(false));
    expect((await screen.findByRole('status')).textContent).toContain('91%');
    expect(callsTo('chatgpt.status').length).toBe(2);
  });
});
