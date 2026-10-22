import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, RunPhase } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import type { LiveSessionState } from '../../lib/live-session.ts';
import { backend, callsTo, resetBackend } from '../settings/test-backend.ts';
import { Transcript } from './transcript.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const message = (id: string, role: Message['role'], extra: Partial<Message> = {}): Message => ({
  id,
  sessionId: 's',
  parentId: null,
  role,
  parts: [],
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: 0,
  ...extra,
});

function live(messages: Message[]): LiveSessionState {
  return {
    session: { id: 's', mode: 'chat', workspaceId: null, permissionMode: null, title: 'Chat', projectId: null, model: null, effort: null, connectorsOff: [], research: false, status: 'idle', pinnedAt: null, createdAt: 0, updatedAt: 0 },
    messages,
    siblings: {},
    streamingMessageId: null,
    pending: null,
    todos: [],
    tasks: [],
    toolOutput: {},
    context: null,
    compacting: false,
    queued: null,
    phase: null,
    outbox: [],
    seq: 1,
    status: 'ready',
    error: null,
    toolInputs: {},
    artifacts: {},
  };
}

function show(messages: Message[]) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <Transcript sessionId="s" live={live(messages)} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => resetBackend({ 'models.list': () => [], 'artifacts.list': () => [], 'chat.retry': () => ({ ok: true }), 'chat.edit': () => ({ ok: true }) }));

