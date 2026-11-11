import { expect, it } from 'vitest';
import { message } from '../providers/__fixtures__/harness.ts';
import { DEFER_CONNECTORS_OVER, deferConnectors, shouldDeferConnectors } from './deferred-connectors.ts';
import type { DescribedTool, ToolContext } from './types.ts';

const connector: DescribedTool = { name: 'mcp__docs__read', description: 'Read a document. Full usage and safety instructions.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, readOnly: true, run: async () => ({ content: [] }) };
const ctx: ToolContext = { sessionId: 's', messageId: 'm', callId: 'c', signal: new AbortController().signal, emit: () => {} };

it('loads exact connector definitions without running them and rejects unknown names', async () => {
  const deferred = deferConnectors([connector], []);
  const search = deferred.available()[0]!;
  expect(search.name).toBe('ToolSearch');
  expect((await search.run({ names: ['mcp__other__read'] }, ctx)).isError).toBe(true);
  expect(deferred.available()).toEqual([search]);
  await search.run({ names: [connector.name] }, ctx);
  expect(deferred.available()).toEqual([connector, search]);
});

it('restores loaded schemas from the current branch rather than another conversation', () => {
  const history = [message('assistant', [{ type: 'tool_call', id: 'c', name: 'ToolSearch', input: { names: [connector.name] } }]), message('tool', [{ type: 'tool_result', callId: 'c', content: [{ type: 'text', text: 'Loaded' }] }])];
  expect(deferConnectors([connector], history).available()).toContain(connector);
  expect(deferConnectors([connector], history.slice(0, 1)).available()).not.toContain(connector);
  const refused = [...history.slice(0, 1), message('tool', [{ type: 'tool_result', callId: 'c', content: [], isError: true }])];
  expect(deferConnectors([connector], refused).available()).not.toContain(connector);
  expect(deferConnectors([connector], []).available()).not.toContain(connector);
});

it('defers connectors in every model when their definitions are large, and always in ChatGPT Chat', () => {
  const small = [connector];
  const big = Array.from({ length: 40 }, (_, i) => ({ ...connector, name: `mcp__cad__tool${i}`, description: 'x'.repeat(DEFER_CONNECTORS_OVER / 30) }));
  expect(shouldDeferConnectors(small, 'openai')).toBe(false);
  expect(shouldDeferConnectors(small, 'chatgpt-chat')).toBe(true);
  expect(shouldDeferConnectors(big, 'openai')).toBe(true);
  // Built-in tools don't count, however long.
  expect(shouldDeferConnectors([{ ...connector, name: 'Bash', description: 'x'.repeat(DEFER_CONNECTORS_OVER * 2) }], 'openai')).toBe(false);
});
