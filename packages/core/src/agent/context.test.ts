import { describe, expect, it } from 'vitest';
import type { Message, Part } from '@atelier/protocol';
import { renderState, summarize, type Summarizer } from './compaction.ts';
import { Calibration, capToolResults, compactThreshold, contextUsage, outputReserve, requestSize, roomBudgets, stubOldResults, tailStart } from './context.ts';

let n = 0;
function msg(role: Message['role'], parts: Part[], extra: Partial<Message> = {}): Message {
  n++;
  return { id: `m${n}`, sessionId: 's', parentId: null, role, parts, model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: n, ...extra };
}
const text = (t: string): Part => ({ type: 'text', text: t });
const call = (id: string): Part => ({ type: 'tool_call', id, name: 'Read', input: { file_path: '/a' } });
const result = (id: string, t: string): Part => ({ type: 'tool_result', callId: id, content: [{ type: 'text', text: t }] });

describe('budget', () => {
  it('keeps room for the reply: the threshold is the lower of autoCompactAt and the window less the reserve', () => {
    expect(outputReserve(200_000, 32_000)).toBe(20_000);
    expect(compactThreshold(200_000, 0.85, 20_000)).toBe(170_000);
    expect(outputReserve(8192, 8192)).toBe(2048);
    expect(compactThreshold(8192, 0.85, 2048)).toBe(6144);
  });

  it('scales the tail, summary and tool-result budgets with the room left', () => {
    expect(roomBudgets(2_000)).toEqual({ resultChars: 600 * 4, tailChars: 700 * 4, summaryTokens: 500 });
    expect(roomBudgets(150_000)).toEqual({ resultChars: 25_000 * 4, tailChars: 20_000 * 4, summaryTokens: 8_000 });
    expect(roomBudgets(-100)).toEqual({ resultChars: 500 * 4, tailChars: 0, summaryTokens: 256 });
  });
});

describe('Calibration', () => {
  it('converges on the characters per token usage reports show, ignoring counts that cannot be right', () => {
    const c = new Calibration();
    expect(c.charsPerToken('m')).toBe(4);
    for (let i = 0; i < 12; i++) expect(c.observe('m', 32_000, 10_000)).toBe(true);
    expect(c.charsPerToken('m')).toBeCloseTo(3.2, 2);
    // A prompt cache hit reported as only the new tokens (Ollama), and a tiny request.
    expect(c.observe('m', 32_000, 300)).toBe(false);
    expect(c.observe('m', 200, 50)).toBe(false);
    expect(c.charsPerToken('m')).toBeCloseTo(3.2, 2);
    expect(c.charsPerToken('other')).toBe(4);
  });
});

describe('contextUsage', () => {
  const system = [{ text: 'S'.repeat(4000) }, { text: `<available_skills>\n${'k'.repeat(781)}` }];
  const tools = [
    { name: 'Read', description: 'd', inputSchema: {} },
    { name: 'mcp__gh__issue', description: 'd', inputSchema: {} },
  ];
  const opts = { model: 'p/m', charsPerToken: 4, limit: 10_000, threshold: 8_000 };

  it('splits the fixed parts by category and estimates the rest', () => {
    const messages = [msg('user', [text('q'.repeat(3988))])];
    const usage = contextUsage(requestSize(system, tools, messages), messages, opts);
    expect(usage.categories).toMatchObject({ systemPrompt: 1000, skills: 200, systemTools: 13, mcpTools: 15, messages: 1000 });
    expect(usage.used).toBe(2228);
  });

  it('is exact up to the newest reply with plausible usage, estimated after it', () => {
    const messages = [
      msg('user', [text('q'.repeat(3988))]),
      msg('assistant', [call('c1')], { model: 'p/m', usage: { input: 2500, output: 40 } }),
      msg('tool', [result('c1', 'r'.repeat(3988))]),
    ];
    expect(contextUsage(requestSize(system, tools, messages), messages, opts).used).toBe(2500 + 40 + 1000);
    // A count far below the prompt's size (a cache hit reported as new tokens only) isn't trusted.
    messages[1] = { ...messages[1]!, usage: { input: 150, output: 40 } };
    expect(contextUsage(requestSize(system, tools, messages), messages, opts).used).toBeGreaterThan(3000);
    // Nor is a reply from before the summary that starts the history.
    const summarized = [msg('user', [text('summary')], { kind: 'compaction_summary', createdAt: 1e9 }), ...messages.slice(1)];
    summarized[1] = { ...summarized[1]!, usage: { input: 2500, output: 40 } };
    expect(contextUsage(requestSize(system, tools, summarized), summarized, opts).used).toBeLessThan(2500);
  });
});

