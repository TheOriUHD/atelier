import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { GeneralPage } from './general-page.tsx';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const notification = { permission: 'default' as NotificationPermission, requestPermission: vi.fn(async () => notification.permission) };

beforeEach(() => {
  notification.permission = 'default';
  notification.requestPermission.mockClear();
  vi.stubGlobal('Notification', notification);
});
afterEach(() => vi.unstubAllGlobals());

function renderPage(prefs = defaultUserPrefs()) {
  resetBackend({ 'settings.get': () => snapshot(), 'models.list': () => [], 'prefs.get': () => prefs, 'prefs.set': () => prefs });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}>
      <TooltipProvider>
        <GeneralPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('task notifications', () => {
  it('are on by default; turning one on is when the browser asks for permission', async () => {
    renderPage({ ...defaultUserPrefs(), notifications: { taskFinished: false, permissionNeeded: true } });
    const needed = await screen.findByRole('switch', { name: 'Notify me when a task needs me' });
    await waitFor(() => expect(needed.getAttribute('aria-checked')).toBe('true'));
    const finished = screen.getByRole('switch', { name: 'Notify me when a task finishes' });
    expect(finished.getAttribute('aria-checked')).toBe('false');
    expect(notification.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(finished);
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['notifications', 'taskFinished'], value: true }]));
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('say so when the browser blocks them', async () => {
    notification.permission = 'denied';
    renderPage();
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent)).toEqual([
      expect.stringContaining('Notifications are blocked for Atelier'),
      expect.stringContaining('Notifications are blocked for Atelier'),
    ]);
  });
});
