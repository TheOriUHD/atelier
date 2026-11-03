import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageError } from './parts.tsx';

const open = vi.fn();
vi.mock('../../app/navigation.ts', () => ({ useOpenSettings: () => open }));

afterEach(() => {
  cleanup();
  open.mockClear();
});

describe('a failed reply', () => {
  it('offers the Usage page for a turn a usage limit stopped, and no Retry', () => {
    render(<MessageError error={{ code: 'limit_reached', message: 'You’ve reached your limit of 600 tokens (tokens per day).', retryable: false }} />);
    expect(screen.getByRole('alert').textContent).toContain('You’ve reached your limit of 600 tokens');
    fireEvent.click(screen.getByRole('button', { name: 'See your usage' }));
    expect(open).toHaveBeenCalledWith('usage');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('has no usage link for other errors', () => {
    render(<MessageError error={{ code: 'provider_error', message: 'The model request failed' }} onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: 'See your usage' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
