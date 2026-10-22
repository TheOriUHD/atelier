/**
 * The mock server over Streamable HTTP on a free port, run by Node directly (the web E2E starts it). It answers
 * only with `Authorization: Bearer $MOCK_TOKEN`, or, with MOCK_OAUTH set, behind its own OAuth authorization server
 * (`oauth-server.ts`). It prints its URL as the first line on stdout.
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { mockServer } from './mock-server.ts';
import { oauthMock } from './oauth-server.ts';

const state = { added: false, log: () => {} };
const handler = createMcpHandler(() => mockServer(state));
const oauth = process.env.MOCK_OAUTH ? oauthMock(state) : null;
const handle = (request: Request) =>
  oauth ? oauth.handle(request) : request.headers.get('authorization') === `Bearer ${process.env.MOCK_TOKEN}` ? handler.fetch(request) : Promise.resolve(new Response('Unauthorized', { status: 401 }));

const server = createServer(async (req, res) => {
  const gone = new AbortController();
  res.on('close', () => gone.abort());
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)] as [string, string]]));
  const response = await handle(new Request(`http://localhost${req.url}`, { method: req.method!, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: gone.signal }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of response.body) if (!res.destroyed) res.write(chunk);
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.stdout.write(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp\n`);
