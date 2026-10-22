import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundTask, Message, SessionSnapshot } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { RunningTasksChip, TaskCard, TaskList, TasksPane, agentFacts, formatDuration, loopSchedule } from './tasks-pane.tsx';
import type { PaneFrameState } from './pane-dock.tsx';
import { AgentNotice, CodeActivity, SessionTasks, WorkspaceRoot, activitySummary, backgroundSummary, type ToolStep } from './tool-cards.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTransport: () => ({ onReconnect: () => () => {} }),
}));

const NOW = Date.now();

const task = (extra: Partial<BackgroundTask>): BackgroundTask => ({
  id: 'e1',
  kind: 'command',
  title: 'Start the dev server',
  command: 'npm run dev',
  sessionId: null,
  background: false,
  loop: null,
  startedAt: NOW - 65_000,
  endedAt: null,
  status: 'running',
  exitCode: null,
  ...extra,
});

const agent = task({ id: 'agent:child', kind: 'agent', title: 'Survey the repo', command: null, sessionId: 'child', startedAt: NOW - 3_725_000 });

const loop = task({
  id: 'loop:1',
  kind: 'loop',
  title: 'check the deploy',
  command: null,
  startedAt: NOW - 600_000,
  loop: { intervalMs: 300_000, runs: 3, nextAt: NOW + 252_000, waiting: false },
});

const message = (id: string, role: Message['role'], parts: Message['parts'], extra: Partial<Message> = {}): Message => ({
  id,
  sessionId: 'child',
  parentId: null,
  role,
  parts,
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: NOW - 10_000,
  ...extra,
});

/** The sub-agent's own session: a prompt, two commands and a read done, a third command running. */
const childSnapshot = (status: 'running' | 'idle' = 'running'): SessionSnapshot => ({
  session: { id: 'child', mode: 'code', workspaceId: 'w', permissionMode: null, title: 'Survey the repo', projectId: null, model: 'fake/fake-chat:8b', effort: null, connectorsOff: [], research: false, status, pinnedAt: null, createdAt: 0, updatedAt: 0 },
  messages: [
    message('u', 'user', [{ type: 'text', text: 'Look through the repository and report its layout.' }]),
    message('a1', 'assistant', [
      { type: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'ls', description: 'List files' } },
      { type: 'tool_call', id: 'b2', name: 'Bash', input: { command: 'git log', description: 'Show history' } },
      { type: 'tool_call', id: 'r1', name: 'Read', input: { file_path: '/repo/README.md' } },
    ], { usage: { input: 1200, output: 300 } }),
    message('t1', 'tool', [
      { type: 'tool_result', callId: 'b1', content: [{ type: 'text', text: 'a\n\nExit code 0.' }] },
      { type: 'tool_result', callId: 'b2', content: [{ type: 'text', text: 'b\n\nExit code 0.' }] },
      { type: 'tool_result', callId: 'r1', content: [{ type: 'text', text: '     1\t# Demo' }] },
    ]),
    message('a2', 'assistant', [{ type: 'text', text: 'The repository has a README.' }, { type: 'tool_call', id: 'b3', name: 'Bash', input: { command: 'sleep 30' } }]),
  ],
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
});

const MODELS = [{ ref: 'fake/fake-chat:8b', providerId: 'fake', modelId: 'fake-chat:8b', displayName: 'Fake Chat 8B' }];

function wrap(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() =>
  resetBackend({
    'sessions.subscribe': () => childSnapshot(),
    'sessions.unsubscribe': () => ({ ok: true }),
    'artifacts.list': () => [],
    'models.list': () => MODELS,
    'tasks.stop': () => ({ ok: true }),
    'tasks.clear': () => ({ ok: true }),
    'tasks.output': () => ({ output: 'ready on :3000\n', offset: 15, truncated: false, running: false, exitCode: null }),
  }),
);

describe('formatDuration', () => {
  it('counts seconds, then minutes, then hours', () => {
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(2_436_000)).toBe('40m 36s');
    expect(formatDuration(74_771_000)).toBe('20h 46m 11s');
  });
});