describe('Transcript', () => {
  const asked = message('u1', 'user', { parts: [{ type: 'text', text: 'Write the scene' }] });

  it("opens the person's attached images in the lightbox, one group per message", async () => {
    show([
      message('u0', 'user', {
        parts: [
          { type: 'image', mime: 'image/png', blob: 'shaA' },
          { type: 'document', mime: 'text/plain', blob: 'shaD', name: 'notes.txt' },
          { type: 'image', mime: 'image/png', blob: 'shaB' },
          { type: 'text', text: 'Compare these' },
        ],
      }),
    ]);
    const attached = screen.getAllByRole('button', { name: 'Attachment' });
    expect(attached).toHaveLength(2);
    expect(attached[1]!.className).toContain('cursor-zoom-in');
    fireEvent.click(attached[1]!);
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    expect(dialog.querySelector('img')!.getAttribute('src')).toContain('shaB');
    expect(within(dialog).getByText('2 of 2')).toBeTruthy();
  });

  it('offers Continue under a reply a restart cut off, which carries on instead of starting over', async () => {
    backend.handlers['chat.continue'] = () => ({ ok: true });
    const state = live([asked, message('a1', 'assistant', { parentId: 'u1', parts: [{ type: 'text', text: 'It began' }] })]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <Transcript sessionId="s" live={{ ...state, session: { ...state.session!, status: 'interrupted' } }} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Atelier restarted and cut off this reply.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(callsTo('chat.continue')).toEqual([{ sessionId: 's' }]));
    expect(callsTo('chat.retry')).toEqual([]);
  });

  it("says when the model provider stopped a reply, with Edit and Retry, and doesn't retry by itself", async () => {
    show([asked, message('a1', 'assistant', { parentId: 'u1', parts: [{ type: 'text', text: 'It began' }], stopReason: 'refusal' })]);
    expect(screen.getByText('It began')).toBeTruthy();
    const notice = within(screen.getByRole('status'));
    expect(notice.getByText('The model provider stopped this response. Edit your message or try again.')).toBeTruthy();
    expect(callsTo('chat.retry')).toEqual([]);

    fireEvent.click(notice.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(callsTo('chat.retry')).toEqual([{ sessionId: 's', messageId: 'a1' }]));

    // Edit opens the person's message for editing, as its own Edit action does.
    fireEvent.click(notice.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    expect((box as HTMLTextAreaElement).value).toBe('Write the scene');
    fireEvent.change(box, { target: { value: 'Write a gentler scene' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(callsTo('chat.edit')).toEqual([{ sessionId: 's', messageId: 'u1', parts: [{ type: 'text', text: 'Write a gentler scene' }] }]));
  });

  it("copies a reply with the tags it quoted as they were, not as the model read them", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    show([asked, message('a1', 'assistant', { parentId: 'u1', parts: [{ type: 'text', text: 'The file ends with `‹/project>`.' }], stopReason: 'end' })]);
    expect(screen.getByText('</project>')).toBeTruthy();
    // The person's message has a Copy button too; the reply's comes last.
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' }).at(-1)!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('The file ends with `</project>`.'));
    vi.unstubAllGlobals();
  });

  it('says how long ago each message was sent, and the exact time after a click', () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-10-21T09:00:00').getTime();
      vi.setSystemTime(now);
      show([
        message('u1', 'user', { parts: [{ type: 'text', text: 'Write the scene' }], createdAt: now - 11 * 60_000 }),
        message('a1', 'assistant', { parentId: 'u1', parts: [{ type: 'text', text: 'Done' }], stopReason: 'end', createdAt: now - 3 * 60_000 }),
      ]);
      expect(screen.getByRole('button', { name: '11 minutes ago' })).toBeTruthy();
      const reply = screen.getByRole('button', { name: '3 minutes ago' });
      const exact = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(now - 3 * 60_000);
      expect(reply.getAttribute('title')).toBe(exact);
      fireEvent.click(reply);
      expect(screen.getByRole('button', { name: exact })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: exact }));
      expect(screen.getByRole('button', { name: '3 minutes ago' })).toBeTruthy();
      // The label moves on with the clock.
      act(() => void vi.advanceTimersByTime(3 * 60_000));
      expect(screen.getByRole('button', { name: '6 minutes ago' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the running line from the person's message, not from the step the run is in", () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-10-21T09:00:00').getTime();
      vi.setSystemTime(now);
      const state = live([
        message('u1', 'user', { parts: [{ type: 'text', text: 'Fix it' }], createdAt: now - 95_000 }),
        message('a1', 'assistant', { parentId: 'u1', parts: [{ type: 'tool_call', id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }], createdAt: now - 5_000 }),
      ]);
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TooltipProvider>
            <Transcript sessionId="s" live={{ ...state, session: { ...state.session!, status: 'running' } }} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
      expect(screen.getByText('1m 35s')).toBeTruthy();
      expect(screen.queryByText('5s')).toBeNull();
      act(() => void vi.advanceTimersByTime(2_000));
      expect(screen.getByText('1m 37s')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says what a local model's server does before the reply starts, a new line every 3 seconds, then the reply", () => {
    vi.useFakeTimers();
    try {
      const reply = message('a1', 'assistant', { parentId: 'u1' });
      const running = (phase: RunPhase | null, parts: Message['parts'] = []): LiveSessionState => {
        const state = live([asked, { ...reply, parts }]);
        return { ...state, session: { ...state.session!, status: 'running' }, streamingMessageId: 'a1', phase };
      };
      const ui = (state: LiveSessionState) => (
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TooltipProvider>
            <Transcript sessionId="s" live={state} />
          </TooltipProvider>
        </QueryClientProvider>
      );
      const { rerender } = render(ui(running(null)));
      expect(screen.getByRole('img', { name: 'Thinking' })).toBeTruthy();

      rerender(ui(running('loading')));
      expect(screen.getByText('Loading the model…')).toBeTruthy();
      expect(screen.queryByRole('img', { name: 'Thinking' })).toBeNull();
      // The line holds still while nothing has changed (no rotating through different words every few seconds)...
      act(() => vi.advanceTimersByTime(19_000));
      expect(screen.getByText('Loading the model…')).toBeTruthy();
      // ...and moves on when it has something new to say: it is taking a while.
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByText('Still loading the model, a large one takes a while…')).toBeTruthy();
      act(() => vi.advanceTimersByTime(40_000));
      expect(screen.getByText('Still loading, this is taking longer than usual…')).toBeTruthy();

      // Loaded: reading starts over at its first line.
      rerender(ui(running('reading')));
      expect(screen.getByText('Reading the conversation…')).toBeTruthy();
      act(() => vi.advanceTimersByTime(20_000));
      expect(screen.getByText('Still reading, a long conversation takes a while…')).toBeTruthy();

      rerender(ui(running(null, [{ type: 'text', text: 'Once upon' }])));
      expect(document.body.textContent).toContain('Once upon');
      expect(document.body.textContent).not.toMatch(/Still reading|Reading the conversation/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no notice for replies that ended normally', () => {
    show([asked, message('a1', 'assistant', { parentId: 'u1', parts: [{ type: 'text', text: 'Done' }], stopReason: 'end' })]);
    expect(screen.queryByText(/The model provider stopped/)).toBeNull();
  });
  it('shows the passage a reply quotes above the message, not what the model was told, and keeps it when the message is edited', async () => {
    show([
      message('u1', 'user', {
        parts: [
          { type: 'context', text: 'The person is replying to this passage from earlier in the conversation:\n> The kettle boils at 100 °C.', notice: { kind: 'quote', text: 'The kettle boils at 100 °C.' } },
          { type: 'text', text: 'Why that number?' },
        ],
      }),
      message('a1', 'assistant', { parentId: 'u1', parts: [{ type: 'text', text: 'At sea level.' }], stopReason: 'end' }),
    ]);
    const quoted = screen.getByRole('group', { name: 'Quoted text' });
    expect(quoted.textContent).toBe('The kettle boils at 100 °C.');
    expect(screen.queryByText(/is replying to this passage/)).toBeNull();
    expect(screen.getByText('Why that number?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Why is it exactly that?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(callsTo('chat.edit')).toHaveLength(1));
    expect(callsTo('chat.edit')[0]).toMatchObject({
      messageId: 'u1',
      parts: [{ type: 'context', notice: { kind: 'quote', text: 'The kettle boils at 100 °C.' } }, { type: 'text', text: 'Why is it exactly that?' }],
    });
  });

  it('marks a message a loop sent, and shows a background sub-agent’s end as one row, not its note', () => {
    show([
      message('u1', 'user', { parts: [{ type: 'text', text: 'check the deploy' }, { type: 'context', text: 'This message comes from a loop…', notice: { kind: 'loop', loopId: 'loop:1', run: 2 } }] }),
      message('a1', 'assistant', { parentId: 'u1', parts: [{ type: 'text', text: 'Still green.' }], stopReason: 'end' }),
      message('n1', 'user', { kind: 'context', parts: [{ type: 'context', text: 'The background sub-agent "Survey the repo" has finished…', notice: { kind: 'agent', taskId: 'agent:c', title: 'Survey the repo', status: 'done', sessionId: 'c' } }] }),
    ]);
    expect(screen.getByLabelText('Sent by a loop, run 2').textContent).toBe('Loop');
    expect(screen.getByText('check the deploy')).toBeTruthy();
    expect(screen.queryByText(/This message comes from a loop/)).toBeNull();
    expect(screen.getByText(/^Background agent finished ·/).textContent).toBe('Background agent finished · Survey the repo');
    expect(screen.queryByText(/has finished…/)).toBeNull();
  });
});
