import { StrictMode, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QUOTE_MAX_CHARS, QUOTE_MAX_COUNT } from '@atelier/protocol';
import { useAttachments } from './use-attachments.ts';

const upload = vi.hoisted(() => vi.fn());
vi.mock('../../lib/rpc.ts', () => ({ rpc: () => ({ call: upload }), describeError: () => ({ message: 'Upload failed' }) }));
const draftScope = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../../lib/drafts.ts', async (original) => ({
  ...await original<typeof import('../../lib/drafts.ts')>(),
  useDraftScope: () => draftScope.value,
}));

// The hook reads the draft's owner (server + account) through a query.
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe('scoped attachment drafts', () => {
  it('keeps a pending upload across StrictMode cleanup and navigation', async () => {
    draftScope.value = 'strict-owner';
    let finish!: (value: unknown) => void;
    upload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const first = renderHook(() => useAttachments('pending'), { wrapper: strict });
    let added!: Promise<void>;
    act(() => { added = first.result.current.add([new File(['hello'], 'note.txt', { type: 'text/plain' })]); });
    await waitFor(() => expect(upload).toHaveBeenCalled());
    first.unmount();
    const second = renderHook(() => useAttachments('pending'), { wrapper: strict });
    expect(second.result.current.items).toHaveLength(1);
    await act(async () => {
      finish({ id: 'f', name: 'note.txt', mime: 'text/plain', size: 5, blob: 'abc', kind: 'upload', tokens: null, createdAt: 0 });
      await added;
    });
    expect(second.result.current.items[0]?.status).toBe('ready');
    act(() => second.result.current.clear());
    second.unmount();
    draftScope.value = null;
    upload.mockReset();
  });

  it('replaces a revoked local image preview when the account is discovered', async () => {
    draftScope.value = null;
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-image');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    upload.mockResolvedValue({ id: 'f', name: 'image.png', mime: 'image/png', size: 1, blob: 'image-sha', kind: 'upload', tokens: null, createdAt: 0 });
    const hook = renderHook(() => useAttachments('late-owner'));
    await act(async () => { await hook.result.current.add([new File(['x'], 'image.png', { type: 'image/png' })]); });
    draftScope.value = 'discovered-owner';
    hook.rerender();
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    expect(hook.result.current.items[0]?.preview).toContain('image-sha');
    expect(hook.result.current.items[0]?.preview).not.toBe('blob:local-image');
    act(() => hook.result.current.clear());
    hook.unmount();
    draftScope.value = null;
    create.mockRestore();
    revoke.mockRestore();
    upload.mockReset();
  });
});

describe('quoted passages', () => {
  it('are sent as the first parts of the message and cleared with it', () => {
    const { result } = renderHook(() => useAttachments(), { wrapper });
    act(() => result.current.addQuote('  The kettle boils at 100 °C.  '));
    expect(result.current.quotes).toEqual(['The kettle boils at 100 °C.']);
    expect(result.current.parts()).toEqual([{ type: 'context', text: '', notice: { kind: 'quote', text: 'The kettle boils at 100 °C.' } }]);
    act(() => result.current.clear());
    expect(result.current.quotes).toEqual([]);
    expect(result.current.parts()).toEqual([]);
  });

  it('are not added twice, nor empty, nor beyond the limits', () => {
    const { result } = renderHook(() => useAttachments(), { wrapper });
    act(() => {
      result.current.addQuote('same');
      result.current.addQuote('same');
      result.current.addQuote('   ');
      for (let i = 0; i < QUOTE_MAX_COUNT + 3; i++) result.current.addQuote(`passage ${i}`);
      result.current.addQuote('x'.repeat(QUOTE_MAX_CHARS + 50));
    });
    expect(result.current.quotes).toHaveLength(QUOTE_MAX_COUNT);
    act(() => result.current.clear());
    act(() => result.current.addQuote('y'.repeat(QUOTE_MAX_CHARS + 50)));
    expect(result.current.quotes[0]).toHaveLength(QUOTE_MAX_CHARS);
  });

  it('can be removed one by one and come back with a message that was taken back', () => {
    const { result } = renderHook(() => useAttachments(), { wrapper });
    act(() => {
      result.current.addQuote('one');
      result.current.addQuote('two');
    });
    act(() => result.current.removeQuote(0));
    expect(result.current.quotes).toEqual(['two']);
    act(() => result.current.restore([{ type: 'context', text: 'told', notice: { kind: 'quote', text: 'three' } }, { type: 'text', text: 'hi' }]));
    expect(result.current.quotes).toEqual(['two', 'three']);
  });
});

describe('files of a message that was taken back', () => {
  it('come back with their thumbnail and size, ready to send again without uploading', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array(2048)));
    const { result } = renderHook(() => useAttachments(), { wrapper });
    act(() => result.current.restore([{ type: 'image', mime: 'image/png', blob: 'abc123' }, { type: 'document', mime: 'application/pdf', blob: 'def456', name: 'plan.pdf' }]));
    const [image, doc] = result.current.items;
    expect(image).toMatchObject({ name: 'Image.png', status: 'ready', preview: expect.stringContaining('abc123') });
    expect(doc).toMatchObject({ name: 'plan.pdf', status: 'ready' });
    expect(doc!.preview).toBeUndefined();
    await waitFor(() => expect(result.current.items.map((a) => a.size)).toEqual([2048, 2048]));
    expect(result.current.parts()).toEqual([
      { type: 'image', mime: 'image/png', blob: 'abc123' },
      { type: 'document', mime: 'application/pdf', blob: 'def456', name: 'plan.pdf' },
    ]);
    fetchMock.mockRestore();
  });
});
