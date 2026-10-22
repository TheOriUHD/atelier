import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Part } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import type { LiveSessionState } from '../../lib/live-session.ts';
import { resetBackend } from '../settings/test-backend.ts';
import { CodeActivity } from '../code/tool-cards.tsx';
import { Transcript } from './transcript.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTransport: () => ({ onReconnect: () => () => {} }),
}));

beforeEach(() => resetBackend({ 'models.list': () => [], 'artifacts.list': () => [] }));

let n = 0;
const message = (role: 'user' | 'assistant', parts: Part[]): Message => ({
  id: `m${++n}`, sessionId: 's', parentId: null, role, parts, model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: n,
});
const calls = (id: string) => message('assistant', [{ type: 'tool_call', id, name: 'Read', input: { file_path: '/repo/a.ts' } }, { type: 'tool_result', callId: id, content: [{ type: 'text', text: 'ok' }] }]);
const reply = (text: string) => message('assistant', [{ type: 'text', text }]);
const asked = (text: string) => message('user', [{ type: 'text', text }]);

function show(messages: Message[]) {
  const live = {
    session: { id: 's', mode: 'code', workspaceId: null, permissionMode: null, title: 'Code', projectId: null, model: null, effort: null, connectorsOff: [], research: false, status: 'idle', pinnedAt: null, createdAt: 0, updatedAt: 0 },
    messages, siblings: {}, streamingMessageId: null, pending: null, todos: [], tasks: [], toolOutput: {}, context: null, compacting: false, queued: null, phase: null, outbox: [], seq: 1, status: 'ready', error: null, toolInputs: {}, artifacts: {},
  } as LiveSessionState;
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <Transcript sessionId="s" live={live} activity={CodeActivity} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return [...view.container.querySelector('.mx-auto')!.children] as HTMLElement[];
}

describe('the transcript’s rows', () => {
  it('say what they are at both ends: a turn of calls is one line, a reply ends in its actions, a bubble in its own', () => {
    const [bubble, calling, , answer] = show([asked('Look at it'), calls('c1'), asked('And then?'), reply('Done.')]);
    expect(bubble!.dataset.last).toBe('actions');
    expect(calling!.dataset.first).toBe('line');
    expect(calling!.dataset.last).toBe('line');
    expect(answer!.dataset.first).toBeUndefined();
    expect(answer!.dataset.last).toBe('actions');
  });

  it('give a turn of calls alone no row of reply actions', () => {
    const [, calling] = show([asked('Look at it'), calls('c1')]);
    expect(calling!.querySelector('[aria-label="Retry"], button[aria-label="Copy"]')).toBeNull();
    expect(calling!.children).toHaveLength(1);
  });

  it('space lines 4px apart and everything else 16px through the column’s selectors', () => {
    const [column] = [show([asked('x'), calls('c1'), calls('c2')])[0]!.parentElement!];
    expect(column.className).toContain('[&>*+*]:mt-4');
    expect(column.className).toContain('[&>[data-last=line]+[data-first=line]]:mt-1');
  });
});
