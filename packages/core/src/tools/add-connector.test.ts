import { describe, expect, it } from 'vitest';
import type { PermissionAnswer, PermissionRequest } from '@atelier/protocol';
import { createAddConnectorTool, type AddedConnector, type NewConnector } from './add-connector.ts';
import type { ToolContext } from './types.ts';

const ctx: ToolContext = { sessionId: 's1', messageId: 'm1', callId: 'c1', signal: new AbortController().signal, emit: () => {} };
const text = (out: { content: { type: string; text?: string }[] }) => out.content.map((c) => c.text ?? '').join('');

function tool(answer: PermissionAnswer, added: AddedConnector | Error = { where: 'their own connectors', state: 'ready', tools: ['mcp__fusion__sketch'] }) {
  const asked: PermissionRequest[] = [];
  const saved: NewConnector[] = [];
  const t = createAddConnectorTool({
    approve: async (_session, request) => (asked.push(request), answer),
    add: async (_session, connector) => {
      saved.push(connector);
      if (added instanceof Error) throw added;
      return added;
    },
  });
  return { t, asked, saved };
}

describe('AddConnector', () => {
  it('asks the person with the address and an id chosen first, then adds it and names its tools', async () => {
    const { t, asked, saved } = tool({ behavior: 'allow' });
    const out = await t.run({ name: 'fusion', url: 'http://127.0.0.1:27182/mcp', reason: 'Fusion 360 on this computer.' }, ctx);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ callId: 'c1', toolName: 'AddConnector', suggestedRule: '', input: { name: 'fusion', url: 'http://127.0.0.1:27182/mcp', type: 'http', reason: 'Fusion 360 on this computer.' } });
    const id = (asked[0]!.input as { id: string }).id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // What the person agreed to is what gets added, under the same id their desktop allowed.
    expect(saved).toEqual([{ id, name: 'fusion', type: 'http', url: 'http://127.0.0.1:27182/mcp' }]);
    expect(out.isError).toBeUndefined();
    expect(text(out)).toBe('Added fusion to their own connectors. Its tools are offered from your next step: mcp__fusion__sketch.');
  });

  it('adds nothing when the person declines, and passes on what they said', async () => {
    const { t, saved } = tool({ behavior: 'deny', message: 'Use the cloud one.' });
    const out = await t.run({ name: 'fusion', url: 'http://127.0.0.1:27182/mcp' }, ctx);
    expect(saved).toEqual([]);
    expect(out.isError).toBe(true);
    expect(text(out)).toBe('The person declined to add fusion and said: Use the cloud one.');
  });

  it('refuses what is not an http address, credentials in it and odd names, before asking', async () => {
    const { t, asked } = tool({ behavior: 'allow' });
    for (const [input, error] of [
      [{ name: 'x', url: 'ftp://host/mcp' }, 'Give the http or https address of the MCP server.'],
      [{ name: 'x', url: 'not a url' }, 'Give the http or https address of the MCP server.'],
      [{ name: 'x', url: 'https://me:secret@host/mcp' }, "Don't put credentials in the address"],
      [{ name: 'two words', url: 'https://host/mcp' }, 'Use a name of up to 64 letters, digits, - and _.'],
    ] as const) {
      const out = await t.run(input, ctx);
      expect(out.isError).toBe(true);
      expect(text(out)).toContain(error);
    }
    expect(asked).toEqual([]);
  });

  it('takes an address ending in /sse for the older transport', async () => {
    const { t, saved } = tool({ behavior: 'allow' });
    await t.run({ name: 'old', url: 'https://example.com/sse' }, ctx);
    expect(saved[0]).toMatchObject({ type: 'sse' });
  });

  it("says why it can't connect, or couldn't be added", async () => {
    const offline = tool({ behavior: 'allow' }, { where: 'their own connectors', state: 'error', error: "Can't reach 127.0.0.1:27182: nothing answers there (connection refused).", tools: [] });
    const out = await offline.t.run({ name: 'fusion', url: 'http://127.0.0.1:27182/mcp' }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toBe(
      "Added fusion to their own connectors, but it can't connect: Can't reach 127.0.0.1:27182: nothing answers there (connection refused). Tell the person; they find it there.",
    );
    const taken = tool({ behavior: 'allow' }, new Error('You have a connector called fusion already.'));
    expect(text(await taken.t.run({ name: 'fusion', url: 'http://127.0.0.1:27182/mcp' }, ctx))).toBe('Could not add fusion: You have a connector called fusion already.');
  });
});
