import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { defaultSettings } from '@atelier/protocol';
import { resetBackend, snapshot } from '../settings/test-backend.ts';
import { PermissionModePicker, nextMode, useEffectiveMode } from './permission-mode.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

beforeEach(() => resetBackend({ 'settings.get': () => snapshot({ permissions: { ...defaultSettings().permissions, defaultMode: 'acceptEdits' } }) }));

describe('permission modes', () => {
  it('cycles Auto → Ask → Accept edits → Plan with Shift+Tab; Bypass goes back to Auto', () => {
    expect(nextMode('auto')).toBe('default');
    expect(nextMode('default')).toBe('acceptEdits');
    expect(nextMode('acceptEdits')).toBe('plan');
    expect(nextMode('plan')).toBe('auto');
    expect(nextMode('bypassPermissions')).toBe('auto');
  });

  it('follows the system default until a session picks its own', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ mode }) => useEffectiveMode(mode), { wrapper, initialProps: { mode: null as 'plan' | null } });
    await waitFor(() => expect(result.current).toBe('acceptEdits'));
    rerender({ mode: 'plan' });
    expect(result.current).toBe('plan');
  });

  it('picks a mode from the menu', async () => {
    const onChange = vi.fn();
    render(<PermissionModePicker value="plan" onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Permission mode: Plan mode' });
    expect(trigger.textContent).toBe('Plan');
    expect(trigger.className).toContain('text-interactive-text');
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Bypass permissions/ }));
    expect(onChange).toHaveBeenCalledWith('bypassPermissions');
  });
});
