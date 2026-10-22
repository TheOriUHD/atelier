import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SessionSnapshot, SessionSummary } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { backend, callsTo, model, resetBackend } from '../settings/test-backend.ts';
import type { PaneFrameState } from '../code/pane-dock.tsx';
import { SideChatPane } from '../code/side-chat-pane.tsx';
import { Composer } from './composer.tsx';
import { btwCommand, useSideChats } from './side-chat.tsx';
import { useAttachments } from './use-attachments.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTransport: () => ({ onReconnect: () => () => {} }),
}));

const fake = model('fake', 'chat');

const summary = (id: string, title: string): SessionSummary => ({
  id,
  mode: 'code',
  workspaceId: null,
  permissionMode: null,
  title,
  projectId: null,
  model: fake.ref,
  effort: 'low',
  connectorsOff: [],
  research: false,
  status: 'idle',
  pinnedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

const message = (id: string, role: Message['role'], text: string): Message => ({
  id,
  sessionId: 's',
  parentId: null,
  role,
  parts: [{ type: 'text', text }],
  model: null,
  usage: null,
  stopReason: role === 'assistant' ? 'end' : null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: 0,
});

/** Live sessions outlast a test (they are let go 30s after their last view): every test's side chats are new ones. */
let made = 0;

/** Side chats as the backend keeps them: a question starts one that has answered it. */
function sideBackend() {
  const chats: SessionSummary[] = [];
  const asked = new Map<string, string>();
  resetBackend({
    'models.list': () => [fake],
    'sideChats.list': () => [...chats],
    'sideChats.start': ({ question }: { question?: string }) => {
      const chat = summary(`side-${++made}`, question ?? '');
      chats.push(chat);
      if (question) asked.set(chat.id, question);
      return chat;
    },
    'sessions.delete': ({ id }: { id: string }) => {
      chats.splice(chats.findIndex((c) => c.id === id), 1);
      return { ok: true };
    },
    'sessions.subscribe': ({ id }: { id: string }): SessionSnapshot => {
      const question = asked.get(id);
      return {
        session: chats.find((c) => c.id === id)!,
        messages: question ? [message(`${id}-q`, 'user', question), message(`${id}-a`, 'assistant', 'It is a demo project.')] : [],
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
        seq: 0,
      };
    },
    'sessions.unsubscribe': () => ({ ok: true }),
    'artifacts.list': () => [],
    'slash.list': () => [],
  });
}

/** The session's own message box with `/btw`, and the Side chat pane it opens, as a Code session wires them. */
function Session({ onSend }: { onSend(text: string): void }) {
  const chats = useSideChats('main');
  const [open, setOpen] = useState(false);
  const attachments = useAttachments();
  const frame: PaneFrameState = { pane: 'side', style: {}, hidden: false, maximized: false, canMaximize: true, others: 0, sheet: false, dispatch: () => {}, close: () => setOpen(false) };
  return (
    <>
      <div data-testid="main">
        <Composer
          variant="reply"
          compact
          attachments={attachments}
          model={fake}
          streaming
          onSubmit={onSend}
          commands={[
            btwCommand((question) => {
              setOpen(true);
              chats.start(question);
            }),
          ]}
        />
      </div>
      {open && <SideChatPane frame={frame} chats={chats} />}
    </>
  );
}

function renderSession() {
  const onSend = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <Session onSend={onSend} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return onSend;
}

const mainBox = () => within(screen.getByTestId('main')).getByRole('textbox', { name: 'Message' });

function type(box: HTMLElement, text: string) {
  fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

beforeEach(() => {
  sideBackend();
  localStorage.clear();
});

describe('/btw', () => {
  it('opens the Side chat pane with a tab for the question, which it sends there, and leaves the session alone', async () => {
    const onSend = renderSession();
    type(mainBox(), '/btw what is this project about?');

    const pane = await screen.findByRole('region', { name: 'Side chat' });
    expect(callsTo('sideChats.start')).toEqual([{ sessionId: 'main', question: 'what is this project about?' }]);
    const tabs = within(pane).getByRole('group', { name: 'Side chats' });
    expect(await within(tabs).findByRole('button', { name: 'what is this project about?' })).toBeTruthy();
    // The question and its answer, in the side chat's own transcript, with its own box.
    expect(await within(pane).findByText('It is a demo project.')).toBeTruthy();
    expect(within(pane).getByRole('textbox', { name: 'Message' })).toBeTruthy();
    // Nothing reached the session: no message sent, its box empty.
    expect(onSend).not.toHaveBeenCalled();
    expect(callsTo('chat.send')).toEqual([]);
    expect(callsTo('chat.queue')).toEqual([]);
    expect((mainBox() as HTMLTextAreaElement).value).toBe('');
  });

  it('offers the command with what it does', async () => {
    renderSession();
    fireEvent.change(mainBox(), { target: { value: '/bt', selectionStart: 3 } });
    expect(await screen.findByText('Ask a side question without interrupting')).toBeTruthy();
  });

  it('opens an empty side chat without a question; + adds a tab; × closes one, and the last closes the pane', async () => {
    renderSession();
    // Picked in the menu, the command waits for a question; Enter again opens an empty side chat.
    type(mainBox(), '/btw');
    await waitFor(() => expect((mainBox() as HTMLTextAreaElement).value).toBe('/btw '));
    fireEvent.keyDown(mainBox(), { key: 'Enter' });
    const pane = await screen.findByRole('region', { name: 'Side chat' });
    expect(callsTo('sideChats.start')).toEqual([{ sessionId: 'main' }]);
    const tabs = within(pane).getByRole('group', { name: 'Side chats' });
    await within(tabs).findByRole('button', { name: 'Side chat' });

    fireEvent.click(within(pane).getByRole('button', { name: 'New side chat' }));
    await waitFor(() => expect(within(tabs).getAllByRole('button', { name: 'Side chat' })).toHaveLength(2));
    // The new one is shown.
    expect(within(tabs).getAllByRole('button', { name: 'Side chat' })[1]!.getAttribute('aria-current')).toBe('true');

    fireEvent.click(within(tabs).getAllByRole('button', { name: 'Close Side chat' })[0]!);
    await waitFor(() => expect(within(tabs).getAllByRole('button', { name: 'Side chat' })).toHaveLength(1));
    const [first, second] = [`side-${made - 1}`, `side-${made}`];
    expect(callsTo('sessions.delete')).toEqual([{ id: first }]);

    fireEvent.click(within(tabs).getByRole('button', { name: 'Close Side chat' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Side chat' })).toBeNull());
    expect(callsTo('sessions.delete')).toEqual([{ id: first }, { id: second }]);
  });

  it('sends a follow-up in the side chat, not in the session', async () => {
    const onSend = renderSession();
    Object.assign(backend.handlers, { 'chat.send': () => ({ userMessageId: 'x' }) });
    type(mainBox(), '/btw which parser?');
    const pane = await screen.findByRole('region', { name: 'Side chat' });
    await within(pane).findByText('It is a demo project.');
    type(within(pane).getByRole('textbox', { name: 'Message' }), 'and why?');
    await waitFor(() => expect(callsTo('chat.send')).toEqual([{ sessionId: `side-${made}`, parts: [{ type: 'text', text: 'and why?' }] }]));
    expect(onSend).not.toHaveBeenCalled();
  });
});

