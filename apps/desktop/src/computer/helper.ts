/**
 * The computer use helper (`native/computer-macos/`, `atelier-computer`): one process per app, started by main so that
 * macOS charges its Accessibility and Screen Recording permissions to Atelier. Computer protocol v1 over stdio
 * (packages/protocol/src/computer.ts). Started on first use; started again after it exits (a crash, or after a
 * permission change, since a process keeps the permission answer it got).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { COMPUTER_PROTOCOL_VERSION, type ComputerInitializeResult, type ComputerMethods, type ComputerNotification } from '@atelier/protocol';

/** A failed call, with the helper's error code (`ComputerErrorCode`) and data. */
export class HelperError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: { permission?: 'accessibility' | 'screenRecording'; reason?: string },
  ) {
    super(message);
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

/** How long one call may take: a screenshot or an app launch can take a while, nothing takes this long. */
const CALL_TIMEOUT_MS = 30_000;

export class ComputerHelper {
  private child: ChildProcess | null = null;
  private ready: Promise<ComputerInitializeResult> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(n: ComputerNotification) => void>();

  /** `command`: the helper (a `.mjs` stand-in runs under this app's Node, for tests). */
  constructor(
    private readonly command: string,
    private readonly version: string,
  ) {}

  /** Starts it if needed and says what it can do. */
  start(): Promise<ComputerInitializeResult> {
    this.ready ??= this.launch();
    return this.ready;
  }

  async call<M extends keyof ComputerMethods>(method: M, params: ComputerMethods[M]['params']): Promise<ComputerMethods[M]['result']> {
    await this.start();
    return this.send(method, params) as Promise<ComputerMethods[M]['result']>;
  }

  onNotification(listener: (n: ComputerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ends it (it releases what it holds); the next call starts a new one. */
  restart(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.stdin?.end();
    child?.kill();
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    await this.send('shutdown', {}).catch(() => undefined);
    this.restart();
  }

  private launch(): Promise<ComputerInitializeResult> {
    const script = /\.m?js$/.test(this.command);
    const child = spawn(script ? process.execPath : this.command, script ? [this.command] : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(script ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
    });
    this.child = child;
    createInterface({ input: child.stdout! }).on('line', (line) => this.receive(line));
    child.stderr?.on('data', (chunk: Buffer) => console.warn(`[computer] ${chunk.toString().trimEnd()}`));
    const gone = (why: string) => {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
      }
      for (const p of this.pending.values()) p.reject(new HelperError(why, -32603));
      this.pending.clear();
    };
    child.on('exit', (code) => gone(`The computer use helper stopped (${code ?? 'signal'}).`));
    child.on('error', (e) => gone(`The computer use helper couldn't start: ${e.message}`));
    return this.send('initialize', { protocolVersion: COMPUTER_PROTOCOL_VERSION, client: { name: 'atelier', version: this.version } }) as Promise<ComputerInitializeResult>;
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new HelperError('The computer use helper isn’t running.', -32603));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError(`The computer use helper didn't answer ${method}.`, -32603));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private receive(line: string): void {
    let message: { id?: number; result?: unknown; error?: { code: number; message: string; data?: HelperError['data'] }; method?: string; params?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.id === undefined && message.method) {
      for (const listener of this.listeners) listener({ method: message.method, params: message.params } as ComputerNotification);
      return;
    }
    const pending = message.id !== undefined ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id!);
    if (message.error) pending.reject(new HelperError(message.error.message, message.error.code, message.error.data));
    else pending.resolve(message.result);
  }
}
