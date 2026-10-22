import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Notice } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import type { LiveSessionState } from '../../lib/live-session.ts';
import { resetBackend } from '../settings/test-backend.ts';
import { Transcript } from '../chat/transcript.tsx';
import { ActivityList, CodeActivity, MessageNotice, SessionTasks, WorkspaceRoot, type ToolStep } from './tool-cards.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTransport: () => ({ onReconnect: () => () => {} }),
}));

beforeEach(() => resetBackend({ 'models.list': () => [], 'artifacts.list': () => [] }));

const sent = (to: string, message: string, text?: string, isError = false): ToolStep => ({
  kind: 'tool',
  key: `m:${to}`,
  call: { type: 'tool_call', id: `call-${to}`, name: 'SendMessage', input: { to, message } },
  result: text === undefined ? undefined : { type: 'tool_result', callId: `call-${to}`, content: [{ type: 'text', text }], ...(isError ? { isError } : {}) },
  running: text === undefined,
  since: 0,
  output: undefined,
});

describe('a sent message', () => {
  it('reads "Messaged another session" and opens to the target’s title and id, the message and what happened', () => {
    render(
      <WorkspaceRoot.Provider value="/repo">
        <ActivityList steps={[sent('s-42', 'The login fix is in.', 'Sent to the session "Write the notes" (id s-42). It was idle and has started a turn to read it.')]} />
      </WorkspaceRoot.Provider>,
    );
    const summary = screen.getByRole('button', { name: /Messaged another session/ });
    expect(summary.textContent).toContain('Write the notes');
    expect(screen.queryByText('The login fix is in.')).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByText('s-42')).toBeTruthy();
    expect(screen.getAllByText('Write the notes')).toHaveLength(2);
    expect(screen.getByText('The login fix is in.')).toBeTruthy();
    expect(screen.getByText('It was idle and has started a turn to read it.')).toBeTruthy();
  });

  it('reads "Messaged a sub-agent" for a task id, in the folded line and its row, and shows a refusal as it came', () => {
    render(
      <WorkspaceRoot.Provider value="/repo">
        <CodeActivity steps={[sent('agent:c1', 'Skip the docs folder.', 'Sent to the sub-agent "Survey the repo" (task agent:c1). It is working and reads your message before its next step.')]} />
      </WorkspaceRoot.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Messaged a sub-agent/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /Messaged a sub-agent/ }).at(-1)!);
    expect(screen.getByText('agent:c1')).toBeTruthy();
    expect(screen.getByText('Skip the docs folder.')).toBeTruthy();

    render(<ActivityList steps={[sent('nope', 'Hi', 'There is no session or sub-agent "nope" you can message.', true)]} />);
    fireEvent.click(screen.getByRole('button', { name: /Messaged another session/ }));
    expect(screen.getByText('There is no session or sub-agent "nope" you can message.')).toBeTruthy();
  });
});

const message = (parts: Message['parts']): Message => ({
  id: 'n1',
  sessionId: 's',
  parentId: null,
  role: 'user',
  parts,
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'context',
  summarizesThroughId: null,
  createdAt: 0,
});

function live(messages: Message[]): LiveSessionState {
  return {
    session: { id: 's', mode: 'code', workspaceId: null, permissionMode: null, title: 'Code', projectId: null, model: null, effort: null, connectorsOff: [], research: false, status: 'idle', pinnedAt: null, createdAt: 0, updatedAt: 0 },
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

describe('a received message', () => {
  const fromSession: Extract<Notice, { kind: 'message' }> = {
    kind: 'message',
    from: { sessionId: 's-7', title: 'Fix the login', relation: 'session', mode: 'code' },
    text: 'The login fix is in; mention it.',
  };

  it('is one muted row in the transcript that opens to where it came from, with a link, and the message', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <Transcript sessionId="s" live={live([message([{ type: 'context', text: 'A message arrived …', notice: fromSession }])])} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const row = screen.getByRole('button', { name: 'Received a message from another session' });
    const column = row.closest('.mx-auto');
    // A muted line: it sits close to the lines around it instead of a full row's gap away.
    expect(row.closest('[data-first=line][data-last=line]')).toBeTruthy();
    expect(column?.className).toContain('[&>[data-last=line]+[data-first=line]]:mt-1');
    expect(screen.queryByText('The login fix is in; mention it.')).toBeNull();
    // What the model was told stays hidden: the row stands for it.
    expect(screen.queryByText('A message arrived …')).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText('Fix the login')).toBeTruthy();
    expect(screen.getByText('s-7')).toBeTruthy();
    expect(screen.getByText('The login fix is in; mention it.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open session' }).getAttribute('href')).toBe('#/code/s-7');
  });

  it('names its parent session or a sub-agent, whose transcript opens in Background tasks', () => {
    const { unmount } = render(<MessageNotice notice={{ ...fromSession, from: { ...fromSession.from, relation: 'parent', title: 'Main work' } }} />);
    expect(screen.getByRole('button', { name: 'Received a message from its parent session' })).toBeTruthy();
    unmount();

    const open = vi.fn();
    const task = { id: 'agent:c1', kind: 'agent' as const, title: 'Survey the repo', command: null, sessionId: 'c1', background: true, loop: null, startedAt: 0, endedAt: null, status: 'running' as const, exitCode: null };
    render(
      <SessionTasks.Provider value={{ tasks: [task], open }}>
        <MessageNotice notice={{ kind: 'message', from: { sessionId: 'c1', title: 'Survey the repo', relation: 'sub-agent', mode: 'code', taskId: 'agent:c1' }, text: 'Found three modules so far.' }} />
      </SessionTasks.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Received a message from a sub-agent' }));
    expect(screen.getByText('agent:c1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
    expect(open).toHaveBeenCalledWith('agent:c1');
  });
});
