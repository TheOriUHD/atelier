import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LimitWarning } from '@atelier/protocol';
import { UsageLimitWarning } from './usage-limit-warning.tsx';

const open = vi.fn();
vi.mock('../../app/navigation.ts', () => ({ useOpenSettings: () => open }));

const warning: LimitWarning = { key: 'tokensPerDay', used: 820, max: 1000, resetsAt: null, message: 'You’ve used 82% of your limit of 1,000 tokens (tokens per day). It resets at 00:00 UTC (in about 6 hours).' };

afterEach(() => {
  cleanup();
  open.mockClear();
});

describe('the usage-limit warning', () => {
  it('says what the backend said, above the message box, and opens the Usage page', () => {
    render(<UsageLimitWarning warning={warning} />);
    expect(screen.getByRole('status').textContent).toContain(warning.message);
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
    expect(open).toHaveBeenCalledWith('usage');
  });

  it('is gone when dismissed, and back for a different warning', () => {
    const { rerender } = render(<UsageLimitWarning warning={warning} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<UsageLimitWarning warning={{ ...warning, key: 'requestsPerHour', message: 'You’ve used 80% of your limit of 30 requests (requests per hour).' }} />);
    expect(screen.getByRole('status').textContent).toContain('requests per hour');
  });

  it('shows nothing without a warning', () => {
    render(<UsageLimitWarning warning={null} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
