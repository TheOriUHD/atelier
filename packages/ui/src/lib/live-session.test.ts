import { describe, expect, it } from 'vitest';
import type { Message } from '@atelier/protocol';
import { applyEvent, type LiveSessionState } from './live-session.ts';

const msg = (id: string, parentId: string | null, role: Message['role'], text = ''): Message => ({
  id,
  sessionId: 's',
  parentId,
  role,
  parts: text ? [{ type: 'text', text }] : [],
  model: null,
  usage: null,
  stopReason: role === 'assistant' ? null : null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: 0,
});

const base: LiveSessionState = {
  status: 'ready',
  error: null,
  session: null,
  messages: [msg('u1', null, 'user', 'hi'), { ...msg('a1', 'u1', 'assistant', 'hello'), stopReason: 'end' }],
  siblings: {},
  streamingMessageId: null,
  toolInputs: {},
  context: null,
  compacting: false,
  queued: null,
  phase: null,
  outbox: [],
  artifacts: {},
  pending: null,
  todos: [],
  tasks: [],
  toolOutput: {},
  seq: 3,
};

describe('applyEvent', () => {
  it('streams text into a new assistant message', () => {
    let s = applyEvent(base, { type: 'message', message: msg('u2', 'a1', 'user', 'more') });
    s = applyEvent(s, { type: 'message', message: msg('a2', 'u2', 'assistant') });
    expect(s.streamingMessageId).toBe('a2');
    s = applyEvent(s, { type: 'part', messageId: 'a2', index: 0, part: { type: 'text', text: '' } });
    s = applyEvent(s, { type: 'delta', messageId: 'a2', index: 0, kind: 'text', text: 'Hel' });
    s = applyEvent(s, { type: 'delta', messageId: 'a2', index: 0, kind: 'text', text: 'lo' });
    s = applyEvent(s, { type: 'done', messageId: 'a2', usage: null, stopReason: 'end', error: null });
    expect(s.messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(s.streamingMessageId).toBeNull();
  });

  it('truncates the branch and records siblings on retry', () => {
    const s = applyEvent(base, { type: 'message', message: msg('a1b', 'u1', 'assistant') });
    expect(s.messages.map((m) => m.id)).toEqual(['u1', 'a1b']);
    expect(s.siblings['a1b']).toEqual(['a1', 'a1b']);
    expect(s.siblings['a1']).toEqual(['a1', 'a1b']);
  });

  it('clears only the restarted message’s partial tool input when a request reconnects', () => {
    const state = { ...base, toolInputs: { 'a1:0': '{"old":', 'other:0': 'keep' } };
    const next = applyEvent(state, { type: 'message', message: msg('a1', 'u1', 'assistant') });
    expect(next.toolInputs).toEqual({ 'other:0': 'keep' });
    expect(next.messages.at(-1)?.parts).toEqual([]);
    expect(applyEvent(next, { type: 'phase', phase: 'retrying' }).phase).toBe('retrying');
  });

  it('accumulates streaming tool input separately from parts', () => {
    let s = applyEvent(base, { type: 'delta', messageId: 'a1', index: 1, kind: 'tool_input', text: '{"a":' });
    s = applyEvent(s, { type: 'delta', messageId: 'a1', index: 1, kind: 'tool_input', text: '1}' });
    expect(s.toolInputs['a1:1']).toBe('{"a":1}');
  });

  it("knows what the model's server does before the reply, until the reply's output arrives", () => {
    let s = applyEvent(base, { type: 'message', message: msg('u2', 'a1', 'user', 'more') });
    s = applyEvent(s, { type: 'message', message: msg('a2', 'u2', 'assistant') });
    s = applyEvent(s, { type: 'phase', phase: 'loading' });
    expect(s.phase).toBe('loading');
    s = applyEvent(s, { type: 'phase', phase: 'reading' });
    expect(s.phase).toBe('reading');
    expect(applyEvent(s, { type: 'phase', phase: null }).phase).toBeNull();
    // Should the clearing event go missing, the reply's first part or delta ends it.
    expect(applyEvent(s, { type: 'part', messageId: 'a2', index: 0, part: { type: 'text', text: '' } }).phase).toBeNull();
    expect(applyEvent(s, { type: 'delta', messageId: 'a2', index: 0, kind: 'thinking', text: 'Hm' }).phase).toBeNull();
    expect(applyEvent(s, { type: 'status', status: 'idle' }).phase).toBeNull();
    // Another message's events leave it alone.
    expect(applyEvent(s, { type: 'part', messageId: 'a1', index: 1, part: { type: 'text', text: '' } }).phase).toBe('reading');
  });

  it('knows while the run waits for its model’s server, and how many are ahead', () => {
    const waiting = applyEvent(base, { type: 'queued', ahead: 2 });
    expect(waiting.queued).toBe(2);
    expect(applyEvent(waiting, { type: 'queued', ahead: null }).queued).toBeNull();
  });

  it('tracks the task list, the open question and live tool output', () => {
    let s = applyEvent(base, { type: 'todos', todos: [{ content: 'Run tests', status: 'in_progress' }] });
    s = applyEvent(s, { type: 'pending', pending: { kind: 'question', id: 'q', payload: {} } });
    s = applyEvent(s, { type: 'tool_output', messageId: 'a1', callId: 'c1', text: 'one\n' });
    s = applyEvent(s, { type: 'tool_output', messageId: 'a1', callId: 'c1', text: 'two\n' });
    expect(s).toMatchObject({ todos: [{ content: 'Run tests' }], pending: { id: 'q' }, toolOutput: { c1: 'one\ntwo\n' } });
    s = applyEvent(s, { type: 'message', message: msg('t1', 'a1', 'tool', '') });
    expect(s.toolOutput).toEqual({});
  });
});

