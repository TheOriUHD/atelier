import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from './app-error.tsx';

describe('AppError', () => {
  it('says what broke and offers a way back that needs no Task Manager', () => {
    const reset = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<AppError error={new TypeError("Cannot read properties of undefined (reading 'enabled')")} reset={reset} info={{ componentStack: '' }} />);
    expect(screen.getByRole('alert').textContent).toContain("reading 'enabled'");
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
