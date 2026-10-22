import { describe, expect, it } from 'vitest';
import type { StopReason } from '@atelier/protocol';
import { chatRequest, collect, finishOf, message, textOf, userText } from './__fixtures__/harness.ts';
import {
  INVALID_TOOL_CALL,
  PromptedToolParser,
  createValidatorCache,
  serializeHistory,
  withPromptedTools,
} from './prompted-tools.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent, ToolDef } from './types.ts';

const TOOLS: ToolDef[] = [
  {
    name: 'x',
    description: 'Does x',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { a: { type: 'number' }, url: { type: 'string', format: 'uri' } },
      required: ['a'],
      additionalProperties: false,
    },
  },
  { name: 'noop', description: 'Nothing', inputSchema: { type: 'object' } },
];

const validatorFor = createValidatorCache();
const parser = (): PromptedToolParser => new PromptedToolParser(TOOLS, validatorFor);

function feed(p: PromptedToolParser, deltas: string[], reason: StopReason = 'end'): StreamEvent[] {
  return [...deltas.flatMap((d) => p.push(d)), ...p.end(reason)];
}

const calls = (events: StreamEvent[]): Extract<StreamEvent, { type: 'tool_call_end' }>[] =>
  events.filter((e): e is Extract<StreamEvent, { type: 'tool_call_end' }> => e.type === 'tool_call_end');

describe('PromptedToolParser', () => {
  it('withholds a tool call whose tags are split across deltas and repairs its JSON', () => {
    const events = feed(parser(), [
      'Let me check.\n<to',
      'ol_c',
      'all>{"name":"x","argu',
      'ments":{"a":1,}}</tool',
      '_call>',
    ]);
    expect(textOf(events)).toBe('Let me check.\n');
    expect(JSON.stringify(events)).not.toContain('tool_call>');
    const start = events.find((e) => e.type === 'tool_call_start');
    expect(start).toEqual({ type: 'tool_call_start', id: expect.stringMatching(/^call_/), name: 'x' });
    expect(calls(events)).toEqual([
      { type: 'tool_call_end', id: start?.type === 'tool_call_start' ? start.id : '', input: { a: 1 } },
    ]);
  });

  it('repairs {"name":"x","arguments":{"a":1,}} in a single delta', () => {
    const events = feed(parser(), ['<tool_call>{"name":"x","arguments":{"a":1,}}</tool_call>']);
    expect(calls(events)[0]).toMatchObject({ input: { a: 1 } });
    expect(events.find((e) => e.type === 'tool_call_delta')).toMatchObject({ json: '{"a":1}' });
  });

  it('passes through text with angle brackets that is not a tool call', () => {
    const events = feed(parser(), ['if a <', ' b then <tools', '> and <tool_', 'result> stay']);
    expect(textOf(events)).toBe('if a < b then <tools> and <tool_result> stay');
    expect(calls(events)).toEqual([]);
  });

  it('accepts code fences, string arguments and unterminated calls when the model stopped on its own', () => {
    expect(
      calls(feed(parser(), ['<tool_call>\n```json\n{"name": "x", "arguments": "{\\"a\\": 2}"}\n```\n</tool_call>']))[0],
    ).toMatchObject({
      input: { a: 2 },
    });
    expect(calls(feed(parser(), ['<tool_call>{"name": "noop", "arguments": {}}'], 'stop'))[0]).toMatchObject({
      input: {},
    });
  });

  it('turns cut-off, unknown, malformed and schema-invalid calls into __invalid_tool_call__', () => {
    const cases: [string[], StopReason, RegExp][] = [
      [['<tool_call>{"name": "x", "arguments": {"a": 1'], 'max_tokens', /cut off/],
      [['<tool_call>{"name": "nope", "arguments": {}}</tool_call>'], 'end', /Unknown tool "nope".*x, noop/],
      [['<tool_call>{"arguments": {"a": 1}}</tool_call>'], 'end', /no "name"/],
      [
        ['<tool_call>{"name": "x", "arguments": {"a": "one", "b": 2}}</tool_call>'],
        'end',
        /Invalid arguments for "x": (?=.*\/a must be number)(?=.*additional properties \("b"\))/,
      ],
      [['<tool_call>{"name": "x", "arguments": [1]}</tool_call>'], 'end', /must be a JSON object/],
    ];
    for (const [deltas, reason, error] of cases) {
      const events = feed(parser(), deltas, reason);
      expect(events.find((e) => e.type === 'tool_call_start')).toMatchObject({ name: INVALID_TOOL_CALL });
      const [end] = calls(events);
      expect((end!.input as { error: string }).error).toMatch(error);
      expect((end!.input as { raw: string }).raw).toBe(
        deltas.join('').replace('<tool_call>', '').replace('</tool_call>', '').trim(),
      );
    }
  });

  it('drops a partial call when the stream failed and anything written after a complete call', () => {
    expect(feed(parser(), ['ok <tool_call>{"name": "x"'], 'error')).toEqual([{ type: 'text', delta: 'ok ' }]);
    const events = feed(parser(), [
      '<tool_call>{"name":"noop","arguments":{}}</tool_call>\n<tool_result>fake</tool_result>',
      ' more',
    ]);
    expect(textOf(events)).toBe('');
    expect(calls(events)).toHaveLength(1);
  });
});

