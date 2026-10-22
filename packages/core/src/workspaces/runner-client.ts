/**
 * Client for the Go runner (ARCHITECTURE.md §5): JSON-RPC one object per line, AbortSignal mapped to
 * `$/cancel`, a heartbeat, and a report when the runner goes away. The lines travel over a channel: the
 * stdio of a runner spawned here, or a desktop device's link when the folder is on that device (§21).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  RpcError,
  RpcErrorCode,
  RUNNER_PROTOCOL_VERSION,
  runnerBinaryName,
  type InitializeResult,
  type RpcMessage,
  type RpcResponse,
  type RunnerMethod,
  type RunnerMethods,
  type RunnerNotification,
  type RunnerNotifications,
} from '@atelier/protocol';

export interface RunnerSpawnOptions {
  binaryPath: string;
  /** Workspace roots; the first is the primary root that relative paths resolve against. */
  roots: string[];
  /** Named in the runner's log. */
  client?: { name: string; version: string };
  env?: NodeJS.ProcessEnv;
  /** Receives each line the runner logs to stderr. */
  onLog?: (line: string) => void;
  /** Starts the runner through this command (the operating system's sandbox), which takes the runner's command line. */
  wrap?: { command: string; args: string[] };
}

export interface RunnerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Path of the host's runner build inside a directory of runner builds. */
export function hostRunnerBinary(dir: string): string {
  return join(dir, runnerBinaryName(process.platform, process.arch));
}

type Pending = { resolve: (result: unknown) => void; reject: (error: unknown) => void };

/** Heartbeat (§5): `sys.ping` every 10 s; the runner is given up on once two in a row go unanswered. */
const PING_MS = 10_000;
const MISSED_PINGS = 2;

/** Where a runner's JSON-RPC lines travel. */
export interface RunnerChannel {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  /** Resolves once the runner (or the link to it) is gone. */
  closed: Promise<RunnerExit>;
  /** Ends it without asking the runner first. */
  kill(): void;
}

/** A runner process on this machine, talking over its stdio. */
export function spawnRunner(options: Omit<RunnerSpawnOptions, 'client'>): RunnerChannel & { spawnError: () => Error | undefined } {
  const args = ['--stdio', ...options.roots.flatMap((root) => ['--root', root])];
  if (options.wrap) return processChannel(options.wrap.command, [...options.wrap.args, options.binaryPath, ...args], options);
  return processChannel(options.binaryPath, args, options);
}

/** Lines over a child process's stdio: the runner itself, or `ssh` running it on another machine. */
export function processChannel(
  command: string,
  args: string[],
  options: Pick<RunnerSpawnOptions, 'env' | 'onLog'> = {},
): RunnerChannel & { spawnError: () => Error | undefined } {
  const child: ChildProcessWithoutNullStreams = spawn(command, args, { env: options.env ?? process.env, windowsHide: true });
  let spawnError: Error | undefined;
  child.on('error', (error) => (spawnError = error));
  // Writes after the runner died fail with EPIPE; the exit is reported through `closed` instead.
  child.stdin.on('error', () => {});
  if (options.onLog) createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', options.onLog);
  else child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return {
    send: (line) => void (child.stdin.writable && child.stdin.write(`${line}\n`)),
    onLine: (handler) => void lines.on('line', handler),
    closed: new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))),
    kill: () => void child.kill('SIGKILL'),
    spawnError: () => spawnError,
  };
}

export class RunnerClient {
  /** Resolves once the runner has exited (or its link closed) and pending calls have failed. */
  readonly exited: Promise<RunnerExit>;
  private handshake: InitializeResult | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(payload: never) => void>>();
  private exit: RunnerExit | null = null;
  /** Pings sent since the runner last said anything. */
  private unanswered = 0;
  private lost = false;

  private constructor(private readonly channel: RunnerChannel) {
    channel.onLine((line) => this.receive(line));
    // A link that went quiet (a laptop asleep, a NAT that dropped the connection) would leave every call waiting:
    // closing the channel fails them, and the workspace's next use connects again.
    const heartbeat = setInterval(() => {
      if (this.unanswered >= MISSED_PINGS) {
        this.lost = true;
        return channel.kill();
      }
      this.unanswered++;
      void this.call('sys.ping', {}).catch(() => {});
    }, PING_MS);
    heartbeat.unref?.();
    this.exited = channel.closed.then((exit) => {
      this.exit = exit;
      clearInterval(heartbeat);
      const reason = this.lost ? 'The runner stopped answering; the connection to it was lost.' : `Runner exited (code ${exit.code}, signal ${exit.signal})`;
      const error = new RpcError(RpcErrorCode.Internal, reason);
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      return exit;
    });
  }

  /** Starts a runner on this machine and completes the `initialize` handshake. */
  static async spawn(options: RunnerSpawnOptions): Promise<RunnerClient> {
    const channel = spawnRunner(options);
    try {
      return await RunnerClient.connect(channel, options.client);
    } catch (error) {
      throw channel.spawnError() ?? error;
    }
  }

  /** Completes the `initialize` handshake over a channel; kills it if that fails. */
  static async connect(channel: RunnerChannel, client = { name: 'atelier-core', version: '0' }): Promise<RunnerClient> {
    const runner = new RunnerClient(channel);
    try {
      runner.handshake = await runner.call('initialize', { protocolVersion: RUNNER_PROTOCOL_VERSION, client });
      return runner;
    } catch (error) {
      channel.kill();
      throw error;
    }
  }

  /** The runner's answer to `initialize`. */
  get info(): InitializeResult {
    return this.handshake!;
  }

  get alive(): boolean {
    return this.exit === null;
  }

  call<M extends RunnerMethod>(
    method: M,
    params: RunnerMethods[M]['params'],
    options?: { signal?: AbortSignal },
  ): Promise<RunnerMethods[M]['result']> {
    const signal = options?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RpcError(RpcErrorCode.Cancelled, 'Cancelled'));
      if (!this.alive) return reject(new RpcError(RpcErrorCode.Internal, 'Runner is not running'));
      const id = this.nextId++;
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        this.send({ jsonrpc: '2.0', method: '$/cancel', params: { id } });
        reject(new RpcError(RpcErrorCode.Cancelled, 'Cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (result) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(result as RunnerMethods[M]['result']);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  on<N extends RunnerNotification>(event: N, handler: (payload: RunnerNotifications[N]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Asks the runner to exit, killing it if it has not exited after `timeoutMs`. */
  async shutdown(timeoutMs = 3000): Promise<RunnerExit> {
    if (this.alive) {
      const timer = setTimeout(() => this.channel.kill(), timeoutMs);
      await this.call('shutdown', {}).catch(() => {});
      await this.exited;
      clearTimeout(timer);
    }
    return this.exited;
  }

  kill(): void {
    this.channel.kill();
  }

  private send(message: RpcMessage): void {
    this.channel.send(JSON.stringify(message));
  }

  private receive(line: string): void {
    this.unanswered = 0;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return; // The runner writes only JSON frames to stdout.
    }
    if ('method' in message) {
      for (const handler of this.listeners.get(message.method) ?? []) (handler as (p: unknown) => void)(message.params);
      return;
    }
    const response = message as RpcResponse;
    const p = typeof response.id === 'number' ? this.pending.get(response.id) : undefined;
    if (!p) return;
    this.pending.delete(response.id as number);
    if (response.error)
      p.reject(new RpcError(response.error.code, response.error.message, response.error.data as never));
    else p.resolve(response.result);
  }
}
