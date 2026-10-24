/**
 * MCP over a device link's lines (ARCHITECTURE §9-B, §21): a person's connector that runs a program runs it on their
 * desktop, and each JSON-RPC message is one line of a channel there and back. `LineTransport` is the server's end, an
 * SDK transport over that channel; `programChannel` is the desktop's, the program's stdio as a channel, started the way
 * the SDK starts a stdio server (cross-spawn, its safe default environment, stderr kept apart).
 */
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { deserializeMessage, serializeMessage, SdkError, SdkErrorCode, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { RunnerChannel } from '../workspaces/runner-client.ts';

/** The client's end of a connector whose program runs elsewhere: its messages are the channel's lines. */
export class LineTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private ended = false;

  constructor(private readonly channel: RunnerChannel) {}

  async start(): Promise<void> {
    this.channel.onLine((line) => {
      let message: JSONRPCMessage;
      try {
        message = deserializeMessage(line);
      } catch (error) {
        // A line that isn't JSON-RPC (a program printing to stdout) is reported, not fatal.
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.onmessage?.(message);
    });
    void this.channel.closed.then(() => this.end());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ended) throw new SdkError(SdkErrorCode.ConnectionClosed, 'The connection closed.');
    this.channel.send(serializeMessage(message).trimEnd());
  }

  async close(): Promise<void> {
    this.channel.kill();
    this.end();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onclose?.();
  }
}

/**
 * A connector's program on this computer as a channel: lines in are messages to its stdin, its messages come out as
 * lines, and what it writes to stderr goes to `log`. Resolves once it started; rejects when it couldn't.
 */
export async function programChannel(program: { command: string; args: string[]; env: Record<string, string>; cwd: string }, log: (line: string) => void): Promise<RunnerChannel> {
  const transport = new StdioClientTransport({ ...program, stderr: 'pipe' });
  if (transport.stderr) createInterface({ input: transport.stderr as Readable, crlfDelay: Infinity }).on('line', log);
  let listener: ((line: string) => void) | null = null;
  const early: string[] = [];
  let finish!: () => void;
  const closed = new Promise<{ code: null; signal: null }>((resolve) => (finish = () => resolve({ code: null, signal: null })));
  transport.onmessage = (message) => {
    const line = JSON.stringify(message);
    if (listener) listener(line);
    else early.push(line);
  };
  transport.onclose = () => finish();
  // Its stdout breaking or a line that isn't JSON-RPC: said on stderr's way, the program keeps running.
  transport.onerror = (error) => log(error.message);
  await transport.start();
  return {
    send: (line) => {
      let message: JSONRPCMessage;
      try {
        message = deserializeMessage(line);
      } catch {
        return; // Only JSON-RPC reaches the program.
      }
      void transport.send(message).catch(() => undefined);
    },
    onLine: (handler) => {
      listener = handler;
      for (const line of early.splice(0)) handler(line);
    },
    closed,
    kill: () => void transport.close().catch(() => undefined),
  };
}
