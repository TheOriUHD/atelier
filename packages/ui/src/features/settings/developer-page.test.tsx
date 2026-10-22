import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectedRequest } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { DeveloperPage } from './developer-page.tsx';
import { callsTo, emit, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const request = (extra: Partial<InspectedRequest>): InspectedRequest => ({
  id: 'r1',
  at: 0,
  method: 'POST',
  url: 'https://api.anthropic.com/v1/messages',
  requestHeaders: { 'x-api-key': '••••', 'content-type': 'application/json' },
  requestBytes: 2048,
  status: 200,
  ms: 412,
  error: null,
  errorBody: null,
  ...extra,
});

let inspector: boolean;

beforeEach(() => {
  inspector = false;
  resetBackend({
    'settings.get': () => snapshot({ developer: { inspector } }),
    'settings.set': ({ value }: { value: boolean }) => ((inspector = value), { ok: true }),
    'developer.requests': () => [request({})],
    'developer.clearRequests': () => ({ ok: true }),
    'developer.reload': () => ({ ok: true }),
    'mcp.status': () => [
      { name: 'cloudflare', type: 'http', state: 'ready', tools: [] },
      { name: 'notion', type: 'stdio', state: 'error', tools: [] },
    ],
    'mcp.logs': ({ name }: { name: string }) => ({ lines: [`12:00:00 ${name} says hello`] }),
  });
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}>
      <TooltipProvider>
        <DeveloperPage />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('Developer page', () => {
  it('switches the inspector, lists requests live, shows one, and clears them', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Provider requests' });
    expect(within(table).getByText('POST api.anthropic.com/v1/messages')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: 'Record provider requests' }));
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['developer', 'inspector'], value: true }]));

    emit('developer.request', request({ id: 'r2', url: 'https://api.anthropic.com/v1/models', method: 'GET', status: 529, errorBody: '{"error":"overloaded"}' }));
    await waitFor(() => expect(within(table).getAllByRole('row')[1]!.textContent).toContain('GET api.anthropic.com/v1/models'));
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('529');

    fireEvent.click(within(table).getByText('GET api.anthropic.com/v1/models'));
    const dialog = await screen.findByRole('dialog', { name: 'GET api.anthropic.com/v1/models' });
    expect(within(dialog).getByText(/x-api-key: ••••/)).toBeTruthy();
    expect(within(dialog).getByText('{"error":"overloaded"}')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText('No requests yet. Send a message to see the requests it makes.')).toBeTruthy();
    expect(callsTo('developer.clearRequests')).toHaveLength(1);
  });

  it('shows a connector’s log and reloads', async () => {
    renderPage();
    const log = await screen.findByLabelText('Log of cloudflare');
    await waitFor(() => expect(log.textContent).toBe('12:00:00 cloudflare says hello'));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(callsTo('developer.reload')).toHaveLength(1));
    expect(await screen.findByText('Reconnecting connectors and reading extensions again.')).toBeTruthy();
  });
});
