import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { model, resetBackend } from '../settings/test-backend.ts';
import { Composer } from './composer.tsx';
import type { Attachments } from './use-attachments.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const attachments: Attachments = { items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: () => {}, restore: () => {}, uploading: false, parts: () => [] };

function box(suggestion: string | null, streaming = false) {
  const client = new QueryClient();
  const content = (s: string | null, busy: boolean) => (
    <QueryClientProvider client={client}>
      <Composer variant="reply" attachments={attachments} model={model('fake', 'm')} streaming={busy} onSubmit={() => {}} suggestion={s} />
    </QueryClientProvider>
  );
  const view = render(content(suggestion, streaming));
  return { input: () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }), next: (s: string | null, busy = false) => view.rerender(content(s, busy)) };
}

beforeEach(() => {
  localStorage.clear();
  resetBackend({});
});

describe('a suggested reply', () => {
  it('shows in the empty box and goes in with Tab, as text to send, change or delete', () => {
    const { input } = box('push it and release 0.2.11');
    expect(input().placeholder).toBe('push it and release 0.2.11');
    expect(input().getAttribute('aria-description')).toBe('Suggested: push it and release 0.2.11. Press Tab to use it.');
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(input().value).toBe('push it and release 0.2.11');
    // Once in, it is the person's text: emptied again, the box doesn't offer the same suggestion twice.
    fireEvent.change(input(), { target: { value: '' } });
    expect(input().placeholder).toBe('Reply');
  });

  it('is set aside once the person types, until the next one comes', () => {
    const { input, next } = box('run the tests');
    fireEvent.change(input(), { target: { value: 'n' } });
    fireEvent.change(input(), { target: { value: '' } });
    expect(input().placeholder).toBe('Reply');
    // Tab is Tab again (no suggestion in the way).
    expect(fireEvent.keyDown(input(), { key: 'Tab' })).toBe(true);
    next('commit it');
    expect(input().placeholder).toBe('commit it');
  });

  it('is not offered while the agent works', () => {
    const { input } = box('commit it', true);
    expect(input().placeholder).toBe('Reply');
  });
});
