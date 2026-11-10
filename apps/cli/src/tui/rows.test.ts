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
    expect(rows.map((r) => r.kind)).toEqual(['user', 'local', 'error', 'turn', 'notice']);
    expect(rows[2]).toMatchObject({ text: 'It broke', fix: 'Check the key' });
    expect(finalCount(rows)).toBe(5);
  });

  it('closes each finished turn with how long it took, from the message to the end of the last reply', () => {
    const turn = (n: number, at: number, reply: Partial<Message>) => [
      msg({ id: `u${n}`, role: 'user', parts: [{ type: 'text', text: `ask ${n}` }], createdAt: at }),
      msg({ id: `a${n}`, role: 'assistant', parts: [{ type: 'tool_call', id: `c${n}`, name: 'Bash', input: { command: 'ls' } }], stopReason: 'tool_use', usage: { durationMs: 2000 } as never, createdAt: at + 1000 }),
      msg({ id: `t${n}`, role: 'tool', parts: [{ type: 'tool_result', callId: `c${n}`, content: [{ type: 'text', text: 'a' }] }], createdAt: at + 9000 }),
      msg({ id: `b${n}`, role: 'assistant', parts: [{ type: 'text', text: 'Done.' }], usage: { durationMs: 20_000 } as never, createdAt: at + 9000, ...reply }),
    ];
    const messages = [...turn(1, 0, { stopReason: 'end' }), ...turn(2, 100_000, { stopReason: 'aborted' })];
    const rows = buildRows({ messages, streamingMessageId: null, session: session('idle') });
    expect(rows.filter((r) => r.kind === 'turn')).toEqual([
      { key: 'b1:turn', kind: 'turn', since: 0, end: 29_000, stopped: false },
      { key: 'b2:turn', kind: 'turn', since: 100_000, end: 129_000, stopped: true },
    ]);
    expect(rows.findIndex((r) => r.key === 'b1:turn')).toBe(rows.findIndex((r) => r.key === 'u2') - 1);
    // While the last turn still runs, only the earlier one has its line.
    const running = buildRows({ messages: messages.slice(0, -1), streamingMessageId: null, session: session('running') });
    expect(running.filter((r) => r.kind === 'turn').map((r) => r.key)).toEqual(['b1:turn']);
  });

  it('counts a call cut off by a stop as final (no result is coming)', () => {
    const rows = buildRows({ messages: [msg({ id: 'a', role: 'assistant', parts: [{ type: 'tool_call', id: 'c', name: 'Bash', input: { command: 'sleep 9' } }], stopReason: 'aborted' })], streamingMessageId: null, session: session('idle') });
    expect(finalCount(rows)).toBe(1);
  });
});

it('words a Read of the folder as listing it', async () => {
  const { toolLine } = await import('./views.tsx');
  const { Paint, palette } = await import('../style.ts');
  const { strip } = await import('../style.ts');
  const ctx = { paint: new Paint(palette('dark', 0)), columns: 100, root: '/repo', view: 'normal' as const };
  const line = toolLine({ type: 'tool_call', id: 'r', name: 'Read', input: { file_path: '.' } }, { type: 'tool_result', callId: 'r', content: [{ type: 'text', text: '. is a directory:\nrack.zip\nnotes/' }] }, ctx);
  expect(strip(line)).toContain('Listed the folder');
  expect(strip(line)).toContain('2 items');
});
