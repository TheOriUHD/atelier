import { createRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxMessage } from '@atelier/protocol';
import { callsTo, model, resetBackend } from '../settings/test-backend.ts';
import { Composer, type ComposerHandle } from './composer.tsx';
import { Outbox, useSessionSend } from './outbox.tsx';
import type { Attachments } from './use-attachments.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const attachments = (restore = vi.fn(), parts: Attachments['parts'] = () => []): Attachments => ({ items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: vi.fn(), restore, uploading: false, parts });
const waiting = (id: string, text: string, extra: OutboxMessage['parts'] = []): OutboxMessage => ({ id, parts: [...extra, { type: 'text', text }] });

beforeEach(() => resetBackend({ 'chat.send': () => ({ userMessageId: 'u' }), 'chat.queue': () => ({ id: 'q', queued: true }), 'chat.stop': () => ({ ok: true }), 'chat.sendNow': () => ({ ok: true }) }));

describe('waiting messages', () => {
  it('show under the conversation with Take back and Send now', () => {
    const actions = { onTakeBack: vi.fn(), onSendNow: vi.fn() };
    render(<Outbox items={[waiting('a', 'also add tests'), waiting('b', 'and a changelog line', [{ type: 'document', mime: 'text/plain', blob: 'x', name: 'notes.txt' }])]} actions={actions} />);
    const rows = screen.getAllByTestId('waiting-message');
    expect(rows.map((r) => r.textContent)).toEqual(['also add testsWaiting for the next stepSend now', 'and a changelog line1 fileWaiting for the next stepSend now']);
    fireEvent.click(screen.getAllByRole('button', { name: 'Take back and edit' })[1]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Send now' })[0]!);
    expect(actions.onTakeBack).toHaveBeenCalledWith('b');
    expect(actions.onSendNow).toHaveBeenCalledWith('a');
  });

  it('render nothing when none wait', () => {
    const { container } = render(<Outbox items={[]} actions={{ onTakeBack: vi.fn(), onSendNow: vi.fn() }} />);
    expect(container.textContent).toBe('');
  });
});

describe('the message box while the agent works', () => {
  const setup = (streaming: boolean) => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Composer variant="reply" attachments={attachments()} model={model('fake', 'm')} streaming={streaming} onSubmit={onSubmit} onStop={onStop} />
      </QueryClientProvider>,
    );
    return { onSubmit, onStop, box: screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }) };
  };

  it('shows Stop while it is empty, and Send once there is text, which sends on Enter', () => {
    const { onSubmit, onStop, box } = setup(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.change(box, { target: { value: 'one more thing' } });
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('one more thing');
    expect(box.value).toBe('');
  });

  it('stops on Escape while the agent works and the box is empty, and leaves Escape alone otherwise', () => {
    const { onStop, box } = setup(true);
    fireEvent.change(box, { target: { value: 'half a thought' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onStop).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('docks what the run waits on at the top of the box, inside its frame', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Composer variant="reply" attachments={attachments()} model={model('fake', 'm')} streaming onSubmit={vi.fn()} dock={<div data-testid="question">Which database?</div>} />
      </QueryClientProvider>,
    );
    const question = screen.getByTestId('question');
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(question.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(question.closest('.shadow-composer')).toBe(box.closest('.shadow-composer'));
  });

  it('adds a message taken back on a line of its own', () => {
    const handle = createRef<ComposerHandle>();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Composer ref={handle} variant="reply" attachments={attachments()} model={model('fake', 'm')} streaming onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    act(() => handle.current!.append('first'));
    expect(box.value).toBe('first');
    fireEvent.change(box, { target: { value: 'first draft ' } });
    act(() => handle.current!.append('second'));
    expect(box.value).toBe('first draft\nsecond');
  });
});

describe('useSessionSend', () => {
  function hook(busy: boolean, outbox: OutboxMessage[] = []) {
    const composer = { current: { setText: vi.fn(), append: vi.fn(), mention: vi.fn(), focus: vi.fn() } };
    const files = attachments(vi.fn(), () => [{ type: 'image', mime: 'image/png', blob: 'b1' }]);
    const follow = vi.fn();
    const { result } = renderHook(() => useSessionSend({ sessionId: 's1', busy, outbox, attachments: files, composer, follow }));
    return { result, composer, files, follow };
  }

  it('queues while the agent works and sends otherwise, with the attachments', async () => {
    const working = hook(true);
    working.result.current.send('keep going');
    await waitFor(() => expect(callsTo('chat.queue')).toEqual([{ sessionId: 's1', parts: [{ type: 'image', mime: 'image/png', blob: 'b1' }, { type: 'text', text: 'keep going' }] }]));
    expect(callsTo('chat.send')).toEqual([]);
    expect(working.files.clear).toHaveBeenCalled();
    expect(working.follow).toHaveBeenCalled();

    const idle = hook(false);
    idle.result.current.send('hello');
    await waitFor(() => expect(callsTo('chat.send')).toHaveLength(1));
  });

  it('puts a message taken back into the box, and gives back what waited when Stop is pressed', async () => {
    resetBackend({ 'chat.unqueue': () => ({ parts: [{ type: 'text', text: 'never mind' }] }), 'chat.stop': () => ({ ok: true }) });
    const { result, composer, files } = hook(true, [waiting('a', 'first'), waiting('b', 'second')]);
    result.current.actions.onTakeBack('a');
    await waitFor(() => expect(composer.current.append).toHaveBeenCalledWith('never mind'));
    expect(files.restore).toHaveBeenCalled();
    composer.current.append.mockClear();
    result.current.stop();
    await waitFor(() => expect(composer.current.append.mock.calls).toEqual([['first'], ['second']]));
    expect(callsTo('chat.stop')).toHaveLength(1);
  });
});
