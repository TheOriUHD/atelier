import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '../components/ui/index.ts';
import { emit, resetBackend } from '../features/settings/test-backend.ts';
import { useLiveQueries } from './queries.ts';
import { clearServerUpdating, markServerUpdating, serverUpdating, UPDATING_TOAST_ID, UPDATING_WINDOW_MS, updatingWords } from './server-updating.ts';

vi.mock('../components/ui/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../components/ui/index.ts')>();
  return { ...original, toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }) };
});
vi.mock('./rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../features/settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

beforeEach(() => {
  clearServerUpdating();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.dismiss).mockClear();
  resetBackend({});
});
afterEach(() => clearServerUpdating());

function LiveQueries() {
  useLiveQueries();
  return null;
}

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LiveQueries />
    </QueryClientProvider>,
  );

describe('the server restarting into a new version', () => {
  it('counts for a minute and a half after the notice, and then no longer', () => {
    const at = Date.now();
    expect(serverUpdating(at)).toBeUndefined();
    markServerUpdating('0.10.6', at);
    expect(serverUpdating(at + 1000)).toEqual({ version: '0.10.6' });
    expect(serverUpdating(at + UPDATING_WINDOW_MS + 1)).toBeUndefined();
    markServerUpdating(null, at);
    expect(serverUpdating(at)).toEqual({ version: null });
    clearServerUpdating();
    expect(serverUpdating(at)).toBeUndefined();
  });

  it('survives a reload through session storage', () => {
    markServerUpdating('0.10.6');
    expect(JSON.parse(sessionStorage.getItem('atelier.serverUpdating')!)).toMatchObject({ version: '0.10.6' });
    clearServerUpdating();
    expect(sessionStorage.getItem('atelier.serverUpdating')).toBeNull();
  });

  it('names the version when it is known', () => {
    expect(updatingWords('0.10.6')).toBe('Atelier is installing an update (0.10.6). This page reconnects in a moment.');
    expect(updatingWords(null)).toBe('Atelier is installing an update. This page reconnects in a moment.');
  });

  it('shows a calm notice when the server says it installs, and takes it back when the install did not happen', () => {
    mount();
    act(() => emit('server.updating', { installing: true, version: '0.10.6' }));
    expect(toast.info).toHaveBeenCalledWith('Atelier is installing an update (0.10.6). This page reconnects in a moment.', { id: UPDATING_TOAST_ID, duration: 60_000 });
    expect(serverUpdating()).toEqual({ version: '0.10.6' });

    act(() => emit('server.updating', { installing: false, version: '0.10.6' }));
    expect(toast.dismiss).toHaveBeenCalledWith(UPDATING_TOAST_ID);
    expect(serverUpdating()).toBeUndefined();
  });
});
