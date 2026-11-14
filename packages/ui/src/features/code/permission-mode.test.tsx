import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { defaultSettings } from '@atelier/protocol';
import { resetBackend, snapshot } from '../settings/test-backend.ts';
import { CHAT_MODES, chatMode, PermissionModePicker, nextMode, useEffectiveMode } from './permission-mode.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

beforeEach(() =>
  resetBackend({
    'settings.get': () => snapshot({ permissions: { ...defaultSettings().permissions, defaultMode: 'acceptEdits' } }),
    'app.info': () => ({ name: 'Atelier', version: '0.8.1', surface: 'web', platform: 'linux', dataDir: '', planAuto: true }),
  }),
);

/** The picker reads what the server offers (Plan · Auto), so it needs a query client. */
const withQueries = (node: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>;

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
    render(withQueries(<PermissionModePicker value="plan" onChange={onChange} />));
    const trigger = screen.getByRole('button', { name: 'Permission mode: Plan mode' });
    expect(trigger.textContent).toBe('Plan');
    expect(trigger.className).toContain('text-interactive-text');
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Bypass permissions/ }));
    expect(onChange).toHaveBeenCalledWith('bypassPermissions');
  });

  it('offers a chat no Plan, which it has no plan to approve, and shows Plan from the system default as Ask', async () => {
    expect(chatMode('plan')).toBe('default');
    expect(chatMode('auto')).toBe('auto');
    render(withQueries(<PermissionModePicker value={chatMode('plan')} onChange={vi.fn()} modes={CHAT_MODES} hint={false} />));
    fireEvent.click(screen.getByRole('button', { name: 'Permission mode: Ask permissions' }));
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.some((i) => /^Plan mode/.test(i.textContent ?? ''))).toBe(false);
    expect(items).toHaveLength(4);
    expect(screen.queryByText(/Shift\+Tab/)).toBeNull();
  });

  it('chooses Plan answered by the person or by the reviewer in Plan’s side menu', async () => {
    const onChange = vi.fn();
    render(withQueries(<PermissionModePicker value="planAuto" onChange={onChange} />));
    const trigger = screen.getByRole('button', { name: 'Permission mode: Plan mode · Auto' });
    expect(trigger.textContent).toBe('Plan · Auto');
    expect(trigger.className).toContain('text-interactive-text');
    fireEvent.click(trigger);
    const plan = await screen.findByRole('menuitem', { name: /^Plan mode/ });
    fireEvent.click(plan);
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Manual/ }));
    expect(onChange).toHaveBeenCalledWith('plan');
    expect(chatMode('planAuto')).toBe('auto');
  });
});
