import { createRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { draftKeys, draftText } from '../../lib/drafts.ts';
import { model, resetBackend } from '../settings/test-backend.ts';
import { Composer, type ComposerHandle } from './composer.tsx';
import type { Attachments } from './use-attachments.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const attachments: Attachments = { items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: () => {}, restore: () => {}, uploading: false, parts: () => [] };

let client: QueryClient;

/** A message box keeping the draft `draftKey`, once the signed-in person is known. */
async function box(draftKey: string, { onSubmit = vi.fn(), ref = createRef<ComposerHandle>() } = {}) {
  const view = render(
    <QueryClientProvider client={client}>
      <Composer ref={ref} variant="reply" draftKey={draftKey} attachments={attachments} model={model('fake', 'm')} streaming={false} onSubmit={onSubmit} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(client.getQueryData(['account'])).toBeDefined());
  return { ...view, onSubmit, ref, input: () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }) };
}

beforeEach(() => {
  localStorage.clear();
  client = new QueryClient();
  resetBackend({});
});

describe('the message box’s draft', () => {
  it('focuses the prompt on entry and when switching conversations without remounting', () => {
    const content = (id: string) => <QueryClientProvider client={client}><button>Other pane</button><Composer autoFocus variant="reply" draftKey={draftKeys.session(id)} attachments={attachments} model={model('fake', 'm')} streaming={false} onSubmit={() => {}} /></QueryClientProvider>;
    const view = render(content('a'));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
    act(() => screen.getByRole('button', { name: 'Other pane' }).focus());
    view.rerender(content('b'));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
  });
  it('opens an unsent image independently of its remove button', async () => {
    const remove = vi.fn();
    render(<QueryClientProvider client={client}><Composer variant="reply" attachments={{ ...attachments, remove, items: [{ key: 'image', name: 'diagram.png', mime: 'image/png', size: 12, status: 'ready', preview: 'data:image/png;base64,aGVsbG8=' }] }} model={model('fake', 'm')} streaming={false} onSubmit={() => {}} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open diagram.png' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
  });
  it('is still there after leaving a conversation and coming back', async () => {
    const first = await box(draftKeys.session('a'));
    fireEvent.change(first.input(), { target: { value: 'unsent thought' } });
    first.unmount();
    const again = await box(draftKeys.session('a'));
    expect(again.input().value).toBe('unsent thought');
  });

  it('belongs to its conversation and doesn’t show in another', async () => {
    const a = await box(draftKeys.session('a'));
    fireEvent.change(a.input(), { target: { value: 'for a' } });
    a.unmount();
    const b = await box(draftKeys.session('b'));
    expect(b.input().value).toBe('');
    fireEvent.change(b.input(), { target: { value: 'for b' } });
    b.unmount();
    expect((await box(draftKeys.session('a'))).input().value).toBe('for a');
  });

  it('is shared by the new chat and the new Cowork task, both ways, every time, but not with Code’s new session', async () => {
    const chat = await box(draftKeys.newChat);
    fireEvent.change(chat.input(), { target: { value: 'plan the trip' } });
    chat.unmount();
    const cowork = await box(draftKeys.newChat);
    expect(cowork.input().value).toBe('plan the trip');
    fireEvent.change(cowork.input(), { target: { value: 'plan the trip to Rome' } });
    cowork.unmount();
    const chatAgain = await box(draftKeys.newChat);
    expect(chatAgain.input().value).toBe('plan the trip to Rome');
    chatAgain.unmount();
    expect((await box(draftKeys.newCode)).input().value).toBe('');
  });

  it('is cleared by sending', async () => {
    const { input, onSubmit, unmount } = await box(draftKeys.session('a'));
    fireEvent.change(input(), { target: { value: 'send me' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('send me');
    expect(draftText('u-admin|session:a')).toBe('');
    unmount();
    expect((await box(draftKeys.session('a'))).input().value).toBe('');
  });

  it('takes a waiting message taken back into the box', async () => {
    const { input, ref } = await box(draftKeys.session('a'));
    fireEvent.change(input(), { target: { value: 'first' } });
    act(() => ref.current!.append('taken back'));
    expect(draftText('u-admin|session:a')).toBe('first\ntaken back');
  });
});
