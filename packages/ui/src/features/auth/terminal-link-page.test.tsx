import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError, type TerminalSignInRequest } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { agoText, TerminalLinkPage, type TerminalLinkSearch } from './terminal-link-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const request: TerminalSignInRequest = { code: 'K7QF-3MZD', deviceName: 'Ada’s MacBook · terminal', platform: 'macOS', ip: '192.168.20.14', createdAt: Date.now() - 20_000, expiresAt: Date.now() + 580_000 };

function show(path: string) {
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/link', component: TerminalLinkPage, validateSearch: (s: Record<string, unknown>): TerminalLinkSearch => (typeof s.code === 'string' ? { code: s.code } : {}) }),
    createRoute({ getParentRoute: () => root, path: '/', component: () => <p>Home</p> }),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetBackend({
    'auth.terminalRequest': ({ code }: { code: string }) => {
      if (code.replace('-', '').toUpperCase() !== 'K7QF3MZD') throw new RpcError(-32000, 'No terminal is waiting with this code.', { code: 'not_found' });
      return request;
    },
    'auth.terminalDecide': () => ({ ok: true }),
  });
});

describe('the terminal sign-in page', () => {
  it('shows which computer asks and from where, then approves it', async () => {
    show('/link?code=K7QF-3MZD');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Sign in Atelier CLI on Ada’s MacBook · terminal?' })).toBeTruthy();
    expect(screen.getByText('192.168.20.14')).toBeTruthy();
    expect(screen.getByText(/Only approve a terminal you just started yourself/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('heading', { name: 'Your terminal is signed in' })).toBeTruthy();
    expect(callsTo('auth.terminalDecide')).toEqual([{ code: 'K7QF-3MZD', approve: true }]);
  });

  it('denies it', async () => {
    show('/link?code=K7QF-3MZD');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByRole('heading', { name: 'Sign-in denied' })).toBeTruthy();
    expect(callsTo('auth.terminalDecide')).toEqual([{ code: 'K7QF-3MZD', approve: false }]);
  });

  it('checks the code’s shape and says when no terminal waits with it', async () => {
    show('/link');
    const box = await screen.findByPlaceholderText('K7QF-3MZD');
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('A code has 8 letters and digits, like K7QF-3MZD.')).toBeTruthy();
    expect(callsTo('auth.terminalRequest')).toEqual([]);
    fireEvent.change(box, { target: { value: 'AAAA-AAAA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText(/No terminal is waiting with this code/)).toBeTruthy());
  });

  it('says how long ago a terminal asked', () => {
    expect(agoText(1000, 1500)).toBe('just now');
    expect(agoText(0, 20_000)).toBe('20 seconds ago');
    expect(agoText(0, 70_000)).toBe('a minute ago');
    expect(agoText(0, 190_000)).toBe('3 minutes ago');
  });
});
