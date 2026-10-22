import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_MODE_OFF, type Message, type SessionSnapshot, type ToolCallPart } from '@atelier/protocol';
import { resetBackend } from '../settings/test-backend.ts';
import type { TranscriptView } from '@atelier/protocol';
import { TranscriptDetail } from '../chat/parts.tsx';
import { ActivityList, CodeActivity, WorkspaceRoot, bashResult, summarize, type ToolStep } from './tool-cards.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTransport: () => ({ onReconnect: () => () => {} }),
}));

beforeEach(() => resetBackend({}));

const step = (name: string, input: unknown, extra: Partial<ToolStep> = {}): ToolStep => ({
  kind: 'tool',
  key: `m:${name}`,
  call: { type: 'tool_call', id: `call-${name}`, name, input },
  result: undefined,
  running: false,
  since: 0,
  output: undefined,
  ...extra,
});

const result = (text: string, isError = false): ToolStep['result'] => ({ type: 'tool_result', callId: 'x', content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

// The cards themselves (CodeActivity folds a run of calls into one line in the Normal view, tested below).
const show = (...steps: ToolStep[]) =>
  render(
    <WorkspaceRoot.Provider value="/repo">
      <ActivityList steps={steps} />
    </WorkspaceRoot.Provider>,
  );

describe('summarize', () => {
  const call = (name: string, input: unknown): Pick<ToolCallPart, 'name' | 'input'> => ({ name, input });

  it('says what reads and searches did and what came back', () => {
    expect(summarize(call('Read', { file_path: '/repo/src/a.ts' }), '     1\tone\n     2\ttwo', '/repo')).toEqual({ verb: 'Read', target: 'src/a.ts', meta: '2 lines' });
    expect(summarize(call('Glob', { pattern: '**/*.ts' }), 'a.ts\nb.ts\n\n[Only the 100 most recently modified matches are shown.]', null)).toEqual({
      verb: 'Searched for',
      target: '**/*.ts',
      meta: '2 files',
    });
    expect(summarize(call('Grep', { pattern: 'greet', path: '/repo/src' }), 'Found 3 files\na\nb\nc', '/repo').meta).toBe('3 files');
    expect(summarize(call('Grep', { pattern: 'greet', path: '/repo/src' }), 'Found 3 files', '/repo').target).toBe('greet in src');
    expect(summarize(call('Grep', { pattern: 'x', output_mode: 'count' }), 'a:2\nb:1\n\n3 matching lines in 2 files.', null).meta).toBe('3 matches in 2 files');
    expect(summarize(call('Grep', { pattern: 'x' }), 'No files found.', null).meta).toBe('no matches');
    expect(summarize(call('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }), null, null).meta).toBe('1 of 2 done');
    expect(summarize(call('mcp__notes__find', { query: 'tea' }), null, null)).toEqual({ verb: 'mcp__notes__find', target: 'tea' });
  });

  it('says how many results a search had and who answered, or that it found none', () => {
    const list = '1. A\n   https://a.com/x\n   one\n\n2. B\n   https://b.org/\n\n(via Brave · 2 results)';
    expect(summarize(call('WebSearch', { query: 'tea' }), list, null)).toEqual({ verb: 'Searched the web for', target: 'tea', meta: '2 results · Brave' });
    expect(summarize(call('WebSearch', { query: 'tea' }), 'No results for “tea”.', null).meta).toBe('no results');
    expect(summarize(call('WebSearch', { query: 'tea' }), null, null)).toEqual({ verb: 'Searched the web for', target: 'tea' });
  });

  it('leaves the count out until there is a result', () => {
    expect(summarize(call('Glob', { pattern: '*.md' }), null, null)).toEqual({ verb: 'Searched for', target: '*.md' });
  });
});

describe('bashResult', () => {
  it('splits the output from the exit status the tool appends', () => {
    expect(bashResult('hi\n\nthere\n\nExit code 0.')).toEqual({ output: 'hi\n\nthere', exitCode: 0, note: null });
    expect(bashResult('(no output)\n\nExit code 2.\nWorking directory is now /tmp.')).toEqual({ output: '', exitCode: 2, note: null });
    expect(bashResult('partial\n\nTimed out after 120s; the command was killed.')).toEqual({ output: 'partial', exitCode: null, note: 'Timed out after 120s; the command was killed.' });
    expect(bashResult('Started in the background with ID abc.\nRead its output with BashOutput and stop it with KillShell.').exitCode).toBeNull();
  });
});

describe('tool cards', () => {
  it('collapses a read into one line that opens to its result', () => {
    show(step('Read', { file_path: '/repo/README.md' }, { result: result('     1\t# Demo') }));
    const summary = screen.getByRole('button', { name: /Read README.md/ });
    expect(summary.textContent).toContain('1 line');
    fireEvent.click(summary);
    expect(document.querySelector('pre')?.textContent).toBe('     1\t# Demo');
  });

  it('streams a command’s output while it runs, then shows the result and exit status', () => {
    const bash = step('Bash', { command: 'npm test', description: 'Run the tests' }, { running: true, output: 'tick-1\n' });
    const { rerender } = show(bash);
    expect(screen.getByRole('button', { name: /Run the tests/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Command' }).textContent).toContain('$ npm test');
    expect(screen.getByLabelText('Output').textContent).toBe('tick-1\n');

    rerender(
      <WorkspaceRoot.Provider value="/repo">
        <ActivityList steps={[{ ...bash, running: false, output: undefined, result: result('tick-1\ntick-2\n\nExit code 1.', true) }]} />
      </WorkspaceRoot.Provider>,
    );
    expect(screen.getByLabelText('Output').textContent).toBe('tick-1\ntick-2');
    expect(screen.getByText('Exit code 1').className).toContain('text-danger-text');
  });

  it('opens a web search to its results: title, site and snippet, no raw list', () => {
    show(step('WebSearch', { query: 'tea' }, { result: result('1. Tea guide\n   https://www.tea.example/guide\n   How to brew it.\n\n(via DuckDuckGo · 1 result)') }));
    fireEvent.click(screen.getByRole('button', { name: /Searched the web for/ }));
    const link = screen.getByRole('link', { name: 'Tea guide' });
    expect(link.getAttribute('href')).toBe('https://www.tea.example/guide');
    expect(screen.getByText('tea.example')).toBeTruthy();
    expect(screen.getByText('How to brew it.')).toBeTruthy();
    expect(screen.getByText(/via DuckDuckGo/)).toBeTruthy();
  });

  it('shows an edit as a diff with its counts', () => {
    show(step('Edit', { file_path: '/repo/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }, { result: result('Edited /repo/a.ts') }));
    expect(screen.getByRole('button', { name: /Edited a.ts/ }).textContent).toContain('2 lines added, 1 line removed');
    expect([...document.querySelectorAll('[data-kind]')].map((r) => r.getAttribute('data-kind'))).toEqual(['context', 'remove', 'add', 'add']);
  });

  it('shows the start of a long write until opened in full', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    show(step('Write', { file_path: '/repo/notes.md', content }, { result: result('Created /repo/notes.md (20 lines).') }));
    expect(screen.getByRole('button', { name: /Created notes.md/ })).toBeTruthy();
    expect(document.querySelectorAll('[data-kind="add"]')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'Show 8 more lines' }));
    expect(document.querySelectorAll('[data-kind="add"]')).toHaveLength(20);
  });

  it('follows a sub-agent: what it is doing now, and its transcript when opened', async () => {
    const msg = (id: string, role: Message['role'], parts: Message['parts']): Message => ({
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
      createdAt: 0,
    });
    const snapshot: SessionSnapshot = {
      session: { id: 'child', mode: 'code', workspaceId: 'w', permissionMode: null, title: 'Find usages', projectId: null, model: null, effort: null, connectorsOff: [], research: false, status: 'running', pinnedAt: null, createdAt: 0, updatedAt: 0 },
      messages: [msg('u', 'user', [{ type: 'text', text: 'Find usages' }]), msg('a', 'assistant', [{ type: 'tool_call', id: 'g1', name: 'Grep', input: { pattern: 'greet' } }])],
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
    };
    resetBackend({ 'sessions.subscribe': () => snapshot, 'artifacts.list': () => [] });
    const agent = step('Agent', { description: 'Find usages', prompt: 'Find every caller of greet', subagent_type: 'general-purpose' }, { running: true });
    show({ ...agent, call: { ...agent.call, childSessionId: 'child' } });
    const header = screen.getByRole('button', { name: /Find usages/ });
    expect(await screen.findByText('Searched for greet')).toBeTruthy();
    fireEvent.click(header);
    expect(screen.getByText('Find every caller of greet')).toBeTruthy();
    // The sub-agent's own transcript is compact too: its run of calls is one line.
    expect(screen.getByRole('button', { name: /^Searched the code/ })).toBeTruthy();
  });

  it.each([
    [null, 1, 'Waiting in line for the model · 1 request ahead'],
    ['retrying', null, 'Connection interrupted. Retry 3 of 10'],
    ['loading', null, 'Loading model…'],
    ['reading', null, 'Reading context…'],
  ] as const)('shows a sub-agent’s live phase %s instead of a stale tool name', async (phase, queued, label) => {
    const snapshot: SessionSnapshot = {
      session: { id: `waiting-${phase}`, mode: 'code', workspaceId: 'w', permissionMode: null, title: 'Check docs', projectId: null, model: null, effort: null, connectorsOff: [], research: false, status: 'idle', pinnedAt: null, createdAt: 0, updatedAt: 0 },
      messages: [],
      siblings: {},
      streamingMessageId: null,
      pending: null,
      todos: [],
      tasks: [],
      toolOutput: {},
      context: null,
      compacting: false,
      queued,
      phase,
      retryAttempt: 3,
      outbox: [],
      seq: 1,
    };
    resetBackend({ 'sessions.subscribe': () => snapshot, 'artifacts.list': () => [] });
    const agent = step('Agent', { description: 'Check docs', prompt: 'Read the docs', subagent_type: 'general-purpose' }, { running: true });
    show({ ...agent, call: { ...agent.call, childSessionId: snapshot.session.id } });
    expect(await screen.findByText(label)).toBeTruthy();
  });
});

describe('compact transcript (Normal view)', () => {
  const compact = (steps: ToolStep[], live = false) =>
    render(
      <WorkspaceRoot.Provider value="/repo">
        <CodeActivity steps={steps} live={live} />
      </WorkspaceRoot.Provider>,
    );

  it('folds a finished run of calls into one line that opens to the cards', () => {
    compact([
      step('Read', { file_path: '/repo/src/app.ts' }, { result: result('     1\tconst a = 1;') }),
      step('Bash', { command: 'npm test', description: 'Run the tests' }, { result: result('fail\n\nExit code 1.') }),
      step('Edit', { file_path: '/repo/src/app.ts', old_string: 'a = 1', new_string: 'a = 2' }, { result: result('Edited src/app.ts.') }),
    ]);
    const line = screen.getByRole('button', { name: /^Read app\.ts, ran a command, edited app\.ts \(1 failed\)/ });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Command' })).toBeNull();
    fireEvent.click(line);
    expect(screen.getByRole('button', { name: /Run the tests/ })).toBeTruthy();
  });

  it('opens to one group with a row per step: a command by its description, opening to its command and output', () => {
    compact([
      step('Read', { file_path: '/repo/src/app.ts' }, { result: result('     1\tconst a = 1;') }),
      step('Bash', { command: 'npm test', description: 'Run the tests' }, { result: result('2 failing\n\nExit code 1.') }),
      step('Edit', { file_path: '/repo/src/app.ts', old_string: 'a = 1', new_string: 'a = 2' }, { result: result('Edited src/app.ts.') }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /^Read app\.ts, ran a command/ }));
    const group = screen.getByRole('group', { name: 'Steps' });
    const rows = within(group).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual(['Read src/app.ts1 line', 'Run the testsExit code 1', 'Edited src/app.ts']);
    expect(rows.every((r) => r.getAttribute('aria-expanded') === 'false')).toBe(true);
    // Closed rows show nothing of their step; a row opens to its own body.
    expect(screen.queryByRole('group', { name: 'Command' })).toBeNull();
    fireEvent.click(rows[1]!);
    const command = screen.getByRole('group', { name: 'Command' });
    expect(command.textContent).toContain('$ npm test');
    expect(command.textContent).toContain('2 failing');
    expect(rows[1]!.getAttribute('aria-expanded')).toBe('true');
    expect(rows[0]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('says what a running run does now, and keeps sub-agents on their own card', () => {
    compact(
      [
        step('Read', { file_path: '/repo/README.md' }, { result: result('     1\t# Demo') }),
        step('Bash', { command: 'ls src', description: 'Peek at the stories module structure' }, { running: true }),
        step('Agent', { description: 'Find usages', prompt: 'Find callers', subagent_type: 'general-purpose' }, { running: true }),
      ],
      true,
    );
    expect(screen.getByRole('status').textContent).toMatch(/^Peek at the stories module structure(\d+[hm] )?\d+[hms]$/);
    expect(screen.getByRole('button', { name: /Find usages/ })).toBeTruthy();
    expect(screen.queryByText(/^Read README/)).toBeNull();
  });
});

describe('plan card', () => {
  it('says a plan presented outside plan mode needed no approval, instead of calling it declined', () => {
    show(step('ExitPlanMode', { plan: '1. Write index.html' }, { result: result(PLAN_MODE_OFF) }));
    expect(screen.getByText('Not in plan mode')).toBeTruthy();
    expect(screen.queryByText('Not approved')).toBeNull();
  });
});

describe('transcript views', () => {
  const read = step('Read', { file_path: '/repo/a.ts' }, { result: result('     1\tconst a = 1;') });
  const thinking: ToolStep = { kind: 'thinking', key: 't', text: 'Checking the file first.', active: false } as unknown as ToolStep;
  const showIn = (view: TranscriptView) =>
    render(
      <TranscriptDetail.Provider value={view}>
        <WorkspaceRoot.Provider value="/repo">
          <CodeActivity steps={[thinking, read]} />
        </WorkspaceRoot.Provider>
      </TranscriptDetail.Provider>,
    );

  it('Normal keeps thinking and one-line calls closed', () => {
    showIn('normal');
    expect(screen.queryByText('Checking the file first.')).toBeNull();
    expect(screen.queryByText(/const a = 1/)).toBeNull();
  });

  it('Thinking opens thinking; Verbose opens every call too', () => {
    const { unmount } = showIn('thinking');
    expect(screen.getByText('Checking the file first.')).toBeTruthy();
    expect(screen.queryByText(/const a = 1/)).toBeNull();
    unmount();
    showIn('verbose');
    expect(screen.getByText('Checking the file first.')).toBeTruthy();
    expect(screen.getByText(/const a = 1/)).toBeTruthy();
  });
});

describe('images the agent looked at', () => {
  const shot = (n: number, running = false) =>
    step(
      'Read',
      { file_path: `/repo/shot-${n}.png` },
      { key: `m:${n}`, running, result: running ? undefined : { type: 'tool_result', callId: `c${n}`, content: [{ type: 'text', text: 'Image' }, { type: 'image', mime: 'image/png', blob: `sha${n}` }] } },
    );

  it('shows thumbnails on the compact line, finished and while it runs', () => {
    const steps = Array.from({ length: 10 }, (_, i) => shot(i + 1));
    const { rerender } = render(
      <WorkspaceRoot.Provider value="/repo">
        <CodeActivity steps={[...steps.slice(0, 4), shot(5, true)]} live />
      </WorkspaceRoot.Provider>,
    );
    expect(within(screen.getByRole('group', { name: 'Images looked at' })).getByText('+1')).toBeTruthy();
    rerender(
      <WorkspaceRoot.Provider value="/repo">
        <CodeActivity steps={steps} />
      </WorkspaceRoot.Provider>,
    );
    expect(screen.getByText('Looked at 10 images')).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Images looked at' });
    expect(within(group).getByText('+7')).toBeTruthy();
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Read image 8 of 10', 'Read image 9 of 10', 'Read image 10 of 10']);
  });

  it('shows a Read card its own image in the Verbose view', () => {
    render(
      <TranscriptDetail.Provider value="verbose">
        <WorkspaceRoot.Provider value="/repo">
          <CodeActivity steps={[shot(1), shot(2)]} />
        </WorkspaceRoot.Provider>
      </TranscriptDetail.Provider>,
    );
    expect(screen.getAllByText('Looked at')).toHaveLength(2);
    expect(screen.getAllByRole('group', { name: 'Images looked at' }).map((g) => within(g).getByRole('button').getAttribute('aria-label'))).toEqual([
      'Read image 1 of 1',
      'Read image 1 of 1',
    ]);
  });
});
