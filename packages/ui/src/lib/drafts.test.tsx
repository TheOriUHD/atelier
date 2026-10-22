import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBackend, user } from '../features/settings/test-backend.ts';
import { DRAFT_MAX_AGE_MS, MAX_DRAFTS, draftText, pruneDrafts, saveDraft, useDraft } from './drafts.ts';

vi.mock('./rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../features/settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

/** The draft hook, once the signed-in person is known. */
async function renderDraft(key: string | undefined) {
  const hook = renderHook(({ k }) => useDraft(k), { wrapper, initialProps: { k: key } });
  if (key) await waitFor(() => expect(client.getQueryData(['account'])).toBeDefined());
  return hook;
}

beforeEach(() => {
  localStorage.clear();
  client = new QueryClient();
  resetBackend({});
});

describe('useDraft', () => {
  it('keeps the text in this browser, for the signed-in person, and drops it once empty', async () => {
    const { result } = await renderDraft('session:a');
    act(() => result.current[1]('half a thought'));
    expect(draftText('u-admin|session:a')).toBe('half a thought');
    expect(result.current[0]).toBe('half a thought');
    expect(JSON.parse(localStorage.getItem('atelier.drafts')!)).toMatchObject({ 'u-admin|session:a': { text: 'half a thought' } });
    act(() => result.current[1](''));
    expect(draftText('u-admin|session:a')).toBe('');
    expect(localStorage.getItem('atelier.drafts')).toBe('{}');
  });

  it('shows the kept draft again after the box was gone, and only under its own key', async () => {
    saveDraft('u-admin|session:a', 'kept');
    const first = await renderDraft('session:a');
    expect(first.result.current[0]).toBe('kept');
    first.unmount();
    const again = await renderDraft('session:a');
    expect(again.result.current[0]).toBe('kept');
    again.rerender({ k: 'session:b' });
    expect(again.result.current[0]).toBe('');
  });

  it('doesn’t show another person’s drafts', async () => {
    saveDraft('u-admin|new', 'Ada’s');
    resetBackend({ 'account.get': () => user({ id: 'u-grace' }) });
    const { result } = await renderDraft('new');
    act(() => result.current[1]('Grace’s'));
    expect(draftText('u-grace|new')).toBe('Grace’s');
    expect(draftText('u-admin|new')).toBe('Ada’s');
  });

  it('keeps text typed before the person was known', async () => {
    const { result } = renderHook(() => useDraft('new'), { wrapper });
    act(() => result.current[1]('early'));
    await waitFor(() => expect(draftText('u-admin|new')).toBe('early'));
    expect(result.current[0]).toBe('early');
  });

  it('without a key is only the box’s own state', async () => {
    const { result } = await renderDraft(undefined);
    act(() => result.current[1]('not kept'));
    expect(result.current[0]).toBe('not kept');
    expect(localStorage.getItem('atelier.drafts')).toBeNull();
  });
});

describe('pruneDrafts', () => {
  it('drops drafts left for 30 days and keeps the 50 most recent', () => {
    const now = 100 * DRAFT_MAX_AGE_MS;
    const drafts = Object.fromEntries(Array.from({ length: MAX_DRAFTS + 5 }, (_, i) => [`k${i}`, { text: 't', at: now - i }]));
    drafts.old = { text: 'stale', at: now - DRAFT_MAX_AGE_MS };
    const kept = pruneDrafts(drafts, now);
    expect(Object.keys(kept)).toHaveLength(MAX_DRAFTS);
    expect(kept.old).toBeUndefined();
    expect(kept.k0).toBeDefined();
    expect(kept[`k${MAX_DRAFTS}`]).toBeUndefined();
  });
});
