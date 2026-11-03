import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLastError, recordError } from '../lib/last-error.ts';
import { AppError } from './app-error.tsx';
import { CopyDiagnosticsButton } from './copy-diagnostics-button.tsx';

const copy = vi.hoisted(() => ({ result: 'text' as string | null, calls: 0 }));
vi.mock('../lib/copy-diagnostics.ts', () => ({
  copyDiagnostics: async () => {
    copy.calls++;
    return copy.result;
  },
}));

afterEach(() => {
  copy.result = 'text';
  copy.calls = 0;
  clearLastError();
  vi.useRealTimers();
});

describe('the Copy diagnostics button', () => {
  it('copies on a press, says it did, and goes back to its label', async () => {
    render(<CopyDiagnosticsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(copy.calls).toBe(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeTruthy(), { timeout: 4000 });
  });

  it('says when nothing could be copied', async () => {
    copy.result = null;
    render(<CopyDiagnosticsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    expect(await screen.findByRole('button', { name: 'Couldn’t copy' })).toBeTruthy();
  });
});

describe('the error screen', () => {
  it('offers Copy diagnostics beside Reload, and tells the diagnostics what broke', async () => {
    render(<AppError error={new TypeError('Cannot read properties of undefined')} reset={vi.fn()} info={{ componentStack: '' }} />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(copy.calls).toBe(1);
    const { lastError } = await import('../lib/last-error.ts');
    expect(lastError()?.message).toBe('TypeError: Cannot read properties of undefined');
  });

  it('says that nothing is sent by itself', () => {
    recordError('x');
    render(<AppError error="boom" reset={vi.fn()} info={{ componentStack: '' }} />);
    expect(screen.getByRole('alert').textContent).toContain('Atelier sends nothing by itself');
  });
});
