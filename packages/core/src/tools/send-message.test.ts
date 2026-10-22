import { describe, expect, it, vi } from 'vitest';
import { createListSessionsTool, createSendMessageTool } from './send-message.ts';
import type { ToolContext, ToolOutput } from './types.ts';

const ctx = { sessionId: 's1' } as ToolContext;
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
const descriptionOf = (tool: { description: unknown }, has: string[] = []) =>
  (tool.description as (c: object) => string)({ tier: 'full', mode: 'code', has: (n: string) => has.includes(n) });

describe('SendMessage', () => {
  it('asks for permission like other tools that change something, and passes the message on trimmed', async () => {
    const send = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Sent.' }] }));
    const tool = createSendMessageTool(send);
    expect(tool.readOnly).toBe(false);
    expect(text(await tool.run({ to: ' s2 ', message: ' Hello ' }, ctx))).toBe('Sent.');
    expect(send).toHaveBeenCalledWith('s1', 's2', 'Hello');
    const empty = await tool.run({ to: 's2', message: '  ' }, ctx);
    expect(empty).toEqual({ content: [{ type: 'text', text: 'The message is empty.' }], isError: true });
  });

  it('names ListSessions and sub-agents only where the session has them; the sub-agents’ version writes to the parent', () => {
    const tool = createSendMessageTool(async () => ({ content: [] }));
    expect(descriptionOf(tool)).not.toMatch(/ListSessions|sub-agent|Agent tool/);
    expect(descriptionOf(tool, ['ListSessions', 'Agent'])).toMatch(/ListSessions finds.*task id as the Agent tool returned it/s);
    expect(descriptionOf(createSendMessageTool(async () => ({ content: [] }), true))).toContain('Set `to` to "parent"');
  });
});

describe('ListSessions', () => {
  it('is read-only and lists sessions with their mode, status, folder and update time', async () => {
    const list = vi.fn(async () => [{ id: 'a', title: '', mode: 'work' as const, status: 'running' as const, folder: 'notes', updatedAt: Date.UTC(2026, 9, 17, 9, 5) }]);
    const tool = createListSessionsTool(list);
    expect(tool.readOnly).toBe(true);
    expect(text(await tool.run({ query: ' report ' }, ctx))).toBe("The person's other sessions, most recent first:\n- a · \"Untitled\" · Cowork · running · folder notes · updated 2026-10-17 09:05 UTC");
    expect(list).toHaveBeenCalledWith('s1', 'report');
    const none = createListSessionsTool(async () => []);
    expect(text(await none.run({}, ctx))).toBe('The person has no other Code sessions or Cowork tasks.');
    expect(text(await none.run({ query: 'x' }, ctx))).toBe('No other session of the person\'s matches "x".');
  });
});
