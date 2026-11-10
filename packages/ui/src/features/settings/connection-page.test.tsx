import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/index.ts';
import { setLocal } from '../auth/screen-lock.ts';
import { ConnectionPage } from './connection-page.tsx';
import { callsTo, resetBackend } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));

function desktopBridge(connection: { mode: 'local' | 'server'; serverUrl: string | null }, check?: (choice: unknown) => Promise<void>) {
  const bridge = {
    connection: {
      get: vi.fn(async () => connection),
      // A switch reloads the window, so a working one never settles.
      set: vi.fn(() => new Promise<void>(() => {})),
      check: vi.fn(check ?? (async () => {})),
    },
  };
  platform.desktop = bridge;
  return bridge;
}

beforeEach(() => resetBackend({ 'auth.logout': () => ({ ok: true }) }));
afterEach(() => {
  platform.desktop = undefined;
  setLocal(false);
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ConnectionPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('Settings › Connection', () => {
  it('on this computer, connects to a server that answers, with nothing to sign out of', async () => {
    setLocal(true);
    const bridge = desktopBridge({ mode: 'local', serverUrl: null });
    renderPage();
    expect(await screen.findByText('In use')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /An Atelier server/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Server address' }), { target: { value: 'atelier.home/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(bridge.connection.set).toHaveBeenCalledWith({ mode: 'server', serverUrl: 'atelier.home' }));
    expect(bridge.connection.check).toHaveBeenCalledWith({ mode: 'server', serverUrl: 'atelier.home' });
    expect(callsTo('auth.logout')).toEqual([]);
  });

  it('keeps the server in use when the new address doesn’t answer, and says why', async () => {
    const bridge = desktopBridge({ mode: 'server', serverUrl: 'https://atelier.lan' }, async () => {
      throw new Error('No Atelier server answered at nowhere.lan.');
    });
    renderPage();
    expect(await screen.findByText(/Signed in to atelier\.lan/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /An Atelier server/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Server address' }), { target: { value: 'nowhere.lan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch server' }));
    expect(await screen.findByText('No Atelier server answered at nowhere.lan.')).toBeTruthy();
    expect(bridge.connection.set).not.toHaveBeenCalled();
    expect(callsTo('auth.logout')).toEqual([]);
  });

  it('from a server, signs out of it and switches to this computer', async () => {
    const bridge = desktopBridge({ mode: 'server', serverUrl: 'https://atelier.lan' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /This computer/ }));
    expect(screen.getByText(/This app logs out of atelier\.lan and runs Atelier itself/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to this computer' }));
    await waitFor(() => expect(bridge.connection.set).toHaveBeenCalledWith({ mode: 'local' }));
    expect(callsTo('auth.logout')).toHaveLength(1);
    expect(bridge.connection.check).not.toHaveBeenCalled();
  });
});
