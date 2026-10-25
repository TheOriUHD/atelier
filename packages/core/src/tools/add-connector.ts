/**
 * AddConnector: an MCP server the person gives the assistant by its address becomes one of their connectors, after
 * they agree (always asked, also in Bypass: it adds to their setup). On a server it is one of their own connectors,
 * reached through the desktop app that agreed when it is on that computer's network; on the desktop's own backend it
 * joins Settings › Connectors. Its tools are offered from the next step on.
 */
import { randomBytes } from 'node:crypto';
import { McpServerName, type McpServerStatus, type PermissionAnswer, type PermissionRequest } from '@atelier/protocol';
import { textOutput, type DescribeContext, type Tool } from './types.ts';

export interface NewConnector {
  /** Chosen here, before it exists: the desktop that agrees allows its address under this id. */
  id: string;
  name: string;
  type: 'http' | 'sse';
  url: string;
}

export interface AddedConnector {
  /** Where the person finds it ("your connectors", "Settings › Connectors"). */
  where: string;
  state: McpServerStatus['state'];
  error?: string;
  /** The model-facing names of its tools (`mcp__<name>__<tool>`), once it connected. */
  tools: string[];
}

export interface AddConnectorDeps {
  approve(sessionId: string, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>;
  /** Saves it with the person's connectors and connects to it. Throws an Error whose message is for the model. */
  add(sessionId: string, connector: NewConnector): Promise<AddedConnector>;
}

interface Input {
  name: string;
  url: string;
  transport?: 'http' | 'sse';
  reason?: string;
}

function describe({ tier }: DescribeContext): string {
  if (tier === 'compact') return "Adds an MCP server by its address to the person's connectors, after they agree; its tools are offered from the next step.";
  return [
    "Adds an MCP server (a connector) by its address to the person's connectors, so that you can use its tools. The person is asked first.",
    "- Use it when the person gives you an MCP server's address (it often ends in /mcp or /sse) or asks you to connect one. WebFetch and the shell can't use an MCP server's tools.",
    '- `name` names its tools (`mcp__<name>__<tool>`): up to 64 letters, digits, - and _, like `fusion-360`.',
    "- `url` is the address as given, localhost included: an address on the person's computer is reached through their desktop app there.",
    "- Its tools are offered from your next step on. If it can't connect, the result says why: tell the person.",
  ].join('\n');
}

export function createAddConnectorTool(deps: AddConnectorDeps): Tool<Input> {
  return {
    name: 'AddConnector',
    readOnly: false,
    description: describe,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$', description: 'A short name for it and its tools, like `fusion-360`.' },
        url: { type: 'string', description: 'Its http or https address, as the person gave it.' },
        transport: { type: 'string', enum: ['http', 'sse'], description: 'Leave out: `sse` only for an older server that says so (its address usually ends in /sse).' },
        reason: { type: 'string', description: 'What it is for, in a sentence the person reads.' },
      },
      required: ['name', 'url'],
      additionalProperties: false,
    },
    compactExample: { name: 'fusion-360', url: 'http://127.0.0.1:27182/mcp' },
    async run({ name, url, transport, reason }, ctx) {
      const address = URL.parse(url.trim());
      if (!address || (address.protocol !== 'http:' && address.protocol !== 'https:')) return textOutput('Give the http or https address of the MCP server.', true);
      if (address.username || address.password) return textOutput("Don't put credentials in the address: add it without them, and the person can add a key in Customize › Connectors.", true);
      if (!McpServerName.safeParse(name).success) return textOutput('Use a name of up to 64 letters, digits, - and _.', true);
      const connector: NewConnector = {
        id: randomBytes(8).toString('hex'),
        name,
        type: transport ?? (/\/sse\/?$/.test(address.pathname) ? 'sse' : 'http'),
        url: address.href,
      };
      const answer = await deps.approve(
        ctx.sessionId,
        {
          callId: ctx.callId,
          toolName: 'AddConnector',
          input: { ...connector, reason: reason?.trim() ?? '' },
          reason: 'The assistant wants to add a connector.',
          suggestedRule: '',
        },
        ctx.signal,
      );
      if (answer.behavior === 'deny') {
        return textOutput(
          answer.message ? `The person declined to add ${name} and said: ${answer.message}` : `The person declined to add ${name}. Don't add it again unless they ask.`,
          true,
        );
      }
      let added: AddedConnector;
      try {
        added = await deps.add(ctx.sessionId, connector);
      } catch (e) {
        return textOutput(`Could not add ${name}: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      if (added.state === 'ready') {
        return textOutput(
          `Added ${name} to ${added.where}. ${added.tools.length ? `Its tools are offered from your next step: ${added.tools.join(', ')}.` : 'It offers no tools.'}`,
        );
      }
      const why = (added.error ?? 'it is still connecting').replace(/\.$/, '');
      return textOutput(`Added ${name} to ${added.where}, but it can't connect: ${why}. Tell the person; they find it there.`, true);
    },
  };
}
