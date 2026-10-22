/** The mock server over stdio, run by Node directly; it logs to stderr, including the token it was given. */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { mockServer } from './mock-server.ts';

const state = { added: false, log: (line: string) => void process.stderr.write(`${line}\n`) };
state.log(`mock server starting with token ${process.env.MOCK_TOKEN}`);
serveStdio(() => {
  const server = mockServer(state);
  server.registerTool('crash', { description: 'Exits the server.' }, () => process.exit(1));
  return server;
});
