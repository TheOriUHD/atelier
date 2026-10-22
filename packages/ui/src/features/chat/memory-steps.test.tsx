import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { formatChatHits, formatMemoryHits } from '@atelier/protocol';
import { CodeActivity } from '../code/tool-cards.tsx';
import { ToolActivity } from './parts.tsx';
import type { ActivityStepView } from './turns.ts';

type ToolStep = Extract<ActivityStepView, { kind: 'tool' }>;

let n = 0;
function step(name: string, input: unknown, result: string | null, isError = false): ToolStep {
  const id = `c${++n}`;
  return {
    kind: 'tool',
    key: id,
    call: { type: 'tool_call', id, name, input },
    result: result === null ? undefined : { type: 'tool_result', callId: id, content: [{ type: 'text', text: result }], ...(isError ? { isError } : {}) },
    running: result === null,
    since: 0,
    output: undefined,
  };
}

function renderWithRouter(node: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        {node}
      </>
    ),
    validateSearch: (s: Record<string, unknown>) => ({
      ...(typeof s.settings === 'string' ? { settings: s.settings } : {}),
      ...(typeof s.memory === 'string' ? { memory: s.memory } : {}),
    }),
  });
  const routes = ['/', '/chat/$sessionId', '/work/$sessionId', '/code/$sessionId'].map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  const router = createRouter({ routeTree: rootRoute.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/chat/now'] }) });
  render(<RouterProvider router={router} />);
  return { location: () => router.state.location };
}

const hits = formatMemoryHits('2 memories match "dog":', [
  { id: 'm1', section: 'topic', title: 'Beans', summary: 'Ada’s beagle', body: '- Four years old' },
  { id: 'm2', section: 'profile', title: 'Profile', summary: 'Who Ada is' },
]);
const view = formatMemoryHits('1 memory:', [{ id: 'm1', section: 'topic', title: 'Beans', summary: 'Ada’s beagle', body: '- Four years old' }]);

describe('memory steps in a chat', () => {
  it('fold lookups in a row into "Looked at memories", each memory opening its page in Settings', async () => {
    const { location } = renderWithRouter(<ToolActivity steps={[step('MemorySearch', { query: 'dog' }, hits), step('MemoryView', { ids: ['m1'] }, view), step('WebSearch', { query: 'beagle' }, 'results')]} />);
    const line = await screen.findByRole('button', { name: 'Looked at memories' });
    expect(screen.getByRole('button', { name: /Used WebSearch/ })).toBeTruthy();
    expect(screen.queryByText('Beans')).toBeNull();
    fireEvent.click(line);
    expect(screen.getAllByRole('button', { name: /Beans/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Profile/ }));
    await waitFor(() => expect(location().search).toMatchObject({ settings: 'memory', memory: 'm2' }));
  });

  it('say "Saved a memory", "Updated a memory" or "Forgot a memory", linking what was saved', async () => {
    const { location } = renderWithRouter(
      <ToolActivity
        steps={[
          step('MemoryUpdate', { op: 'create', section: 'topic', title: 'Beans' }, 'Saved the memory "Beans" (id: m1).'),
          step('MemoryUpdate', { op: 'update', id: 'm2', section: 'profile' }, 'Updated the memory "Profile" (id: m2).'),
          step('MemoryUpdate', { op: 'delete', id: 'm3' }, 'Forgot the memory "Old job" (id: m3).'),
        ]}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Updated a memory' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot a memory' }));
    expect(screen.getByText('Old job')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Old job/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Saved a memory' }));
    fireEvent.click(screen.getByRole('button', { name: /Beans/ }));
    await waitFor(() => expect(location().search).toMatchObject({ settings: 'memory', memory: 'm1' }));
  });

  it('list past chats a search found as links, and link the chat it read', async () => {
    const found = formatChatHits('2 past chats match "film":', [
      { sessionId: 's1', messageId: 'x1', mode: 'chat', date: '2026-09-12', title: 'Kurzfilm planning', snippet: '…the harbour film…' },
      { sessionId: 's2', messageId: null, mode: 'work', date: '2026-08-01', title: 'Shot list', snippet: 'A list of shots' },
    ]);
    renderWithRouter(
      <ToolActivity steps={[step('ChatSearch', { query: 'film' }, found), step('ChatRead', { session_id: 's1' }, 'Chat "Kurzfilm planning" (session: s1, chat, 2026-09-12): messages 1–2 of 2.\n\n…')]} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Searched past chats' }));
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/chat/s1', '/work/s2']);
    expect(links[0]!.textContent).toContain('2026-09-12');
    expect(links[0]!.textContent).toContain('…the harbour film…');
    fireEvent.click(screen.getByRole('button', { name: 'Read a past chat' }));
    expect(screen.getAllByRole('link').at(-1)!.getAttribute('href')).toBe('/chat/s1');
  });

  it('show a running search and a failed save', async () => {
    renderWithRouter(<ToolActivity steps={[step('ChatSearch', { query: 'x' }, null), step('MemoryUpdate', { op: 'create' }, 'A new memory needs a section.', true)]} />);
    expect(await screen.findByRole('button', { name: 'Searching past chats' })).toBeTruthy();
    const failed = screen.getByRole('button', { name: /Saved a memory/ });
    expect(failed.textContent).toContain('failed');
    fireEvent.click(failed);
    expect(screen.getByText('A new memory needs a section.')).toBeTruthy();
  });
});

describe('memory steps in Cowork', () => {
  it('keep their own line beside the folded tool calls', async () => {
    renderWithRouter(<CodeActivity steps={[step('Read', { file_path: '/w/a.md' }, 'text'), step('MemorySearch', { query: 'dog' }, hits)]} />);
    const line = await screen.findByRole('button', { name: 'Looked at memories' });
    fireEvent.click(line);
    expect(within(line.parentElement!).getByRole('button', { name: /Beans/ })).toBeTruthy();
  });
});