describe('fitting', () => {
  it('cuts the middle of tool results longer than the cap, saying how much', () => {
    const long = 'a'.repeat(5000) + 'z'.repeat(5000);
    const messages = [msg('tool', [result('c1', long)])];
    const [capped] = capToolResults(messages, 2000);
    const sent = (capped!.parts[0] as Extract<Part, { type: 'tool_result' }>).content[0] as { text: string };
    expect(sent.text.length).toBeLessThan(2400);
    expect(sent.text).toMatch(/^a{1200}\n\[… 8,000 characters cut here/);
    expect(sent.text.endsWith('z'.repeat(800))).toBe(true);
    expect((messages[0]!.parts[0] as Extract<Part, { type: 'tool_result' }>).content[0]).toMatchObject({ text: long });
  });

  it('stubs the oldest tool results first and never the newest round', () => {
    const messages = [
      msg('user', [text('go')]),
      msg('assistant', [call('c1')]),
      msg('tool', [result('c1', 'x'.repeat(1000))]),
      msg('assistant', [call('c2')]),
      msg('tool', [result('c2', 'y'.repeat(1000))]),
      msg('assistant', [call('c3')]),
      msg('tool', [result('c3', 'z'.repeat(1000))]),
    ];
    const sent = stubOldResults(messages, 500).map((m) => JSON.stringify(m.parts));
    expect(sent[2]).toContain('left out to fit');
    expect(sent[4]).toContain('y'.repeat(1000));
    const all = stubOldResults(messages, 1e9).map((m) => JSON.stringify(m.parts));
    expect(all[4]).toContain('left out to fit');
    expect(all[6]).toContain('z'.repeat(1000));
  });

  it('starts the verbatim tail at a message a request can begin with, within the budget', () => {
    const messages = [
      msg('user', [text('summary')], { kind: 'compaction_summary' }),
      msg('user', [text('task')]),
      msg('assistant', [call('c1')]),
      msg('tool', [result('c1', 'x'.repeat(2000))]),
      msg('assistant', [call('c2')]),
      msg('tool', [result('c2', 'y'.repeat(500))]),
    ];
    expect(tailStart(messages, 1000)).toBe(4);
    expect(tailStart(messages, 100)).toBe(6);
    expect(tailStart(messages, 1e6)).toBe(1);
    // An unanswered request stays whatever its size.
    const waiting = [...messages, msg('user', [text('q'.repeat(5000))])];
    expect(tailStart(waiting, 100, 1)).toBe(6);
  });
});

describe('summarize', () => {
  function summarizer(contextLength: number, seen: string[]): Summarizer {
    return {
      contextLength,
      charsPerToken: 4,
      complete: async (user) => {
        seen.push(user);
        return user.startsWith('<partial-summaries>') ? 'MERGED' : `PART ${seen.length}`;
      },
    };
  }

  it('summarizes a transcript that fits in one request, with the carried state', async () => {
    const seen: string[] = [];
    const state = renderState({ request: 'Fix the build', todos: [{ content: 'Run tests', status: 'in_progress' }], files: ['/a.ts'], skills: [] });
    expect(await summarize(summarizer(8000, seen), ['User: hi', 'Assistant: hello'], state, 500)).toBe('PART 1');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('<state>\n### The person');
    expect(seen[0]).toContain('- [~] (in progress) Run tests');
  });

  it('splits a transcript longer than the summarizer’s window into parts and merges their summaries', async () => {
    const seen: string[] = [];
    const blocks = Array.from({ length: 12 }, (_, i) => `User: ${String(i).repeat(1500)}`);
    expect(await summarize(summarizer(2000, seen), blocks, 'STATE', 300)).toBe('MERGED');
    const parts = seen.filter((u) => u.startsWith('<transcript part='));
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((u) => u.length < (2000 - 300 - 512) * 4)).toBe(true);
    expect(seen.at(-1)).toMatch(/^<partial-summaries>[\s\S]*<state>\nSTATE/);
    // Half-size chunks on a retry.
    const retry: string[] = [];
    await summarize(summarizer(2000, retry), blocks, '', 300, 0.5);
    expect(retry.filter((u) => u.startsWith('<transcript part=')).length).toBeGreaterThan(parts.length);
  });

  it('refuses a window too small to summarize in', async () => {
    await expect(summarize(summarizer(900, []), ['User: hi'], '', 300)).rejects.toThrow(/too small/);
  });
});
