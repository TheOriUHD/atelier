/** The `call-mcp-tool` eval's connector: a stdio MCP server whose only answer can't be guessed. */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const STOCK: Record<string, number> = { widget: 7342, gadget: 118 };

serveStdio(() => {
  const server = new McpServer({ name: 'warehouse', version: '1.0.0' });
  server.registerTool(
    'stock_level',
    { description: 'Returns how many units of an item are in the warehouse right now.', inputSchema: z.object({ item: z.string().describe('Item name, e.g. "widget"') }), annotations: { readOnlyHint: true } },
    ({ item }) => {
      const count = STOCK[item.toLowerCase().replace(/s$/, '')];
      return { content: [{ type: 'text', text: count === undefined ? `No item called ${item}.` : `${count} units of ${item} in stock.` }] };
    },
  );
  return server;
});
