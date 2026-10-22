import { describe, expect, it } from 'vitest';
import type { Message } from '@atelier/protocol';
import { groupTurns, stepView, toolResults, turnItems, type ActivityStep, type TurnItem } from './turns.ts';

const m = (id: string, role: Message['role'], extra: Partial<Message> = {}): Message => ({
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

describe('groupTurns', () => {
  it('folds assistant and tool messages into one turn per user message', () => {
    const turns = groupTurns([
      m('u1', 'user'),
      m('a1', 'assistant'),
      m('t1', 'tool'),
      m('a2', 'assistant'),
      m('u2', 'user'),
      m('a3', 'assistant'),
    ]);
    expect(turns.map((t) => (t.kind === 'assistant' ? t.messages.map((x) => x.id).join('+') : t.kind))).toEqual([
      'user',
      'a1+t1+a2',
      'user',
      'a3',
    ]);
  });

  it('keeps compaction summaries as their own divider turn', () => {
    const turns = groupTurns([
      m('u1', 'user'),
      m('a1', 'assistant'),
      m('c', 'user', { kind: 'compaction_summary' }),
      m('u2', 'user'),
    ]);
    expect(turns.map((t) => t.kind)).toEqual(['user', 'assistant', 'compaction', 'user']);
  });
});

describe('toolResults', () => {
  it('indexes results by call id', () => {
    const results = toolResults([
      m('t', 'tool', { parts: [{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'ok' }] }] }),
    ]);
    expect(results.get('c1')?.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

describe('turnItems', () => {
  const call = (id: string, name = 'search') => ({ type: 'tool_call' as const, id, name, input: {} });
  const label = (item: TurnItem) =>
    item.kind === 'activity'
      ? `activity(${item.steps.map((s) => (s.part.type === 'tool_call' ? s.part.id : 'think')).join(',')})`
      : item.kind;

  it('keeps an inline visual between prose and outside collapsed tool activity', () => {
    const items = turnItems([m('a', 'assistant', { parts: [
      { type: 'text', text: 'Explore this.' }, call('read'), call('v', 'inline_visual'), { type: 'text', text: 'Here is what it means.' },
    ] })]);
    expect(items.map(label)).toEqual(['text', 'activity(read)', 'visual', 'text']);
    expect(items[2]).toMatchObject({ kind: 'visual', ref: { key: 'a:2', part: { id: 'v' } } });
  });

  it('folds a run of tool calls and the thinking between them into one activity', () => {
    const items = turnItems([
      m('a1', 'assistant', { parts: [{ type: 'thinking', text: 'plan' }, call('c1'), { type: 'text', text: '\n' }] }),
      m('t1', 'tool', { parts: [{ type: 'tool_result', callId: 'c1', content: [] }] }),
      m('a2', 'assistant', {
        parts: [
          { type: 'thinking', text: 'next' },
          call('c2'),
          { type: 'thinking', text: 'wrap up' },
          { type: 'text', text: 'Done.' },
        ],
      }),
    ]);
    expect(items.map(label)).toEqual(['activity(think,c1,think,c2,think)', 'text']);
  });

  it('keeps thinking on its own when no tool call follows, and artifacts and errors as their own items', () => {
    const error = { code: 'x', message: 'failed' };
    const items = turnItems([
      m('a1', 'assistant', {
        parts: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Here:' }, call('c1', 'artifact'), call('c2')],
        error,
      }),
    ]);
    expect(items.map(label)).toEqual(['thinking', 'text', 'artifact', 'activity(c2)', 'error']);
  });
});

describe('stepView', () => {
  const call = (id: string) => ({ type: 'tool_call' as const, id, name: 'Bash', input: {} });
  const messages = [
    m('a1', 'assistant', { createdAt: 5, parts: [call('c1'), call('c2'), { type: 'thinking', text: 'more' }] }),
    m('t1', 'tool', { parts: [{ type: 'tool_result', callId: 'c1', content: [] }] }),
  ];
  const [activity] = turnItems(messages) as [Extract<TurnItem, { kind: 'activity' }>];
  const [done, open, thinking] = activity.steps as [ActivityStep, ActivityStep, ActivityStep];
  const results = toolResults(messages);
  const run = { busy: true, streamingMessageId: 'a1', toolOutput: { c2: 'tick' } };

  it('marks calls without a result as running while the run is busy, with their live output', () => {
    expect(stepView(done, results, run)).toMatchObject({ kind: 'tool', running: false, since: 5, output: undefined });
    expect(stepView(open, results, run)).toMatchObject({ kind: 'tool', running: true, output: 'tick' });
    expect(stepView(open, results, { ...run, busy: false })).toMatchObject({ running: false });
  });

  it('marks the last part of the streaming message as active thinking', () => {
    expect(stepView(thinking, results, run)).toEqual({ kind: 'thinking', key: 'a1:2', text: 'more', active: true });
    expect(stepView(thinking, results, { ...run, streamingMessageId: null })).toMatchObject({ active: false });
  });
});
