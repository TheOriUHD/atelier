/**
 * Connectors a co-op guest lends to their own turns (ARCHITECTURE §24), as tools of the host's run. The guest's computer
 * runs each call with their own connector, and only one they allowed in the session (gateway.ts): the host's run asks
 * them every time (chat-service.ts decideAccess), and their computer checks it was asked.
 */
import { lentToolName, PeerContract, type RpcClient } from '@atelier/protocol';
import type { Tool, ToolOutput } from '../tools/types.ts';

/** A guest's lent tools, named for the host's session; none while they don't lend or aren't connected. */
export async function lentTools(peer: RpcClient<typeof PeerContract>, keyId: string, putBlob: (bytes: Uint8Array, mime: string) => Promise<string>): Promise<Tool[]> {
  const listed = await peer.call('mcp.list', {}).catch(() => []);
  return listed.map((t) => ({
    name: lentToolName(keyId, t.name),
    description: `${t.description}\n\nThis is one of a guest's own connectors, lent to their turns: they approve each call.`,
    inputSchema: t.inputSchema,
    // It asks its owner every time, whatever it does.
    readOnly: false,
    async run(input: unknown, ctx): Promise<ToolOutput> {
      const result = await peer.call('mcp.call', { name: t.name, input }, { signal: ctx.signal });
      const content: ToolOutput['content'] = [];
      for (const item of result.content as Record<string, unknown>[]) {
        if (item?.type === 'text' && typeof item.text === 'string') content.push({ type: 'text', text: item.text });
        else if (item?.type === 'image_data' && typeof item.dataBase64 === 'string' && typeof item.mime === 'string' && /^image\//.test(item.mime)) {
          const blob = await putBlob(new Uint8Array(Buffer.from(item.dataBase64, 'base64')), item.mime);
          content.push({ type: 'image', blob, mime: item.mime } as ToolOutput['content'][number]);
        }
      }
      return { content: content.length ? content : [{ type: 'text', text: '(no output)' }], ...(result.isError ? { isError: true } : {}) };
    },
  }));
}
