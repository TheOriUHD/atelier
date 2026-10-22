/** A small MCP server for tests, served over stdio (`stdio-server.ts`) or Streamable HTTP and legacy SSE (in-process). */
import { inputRequired, inputResponse, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export interface MockState {
  /** Set by `add_tool`: instances made afterwards list `added` too. */
  added: boolean;
  log(line: string): void;
}

/** A 1×1 PNG. */
export const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

export function mockServer(state: MockState): McpServer {
  const server = new McpServer({ name: 'mock', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  const addExtra = () => server.registerTool('added', { description: 'Added at runtime.' }, () => text('added'));
  server.registerTool('echo', { description: 'Echoes its input.', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } }, ({ text: value }) => text(value));
  server.registerTool('picture', { description: 'Returns a picture.' }, () => ({ content: [{ type: 'text', text: 'One pixel:' }, { type: 'image', data: PIXEL, mimeType: 'image/png' }] }));
  server.registerTool('fail', { description: 'Always fails.' }, () => ({ ...text('it broke'), isError: true }));
  server.registerTool('big', { description: 'Returns a lot of text.' }, () => text('x'.repeat(150_000)));
  server.registerTool('resources', { description: 'Returns resources.' }, () => ({
    content: [
      { type: 'resource', resource: { uri: 'file:///notes.md', mimeType: 'text/markdown', text: '# Notes' } },
      { type: 'resource_link', uri: 'file:///data.bin', name: 'data.bin', mimeType: 'application/octet-stream' },
    ],
  }));
  // What the server was given: the Authorization header over HTTP, MOCK_TOKEN over stdio.
  server.registerTool('whoami', { description: 'Returns its credentials.' }, (ctx) => text(`token: ${ctx.http?.req?.headers.get('authorization') ?? process.env.MOCK_TOKEN}`));
  server.registerTool('ask', { description: 'Asks for a name.' }, (ctx) => {
    const answer = inputResponse(ctx.mcpReq.inputResponses, 'name');
    if (answer.kind === 'missing') {
      const requestedSchema = { type: 'object' as const, properties: { name: { type: 'string' as const } }, required: ['name'] };
      return inputRequired({ inputRequests: { name: inputRequired.elicit({ message: 'What is your name?', requestedSchema }) } });
    }
    return text(answer.kind === 'elicit' && answer.action === 'accept' ? `Hello ${String(answer.content?.name)}` : `No name (${answer.kind === 'elicit' ? answer.action : answer.kind})`);
  });
  server.registerTool('sign_in', { description: 'Asks the person to sign in on a web page.' }, (ctx) => {
    const answer = inputResponse(ctx.mcpReq.inputResponses, 'login');
    if (answer.kind === 'missing') return inputRequired({ inputRequests: { login: inputRequired.elicitUrl({ message: 'Sign in to Mock', url: 'https://mock.example/login' }) } });
    return text(answer.kind === 'elicit' ? `Sign-in ${answer.action}` : 'Sign-in failed');
  });
  server.registerTool('slow', { description: 'Runs until cancelled.' }, (ctx) => {
    state.log('slow: started');
    return new Promise((resolve) =>
      ctx.mcpReq.signal.addEventListener('abort', () => {
        state.log('slow: cancelled');
        resolve(text('cancelled'));
      }),
    );
  });
  server.registerTool('add_tool', { description: 'Adds a tool.' }, () => {
    state.added = true;
    addExtra();
    return text('ok');
  });
  server.registerTool('dotted.name', { description: 'A name with a dot.' }, () => text('dotted'));
  server.registerTool(`long_${'x'.repeat(70)}`, { description: 'D'.repeat(3000) }, () => text('long'));
  if (state.added) addExtra();
  return server;
}
