import { describe, expect, it } from 'vitest';
import type { Message, SessionSummary } from '@atelier/protocol';
import { buildRows, finalCount } from './rows.ts';

const msg = (m: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message => ({ sessionId: 's', parentId: null, model: null, usage: null, stopReason: null, error: null, kind: 'normal', createdAt: 1, ...m }) as Message;
const session = (status: SessionSummary['status']) => ({ status }) as SessionSummary;

describe('the transcript rows', () => {
  it('turns messages into rows, and only what can’t change any more is final', () => {
    const messages = [
      msg({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'fix it' }], createdAt: 1 }),
      msg({ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'On it.' }, { type: 'tool_call', id: 'c1', name: 'Read', input: { file_path: '/p/a.ts' } }], createdAt: 2 }),
    ];
    const running = buildRows({ messages, streamingMessageId: 'a', session: session('running') });
    expect(running.map((r) => r.kind)).toEqual(['user', 'text', 'tool']);
    // The text is final once a later part began; the call waits for its result.
    expect(finalCount(running)).toBe(2);
    const done = buildRows({ messages: [...messages, msg({ id: 't', role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: '1\tx' }] }], createdAt: 3 })], streamingMessageId: 'a', session: session('running') });
    expect(finalCount(done)).toBe(3);
  });

  it('places the terminal’s own output among the messages by time, and shows errors and compaction', () => {
    const rows = buildRows(
      {
        messages: [
          msg({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 10 }),
          msg({ id: 'a', role: 'assistant', parts: [], stopReason: 'error', error: { code: 'x', message: 'It broke', fix: 'Check the key' }, createdAt: 20 }),
          msg({ id: 'c', role: 'assistant', parts: [{ type: 'text', text: 'summary' }], kind: 'compaction_summary', createdAt: 30 }),
        ],
        streamingMessageId: null,
        session: session('idle'),
      },
      [{ key: 'l', lines: ['/cost output'], at: 15 }],
    );
    expect(rows.map((r) => r.kind)).toEqual(['user', 'local', 'error', 'notice']);
    expect(rows[2]).toMatchObject({ text: 'It broke', fix: 'Check the key' });
    expect(finalCount(rows)).toBe(4);
  });

  it('counts a call cut off by a stop as final (no result is coming)', () => {
    const rows = buildRows({ messages: [msg({ id: 'a', role: 'assistant', parts: [{ type: 'tool_call', id: 'c', name: 'Bash', input: { command: 'sleep 9' } }], stopReason: 'aborted' })], streamingMessageId: null, session: session('idle') });
    expect(finalCount(rows)).toBe(1);
  });
});
