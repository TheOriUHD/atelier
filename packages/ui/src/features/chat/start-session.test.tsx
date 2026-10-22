import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type WorkspaceSummary } from '@atelier/protocol';
import { backend, callsTo, resetBackend } from '../settings/test-backend.ts';
import { TrustWorkspaceHost } from '../workspaces/trust.tsx';
import { useStartSession } from './start-session.ts';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const attachments = { parts: () => [], clear: vi.fn() } as unknown as Parameters<typeof useStartSession>[0];

const folder = (id: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  kind: 'codespace',
  name: 'site',
  root: '/workspaces/site',
  host: 'site-abc',
  deviceId: null,
  available: true,
  scratch: false,
  lastUsedAt: 1,
  ...extra,
});

beforeEach(() => {
  navigate.mockReset();
  resetBackend({
    'sessions.create': () => ({ id: 's1' }),
    'chat.send': () => ({ ok: true }),
    'sessions.delete': () => ({ ok: true }),
    'workspaces.list': () => [folder('w1', { trusted: true })],
    'workspaces.trust': ({ id }: { id: string }) => folder(id, { trusted: true }),
  });
});

describe('useStartSession', () => {
  it('creates the session, sends the message and opens it in its mode', async () => {
    const { result } = renderHook(() => useStartSession(attachments));
    await act(() => result.current.start({ mode: 'work', workspaceId: 'w1' }, 'Write the report'));
    expect(callsTo('chat.send')).toEqual([{ sessionId: 's1', parts: [{ type: 'text', text: 'Write the report' }] }]);
    expect(navigate).toHaveBeenCalledWith({ to: '/work/$sessionId', params: { sessionId: 's1' } });
    expect(callsTo('sessions.delete')).toEqual([]);
  });

  it('asks Trust this workspace? before a session starts in a folder the backend does not trust, and starts none without a yes', async () => {
    backend.handlers['workspaces.list'] = () => [folder('w1', { trusted: false })];
    render(<TrustWorkspaceHost />);
    const { result } = renderHook(() => useStartSession(attachments));
    let started!: Promise<void>;
    act(() => {
      started = result.current.start({ mode: 'code', workspaceId: 'w1' }, 'Run the tests');
    });
    const dialog = await screen.findByRole('dialog', { name: 'Trust this workspace?' });
    expect(dialog.textContent).toContain('/workspaces/site');
    expect(dialog.textContent).toContain('on GitHub codespace site-abc');
    expect(callsTo('sessions.create')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(() => started);
    expect(callsTo('workspaces.trust')).toEqual([]);
    expect(callsTo('sessions.create')).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.sending).toBe(false);

    // Agreeing tells the backend first, then the session starts.
    act(() => {
      started = result.current.start({ mode: 'code', workspaceId: 'w1' }, 'Run the tests');
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Trust workspace' }));
    await act(() => started);
    expect(callsTo('workspaces.trust')).toEqual([{ id: 'w1' }]);
    expect(backend.calls.findIndex((c) => c.method === 'workspaces.trust')).toBeLessThan(backend.calls.findIndex((c) => c.method === 'sessions.create'));
    expect(callsTo('chat.send')).toHaveLength(1);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/code/$sessionId', params: { sessionId: 's1' } }));
  });

  it('does not ask about a folder that is trusted', async () => {
    render(<TrustWorkspaceHost />);
    const { result } = renderHook(() => useStartSession(attachments));
    await act(() => result.current.start({ mode: 'code', workspaceId: 'w1' }, 'Run the tests'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo('workspaces.trust')).toEqual([]);
    expect(callsTo('sessions.create')).toHaveLength(1);
  });

  it('deletes the new session again when the message can’t be sent', async () => {
    backend.handlers['chat.send'] = () => {
      throw appError('no_model', 'Add a model provider to start chatting.');
    };
    const { result } = renderHook(() => useStartSession(attachments));
    await act(() => result.current.start({ mode: 'chat' }, 'hello'));
    expect(callsTo('sessions.delete')).toEqual([{ id: 's1' }]);
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.sending).toBe(false);
  });
});