describe('TaskCard', () => {
  it('shows a running command’s kind and time, opens its output and stops it', async () => {
    const onShow = vi.fn();
    render(wrap(<TaskCard sessionId="s1" task={task({})} onShow={onShow} />));
    expect(screen.getByText('Start the dev server')).toBeTruthy();
    expect(screen.getByText('Bash').parentElement!.textContent).toMatch(/^Bash·1m \d+s$/);
    fireEvent.click(screen.getByRole('button', { name: 'View output: Start the dev server' }));
    expect(onShow).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Start the dev server' }));
    await waitFor(() => expect(callsTo('tasks.stop')).toEqual([{ sessionId: 's1', taskId: 'e1' }]));
  });

  it('says how a finished task ended and how long it ran, without Stop', () => {
    render(wrap(<TaskCard sessionId="s1" task={task({ status: 'failed', exitCode: 2, endedAt: NOW - 5_000 })} onShow={() => {}} />));
    expect(screen.getByText('Bash').parentElement!.textContent).toBe('Bash·Exit code 2·1m 0s');
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull();
  });

  it('tells what a running sub-agent does: model, tokens, tool uses, activity', async () => {
    render(wrap(<TaskCard sessionId="s1" task={agent} onShow={() => {}} />));
    expect(screen.getByText('Agent').parentElement!.textContent).toMatch(/^Agent·1h 2m \d+s$/);
    expect(await screen.findByText('Fake Chat 8B · 1.5k tokens · 4 tool uses · Running a command')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View transcript: Survey the repo' })).toBeTruthy();
  });
});

describe('TaskCard for loops and background sub-agents', () => {
  it('shows a loop’s interval, runs and next send, opens it and stops it', async () => {
    const onShow = vi.fn();
    render(wrap(<TaskCard sessionId="s1" task={loop} onShow={onShow} />));
    expect(screen.getByText('check the deploy')).toBeTruthy();
    expect(screen.getByText('Loop').parentElement!.textContent).toMatch(/^Loop·10m \d+s$/);
    expect(screen.getByText(/^Every 5m · 3 runs · next in 4m 1[12]s$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View loop: check the deploy' }));
    expect(onShow).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop check the deploy' }));
    await waitFor(() => expect(callsTo('tasks.stop')).toEqual([{ sessionId: 's1', taskId: 'loop:1' }]));
  });

  it('says when a loop waits for the session, and keeps its runs once it ended', () => {
    expect(loopSchedule({ ...loop, loop: { ...loop.loop!, waiting: true } }, NOW)).toBe('Every 5m · 3 runs · next once the session is idle');
    expect(loopSchedule({ ...loop, status: 'stopped', endedAt: NOW, loop: { ...loop.loop!, nextAt: null } }, NOW)).toBe('Every 5m · 3 runs');
    render(wrap(<TaskCard sessionId="s1" task={{ ...loop, status: 'done', endedAt: NOW, loop: { ...loop.loop!, runs: 500, nextAt: null } }} />));
    expect(screen.getByText('Every 5m · 500 runs')).toBeTruthy();
    // Without a pane to open it in (Cowork), no link.
    expect(screen.queryByRole('button', { name: /View loop/ })).toBeNull();
  });

  it('marks a sub-agent the model left working in the background', () => {
    render(wrap(<TaskCard sessionId="s1" task={{ ...agent, background: true }} onShow={() => {}} />));
    expect(screen.getByText('Agent').parentElement!.textContent).toMatch(/^Agent·Background·1h 2m \d+s$/);
  });
});

describe('agentFacts', () => {
  it('waits for approval when the sub-agent does', () => {
    const snapshot = childSnapshot();
    const state = { ...snapshot, status: 'ready' as const, error: null, toolInputs: {}, artifacts: {}, session: { ...snapshot.session, status: 'waiting' as const } };
    expect(agentFacts(state)).toMatchObject({ toolUses: 4, tokens: 1500, activity: 'Waiting for your approval', model: 'fake/fake-chat:8b' });
  });
});

describe('TaskList', () => {
  it('lists running tasks under Running and folds finished ones away', () => {
    const tasks = [task({ id: 'old', title: 'Old build', status: 'done', endedAt: NOW - 1000 }), task({}), agent];
    render(wrap(<TaskList sessionId="s1" tasks={tasks} onShow={() => {}} />));
    const running = screen.getByRole('region', { name: 'Running' });
    expect(within(running).getAllByRole('listitem')).toHaveLength(2);
    const finished = screen.getByRole('button', { name: 'Finished 1' });
    expect(screen.queryByText('Old build')).toBeNull();
    fireEvent.click(finished);
    expect(finished.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Old build')).toBeTruthy();
  });

  it('says what shows here before anything runs', () => {
    render(wrap(<TaskList sessionId="s1" tasks={[]} onShow={() => {}} />));
    expect(screen.getByText(/Commands started in the background, sub-agents and loops show here/)).toBeTruthy();
  });
});

describe('TasksPane', () => {
  const frame: PaneFrameState = { pane: 'tasks', style: {}, hidden: false, maximized: false, canMaximize: true, others: 1, sheet: false, dispatch: () => {}, close: () => {} };

  it('clears finished tasks with its trash button', async () => {
    render(wrap(<TasksPane frame={frame} sessionId="s1" tasks={[task({ status: 'done', endedAt: NOW })]} shown={null} onShow={() => {}} />));
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished tasks' }));
    await waitFor(() => expect(callsTo('tasks.clear')).toEqual([{ sessionId: 's1' }]));
    expect(screen.queryByRole('button', { name: 'Background tasks options' })).toBeNull();
  });

  it('shows a sub-agent’s transcript in place of the list, and goes back', async () => {
    const onShow = vi.fn();
    render(wrap(<WorkspaceRoot.Provider value="/repo"><TasksPane frame={frame} sessionId="s1" tasks={[agent]} shown={agent.id} onShow={onShow} /></WorkspaceRoot.Provider>));
    expect(screen.getByRole('heading', { name: 'Survey the repo' })).toBeTruthy();
    expect(await screen.findByText('Fake Chat 8B')).toBeTruthy();
    expect(screen.getByText('Look through the repository and report its layout.')).toBeTruthy();
    const steps = screen.getByRole('region', { name: 'Steps' });
    expect(within(steps).getByRole('button', { name: /^Ran 2 commands, read README\.md/ })).toBeTruthy();
    expect(within(steps).getByText('The repository has a README.')).toBeTruthy();
    expect(within(steps).getByRole('button', { name: /^Ran a command/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to background tasks' }));
    expect(onShow).toHaveBeenCalledWith(null);
  });

  it('shows a loop’s prompt and schedule in place of the list, with Stop', async () => {
    render(wrap(<TasksPane frame={frame} sessionId="s1" tasks={[loop]} shown={loop.id} onShow={() => {}} />));
    expect(screen.getByRole('heading', { name: 'check the deploy' })).toBeTruthy();
    expect(screen.getByText('Sends this as your message:')).toBeTruthy();
    expect(screen.getByText(/The loop ends after 500 runs or on /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop loop' }));
    await waitFor(() => expect(callsTo('tasks.stop')).toEqual([{ sessionId: 's1', taskId: 'loop:1' }]));
  });

  it('shows a command’s output in place of the list', async () => {
    render(wrap(<TasksPane frame={frame} sessionId="s1" tasks={[task({ status: 'done', endedAt: NOW })]} shown="e1" onShow={() => {}} />));
    expect(await screen.findByLabelText('Output')).toBeTruthy();
    expect(screen.getByLabelText('Output').textContent).toBe('ready on :3000\n');
    expect(callsTo('tasks.output')).toEqual([{ sessionId: 's1', taskId: 'e1', since: 0 }]);
  });
});

describe('in the transcript', () => {
  it('a chip says how many tasks run and opens the pane', () => {
    const onOpen = vi.fn();
    render(<RunningTasksChip count={2} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: '2 running tasks' }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('background commands in a row share one card', () => {
    const bg = (id: string, n: number): ToolStep => ({
      kind: 'tool',
      key: id,
      call: { type: 'tool_call', id, name: 'Bash', input: { command: `serve ${n}`, description: `Serve ${n}`, run_in_background: true } },
      result: { type: 'tool_result', callId: id, content: [{ type: 'text', text: `Started in the background with ID exec-${n}.\nRead its output with BashOutput and stop it with KillShell.` }] },
      running: false,
      since: 0,
      output: undefined,
    });
    const open = vi.fn();
    const tasks = [task({ id: 'exec-1', status: 'done', endedAt: NOW }), task({ id: 'exec-2' })];
    render(
      <SessionTasks.Provider value={{ tasks, open }}>
        <CodeActivity steps={[bg('c1', 1), bg('c2', 2)]} />
      </SessionTasks.Provider>,
    );
    const card = screen.getByRole('button', { name: '1 background command completed, 1 running' });
    fireEvent.click(card);
    expect(screen.getByText('Serve 1').parentElement!.textContent).toBe('Serve 1DoneView output');
    fireEvent.click(screen.getAllByRole('button', { name: 'View output' })[1]!);
    expect(open).toHaveBeenCalledWith('exec-2');
  });

  it('a sub-agent started in the background says so, follows its task and opens in the pane', async () => {
    const step = (result: string): ToolStep => ({
      kind: 'tool',
      key: 'a1',
      call: { type: 'tool_call', id: 'a1', name: 'Agent', input: { description: 'Survey the repo', prompt: 'Look around.', subagent_type: 'general-purpose', run_in_background: true }, childSessionId: 'child' },
      result: { type: 'tool_result', callId: 'a1', content: [{ type: 'text', text: result }] },
      running: false,
      since: 0,
      output: undefined,
    });
    const open = vi.fn();
    const started = step('The sub-agent "Survey the repo" is now working in the background (task agent:child).');
    const { rerender } = render(
      wrap(
        <SessionTasks.Provider value={{ tasks: [{ ...agent, background: true }], open }}>
          <CodeActivity steps={[started]} />
        </SessionTasks.Provider>,
      ),
    );
    expect(screen.getByText('Background')).toBeTruthy();
    // Its call came back at once, but it still works: what it does now, not "Done".
    expect(await screen.findByText('Ran sleep 30')).toBeTruthy();
    // The header keeps its room for the status; the transcript link is inside the opened card.
    expect(screen.queryByRole('button', { name: 'View transcript: Survey the repo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Survey the repo/, expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: 'View transcript: Survey the repo' }));
    expect(open).toHaveBeenCalledWith('agent:child');
    rerender(
      wrap(
        <SessionTasks.Provider value={{ tasks: [{ ...agent, background: true, status: 'done', endedAt: NOW }], open }}>
          <CodeActivity steps={[started]} />
        </SessionTasks.Provider>,
      ),
    );
    expect(await screen.findByText('Done · 4 tool uses')).toBeTruthy();
  });

  it('a background sub-agent’s end is one row where the model heard it', () => {
    const open = vi.fn();
    render(
      <SessionTasks.Provider value={{ tasks: [{ ...agent, background: true, status: 'done', endedAt: NOW }], open }}>
        <AgentNotice notice={{ kind: 'agent', taskId: 'agent:child', title: 'Survey the repo', status: 'done', sessionId: 'child' }} />
      </SessionTasks.Provider>,
    );
    expect(screen.getByText(/^Background agent finished ·/).textContent).toBe('Background agent finished · Survey the repo');
    fireEvent.click(screen.getByRole('button', { name: 'View transcript: Survey the repo' }));
    expect(open).toHaveBeenCalledWith('agent:child');
  });

  it('sums up activity and background commands in words', () => {
    expect(backgroundSummary(0, 1)).toBe('1 background command running');
    expect(backgroundSummary(3, 0)).toBe('3 background commands completed');
    const calls = [
      { name: 'Write', input: { file_path: '/repo/a.ts' } },
      { name: 'Bash', input: {} },
      { name: 'Write', input: { file_path: '/repo/b.ts' } },
      { name: 'Bash', input: {} },
      { name: 'Grep', input: {} },
      { name: 'Read', input: { file_path: '/repo/src/app.ts' } },
    ];
    expect(activitySummary(calls, '/repo')).toBe('Created 2 files, ran 2 commands, searched the code, read app.ts');
  });
});
