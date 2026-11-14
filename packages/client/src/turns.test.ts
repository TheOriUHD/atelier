import { describe, expect, it } from 'vitest';
import type { Message } from '@atelier/protocol';
import { groupTurns, turnItems } from './turns.ts';

const message = (id: string, role: Message['role'], parts: Message['parts']): Message => ({
  id,
  sessionId: 's',
  parentId: null,
  role,
  parts,
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: role === 'user' && parts.every((p) => p.type === 'context') ? 'context' : 'normal',
  summarizesThroughId: null,
  createdAt: 0,
});
const call = (id: string, name: string) => ({ type: 'tool_call' as const, id, name, input: {} });
const fromSubAgent = (id: string) =>
  message(id, 'user', [{ type: 'context', text: 'A message from your sub-agent…', notice: { kind: 'message', from: { sessionId: 'c', title: 'Explore', relation: 'sub-agent', mode: 'code', taskId: 'agent:c' }, text: 'Found it' } }]);

describe('messages between agents in the transcript', () => {
  it('carry on the assistant’s turn as steps of its work, instead of splitting it', () => {
    const messages = [
      message('u', 'user', [{ type: 'text', text: 'Build it' }]),
      message('a1', 'assistant', [call('c1', 'SendMessage')]),
      message('t1', 'tool', [{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'sent' }] }]),
      fromSubAgent('n1'),
      message('a2', 'assistant', [call('c2', 'Write')]),
      fromSubAgent('n2'),
      message('a3', 'assistant', [{ type: 'text', text: 'Done.' }]),
    ];
    const turns = groupTurns(messages);
    expect(turns.map((t) => t.kind)).toEqual(['user', 'assistant']);
    const items = turnItems(turns[1]!.kind === 'assistant' ? turns[1]!.messages : []);
    // One group of work: the message sent, the two received and the file written; then the reply.
    expect(items.map((i) => i.kind)).toEqual(['activity', 'text']);
    const steps = items[0]!.kind === 'activity' ? items[0]!.steps : [];
    expect(steps.map((s) => s.part.type)).toEqual(['tool_call', 'context', 'tool_call', 'context']);
  });

  it('leaves a person’s own message as a turn of its own', () => {
    const turns = groupTurns([message('a', 'assistant', [{ type: 'text', text: 'Hi' }]), message('u', 'user', [{ type: 'text', text: 'Thanks' }])]);
    expect(turns.map((t) => t.kind)).toEqual(['assistant', 'user']);
  });
});