describe('serializeHistory', () => {
  it('turns tool calls and results into prompted text and merges consecutive user turns', () => {
    const history = serializeHistory([
      userText('go'),
      message('assistant', [
        { type: 'text', text: 'Calling.' },
        { type: 'tool_call', id: 'c1', name: 'x', input: { a: 1 } },
      ]),
      message('tool', [
        {
          type: 'tool_result',
          callId: 'c1',
          content: [
            { type: 'text', text: 'done' },
            { type: 'image', mime: 'image/png', blob: 'png' },
          ],
          isError: true,
        },
      ]),
      userText('thanks'),
      message('assistant', [
        { type: 'tool_call', id: 'c2', name: INVALID_TOOL_CALL, input: { error: 'bad', raw: '{oops' } },
      ]),
    ]);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history[1]!.parts).toEqual([
      { type: 'text', text: 'Calling.' },
      { type: 'text', text: '<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>' },
    ]);
    expect(history[2]!.parts).toEqual([
      { type: 'text', text: '<tool_result name="x" id="c1" error="true">\ndone\n</tool_result>' },
      { type: 'image', mime: 'image/png', blob: 'png' },
      { type: 'text', text: 'thanks' },
    ]);
    expect(history[3]!.parts).toEqual([{ type: 'text', text: '<tool_call>{oops</tool_call>' }]);
  });
});

describe('withPromptedTools', () => {
  function fakeAdapter(script: StreamEvent[]): { adapter: ProviderAdapter; seen: ChatRequest[] } {
    const seen: ChatRequest[] = [];
    const adapter: ProviderAdapter = {
      type: 'llamacpp',
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
      async *stream(request) {
        seen.push(request);
        yield* script;
      },
      countTokens: async (request) => request.system.map((s) => s.text).join('').length,
    };
    return { adapter, seen };
  }

  it('sends tool specs in the system prompt instead of native tools and reports tool_use', async () => {
    const { adapter, seen } = fakeAdapter([
      { type: 'phase', phase: 'reading' },
      { type: 'thinking', delta: 'hmm' },
      { type: 'text', delta: 'Sure. <tool_call>{"name": "x", ' },
      { type: 'text', delta: '"arguments": {"a": 3}}</tool_call>' },
      { type: 'usage', usage: { input: 10, output: 5 } },
      { type: 'finish', reason: 'end' },
    ]);
    const events = await collect(withPromptedTools(adapter).stream(chatRequest({ tools: TOOLS, toolChoice: 'auto' })));
    expect(seen[0]!.tools).toBeUndefined();
    expect(seen[0]!.toolChoice).toBeUndefined();
    expect(seen[0]!.system).toHaveLength(2);
    const spec = seen[0]!.system[1]!.text;
    expect(spec).toContain('<tool_call>{"name": "tool_name", "arguments": {"param": "value"}}</tool_call>');
    expect(spec).toContain('### x\nDoes x\nArguments JSON Schema: {"$schema"');
    expect(spec).toContain('one tool call per message');

    expect(events.map((e) => e.type)).toEqual([
      'phase',
      'thinking',
      'text',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_end',
      'usage',
      'finish',
    ]);
    expect(textOf(events)).toBe('Sure. ');
    expect(finishOf(events).reason).toBe('tool_use');
  });

  it('only emits tools from the confirmed browser snapshot, never a provisional call', async () => {
    const { adapter } = fakeAdapter([
      { type: 'text', delta: 'Checking. <tool_call>{"name":"x","arguments":{"a":1}}</tool_call>' },
      { type: 'text_snapshot', text: 'Checking. <tool_call>{"name":"x","arguments":{"a":2}}</tool_call>' },
      { type: 'finish', reason: 'end' },
    ]);
    const stream = withPromptedTools({ ...adapter, type: 'chatgpt-chat' }).stream(chatRequest({ tools: TOOLS }))[Symbol.asyncIterator]();
    expect(await stream.next()).toMatchObject({ value: { type: 'text_snapshot', text: 'Checking. ' } });
    expect(await stream.next()).toMatchObject({ value: { type: 'text_snapshot', text: 'Checking. ' } });
    const final: StreamEvent[] = [];
    for (let next = await stream.next(); !next.done; next = await stream.next()) final.push(next.value);
    expect(calls(final)).toEqual([expect.objectContaining({ input: { a: 2 } })]);
    expect(final.find(event => event.type === 'tool_call_start')).toMatchObject({ name: 'x' });
    expect(finishOf(final).reason).toBe('tool_use');
  });

  it.each(['end', 'aborted', 'error'] as const)('does not preserve a retracted browser tool call on %s', async reason => {
    const { adapter } = fakeAdapter([
      { type: 'text', delta: '<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>' },
      ...(reason === 'end' ? [{ type: 'text_snapshot' as const, text: 'No tool needed.' }] : []),
      { type: 'finish', reason },
    ]);
    const events = await collect(withPromptedTools({ ...adapter, type: 'chatgpt-chat' }).stream(chatRequest({ tools: TOOLS })));
    expect(calls(events)).toEqual([]);
    expect(finishOf(events).reason).toBe(reason);
    expect(events.filter(e => e.type === 'text_snapshot').at(-1)).toEqual({ type: 'text_snapshot', text: reason === 'end' ? 'No tool needed.' : '' });
  });

  it('leaves the finish reason alone without calls and delegates countTokens on the prompted request', async () => {
    const { adapter } = fakeAdapter([
      { type: 'text', delta: 'plain' },
      { type: 'finish', reason: 'end' },
    ]);
    const wrapped = withPromptedTools(adapter);
    const events = await collect(wrapped.stream(chatRequest({ tools: TOOLS })));
    expect(finishOf(events).reason).toBe('end');
    const withSpec = await wrapped.countTokens!(chatRequest({ tools: TOOLS }));
    const without = await wrapped.countTokens!(chatRequest());
    expect(withSpec).toBeGreaterThan(without);
  });
});
