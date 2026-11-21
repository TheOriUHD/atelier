/**
 * A 2025 stdio server, written by hand as older SDKs behave: it speaks only after `initialize`. Before that it leaves
 * any other request unanswered (`ignore`), or ends (`exit`, as older Rust servers do). Run by Node directly with the
 * behaviour as its argument; it counts its starts in `LEGACY_STARTS` (a file).
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const onProbe = process.argv[2] === 'exit' ? 'exit' : 'ignore';
if (process.env.LEGACY_STARTS) appendFileSync(process.env.LEGACY_STARTS, 'started\n');
let initialized = false;
const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as { id?: string | number; method?: string; params?: { protocolVersion?: string; arguments?: { text?: string } } };
  if (message.id === undefined || !message.method) return;
  if (message.method === 'initialize') {
    initialized = true;
    return send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'legacy', version: '1' } } });
  }
  if (!initialized) {
    if (onProbe === 'exit') process.exit(1);
    return;
  }
  if (message.method === 'ping') return send({ id: message.id, result: {} });
  if (message.method === 'tools/list') return send({ id: message.id, result: { tools: [{ name: 'echo', description: 'Says it back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  if (message.method === 'tools/call') return send({ id: message.id, result: { content: [{ type: 'text', text: message.params?.arguments?.text ?? '' }] } });
  send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
});
