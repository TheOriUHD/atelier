import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type Message } from '@atelier/protocol';
import { resetFromSnapshot } from '../../lib/live-session.ts';
import { backend, callsTo, resetBackend } from '../settings/test-backend.ts';
import { RewindDialog, rewindPoints } from './rewind.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/live-session.ts', () => ({ resetFromSnapshot: vi.fn() }));

const message = (id: string, role: Message['role'], text: string): Message => ({
  id,
  sessionId: 's1',
  parentId: null,
  role,
  parts: [{ type: 'text', text }],
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: 0,
});

const messages = [
  message('u1', 'user', 'Write the notes page'),
  message('a1', 'assistant', 'Done.'),
  message('u2', 'user', 'Now add a footer'),
  message('a2', 'assistant', 'Added.'),
  message('u3', 'user', 'Thanks!'),
];
const checkpoints = [
  { messageId: 'u1', paths: ['/repo/notes.md'] },
  { messageId: 'u2', paths: ['/repo/notes.md', '/repo/footer.md'] },
  // On a branch the conversation has left.
  { messageId: 'other', paths: ['/repo/x.md'] },
];
const snapshot = { session: { id: 's1' }, messages: [] };

beforeEach(() => {
  vi.mocked(resetFromSnapshot).mockClear();
  resetBackend({ 'checkpoints.rewind': () => ({ restored: ['/repo/notes.md', '/repo/footer.md'], snapshot }) });
});

function show(initial: string | null) {
  const onOpenChange = vi.fn();
  const onConversationRewound = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RewindDialog
        sessionId="s1"
        points={rewindPoints(messages, checkpoints)}
        initial={initial}
        root="/repo"
        open
        onOpenChange={onOpenChange}
        onConversationRewound={onConversationRewound}
      />
    </QueryClientProvider>,
  );
  return { dialog: screen.getByRole('dialog', { name: 'Rewind' }), onOpenChange, onConversationRewound };
}

describe('rewindPoints', () => {
  it('keeps the current branch’s messages that changed files, newest first', () => {
    expect(rewindPoints(messages, checkpoints).map((p) => [p.message.id, p.paths.length])).toEqual([
      ['u2', 2],
      ['u1', 1],
    ]);
  });
});

describe('RewindDialog', () => {
  it('lists the points with what they changed, says Bash isn’t tracked, and starts on the newest', () => {
    const { dialog } = show(null);
    expect(dialog.textContent).toContain('Changes made by Bash commands aren’t tracked');
    const radios = within(dialog).getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((r) => [r.closest('label')!.textContent, r.checked])).toEqual([
      ['Now add a footerChanged notes.md, footer.md', true],
      ['Write the notes pageChanged notes.md', false],
    ]);
  });

  it.each([
    ['Restore code and conversation', { files: true, conversation: true }, 'Write the notes page'],
    ['Restore conversation', { files: false, conversation: true }, 'Write the notes page'],
    ['Restore code', { files: true, conversation: false }, null],
  ])('“%s” rewinds with %o and applies the snapshot', async (label, flags, composerText) => {
    const { dialog, onOpenChange, onConversationRewound } = show('u2');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Write the notes page/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: label }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsTo('checkpoints.rewind')).toEqual([{ sessionId: 's1', messageId: 'u1', ...flags }]);
    expect(resetFromSnapshot).toHaveBeenCalledWith('s1', snapshot);
    if (composerText) expect(onConversationRewound).toHaveBeenCalledWith(composerText);
    else expect(onConversationRewound).not.toHaveBeenCalled();
  });

  it('shows why it could not rewind, and stays open', async () => {
    backend.handlers['checkpoints.rewind'] = () => {
      throw appError('busy', 'Stop the response before rewinding.');
    };
    const { dialog, onOpenChange } = show('u1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore code' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Stop the response before rewinding.');
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
