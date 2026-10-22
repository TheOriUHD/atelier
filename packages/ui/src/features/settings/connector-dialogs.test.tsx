import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/index.ts';
import { AddConnectorDialog } from './connector-dialogs.tsx';
import { resetBackend } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** The names that are taken, as the page that owns the dialog computes them from the settings it refetches. */
let taken: ReadonlySet<string> = new Set(['github']);
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function addName(name: string) {
  taken = new Set([...taken, name]);
  for (const listener of listeners) listener();
}

function Harness() {
  const names = useSyncExternalStore(subscribe, () => taken);
  // The dialog stays mounted: a closing dialog keeps showing its content for the length of its exit animation.
  return <AddConnectorDialog open onOpenChange={() => {}} desktop={false} taken={names} onAdded={() => {}} />;
}

describe('AddConnectorDialog', () => {
  it('does not call the connector it just added a duplicate while it goes away', async () => {
    resetBackend({
      'settings.set': ({ path }: { path: string[] }) => {
        act(() => addName(path.at(-1)!));
        return { ok: true };
      },
      'settings.get': () => ({}),
      'mcp.status': () => [],
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Custom/ }));
    const form = within(await screen.findByRole('dialog', { name: 'Add a custom connector' }));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'mock' } });
    fireEvent.change(form.getByLabelText('URL'), { target: { value: 'http://127.0.0.1:9000/mcp' } });
    fireEvent.click(form.getByRole('button', { name: 'Add connector' }));

    // Written: the name is taken now.
    await waitFor(() => expect(form.getByRole('button', { name: 'Add connector' })).toBeTruthy());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByText('There is a connector with this name already.')).toBeNull();
  });
});
