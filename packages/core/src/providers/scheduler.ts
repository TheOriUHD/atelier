/**
 * Sharing a model server (ARCHITECTURE §7). A local GPU answers a few requests at a time and holds one model, or a
 * few: anything more only queues inside the server, out of sight, and a request for another model makes it unload
 * the one it holds. So every model request waits here for a slot on its server, and sub-agent runs wait for a turn:
 *  - at most `parallel` requests run on a server at once, and at most `parallel` sub-agents work on it at once (a
 *    sub-agent keeps its slot for the whole run, so a single-slot server keeps its prompt cache warm);
 *  - requests for different models run side by side only while the server can hold that many (`modelsAtOnce`);
 *  - the oldest request goes first, but the person's own runs get a head start over sub-agents, and both over
 *    background work like titles, so the person waits least and nothing waits forever;
 *  - a request for a model the server already holds may overtake one for another model, if it is at most
 *    AFFINITY_MS younger, to save a swap.
 * Providers on the same server (same base URL) share its queue.
 */
import { isIP } from 'node:net';
import { blockedAddress } from '../tools/address-guard.ts';
import type { ChatRequest, ProviderAdapter, QueuePriority, StreamEvent } from './types.ts';

export interface ServerLimits {
  /** Requests the server runs at once. */
  parallel: number;
  /** Models it holds at once; Infinity for hosted APIs. */
  modelsAtOnce: number;
}

/**
 * Without settings or a report from the server: a server on this computer or the local network is one GPU's worth,
 * one request and one model at a time (Ollama's default); a hosted API takes plenty and holds every model.
 */
export function defaultLimits(baseUrl: string): ServerLimits {
  return isLocalServer(baseUrl) ? { parallel: 1, modelsAtOnce: 1 } : { parallel: 16, modelsAtOnce: Infinity };
}

/** The queue's name for the server behind a base URL: providers on the same server share it. */
export const serverName = (baseUrl: string): string => baseUrl.toLowerCase().replace(/\/+$/, '');

export function isLocalServer(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (isIP(host)) return blockedAddress(host, false) !== null;
  // A bare name (`gpu-box`), mDNS, home routers' and tailnets' names.
  return !host.includes('.') || /\.(localhost|local|lan|home|internal|home\.arpa|ts\.net)$/.test(host);
}

const HEAD_START_MS: Record<QueuePriority, number> = { urgent: -60_000, foreground: 0, subagent: 15_000, background: 60_000 };
const AFFINITY_MS = 30_000;

interface Ticket {
  model: string;
  /** Effective arrival: when it was queued, plus its priority's handicap. */
  at: number;
  seq: number;
  ahead: number | null;
  owner?: string | undefined;
  onWait?: ((ahead: number | null) => void) | undefined;
  start(): void;
}

interface Server {
  limits: () => ServerLimits;
  running: Map<string, number>;
  /** The conversations the running requests are for (undefined for none), to leave a conversation's own out of "ahead". */
  owners: (string | undefined)[];
  /** Models the server most likely holds, most recently used first. */
  warm: string[];
  queue: Ticket[];
  agents: { active: number; waiting: Ticket[] };
}

export class RequestScheduler {
  private servers = new Map<string, Server>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The adapter with its streams taking a slot on `server` (any stable name for it, like its base URL). */
  wrap(adapter: ProviderAdapter, server: string, limits: () => ServerLimits): ProviderAdapter {
    return { ...adapter, stream: (request) => this.stream(adapter, this.server(server, limits), request) };
  }

  /**
   * Waits until a sub-agent may start working on `server` and returns the release, to call when it is done.
   * `onWait` hears how many sub-agents are ahead, then null when it starts.
   */
  async agentTurn(server: string, limits: () => ServerLimits, signal: AbortSignal, onWait?: (ahead: number | null) => void): Promise<() => void> {
    const s = this.server(server, limits);
    await this.wait(s.agents.waiting, signal, '', 'subagent', onWait, () => this.pumpAgents(s));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.agents.active--;
      this.pumpAgents(s);
    };
  }

  /** Requests running and waiting per server, for tests and diagnostics. */
  load(server: string): { running: number; queued: number; agents: number } | null {
    const s = this.servers.get(server);
    return s ? { running: sum(s.running), queued: s.queue.length, agents: s.agents.active } : null;
  }

  private server(name: string, limits: () => ServerLimits): Server {
    let s = this.servers.get(name);
    if (!s) this.servers.set(name, (s = { limits, running: new Map(), owners: [], warm: [], queue: [], agents: { active: 0, waiting: [] } }));
    s.limits = limits;
    return s;
  }

  private async *stream(adapter: ProviderAdapter, s: Server, request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { priority = 'foreground', onWait, timeoutMs, owner } = request.queue ?? {};
    try {
      await this.wait(s.queue, request.signal, request.model, priority, onWait, () => this.pump(s), owner);
    } catch {
      yield { type: 'finish', reason: 'aborted' };
      return;
    }
    const model = request.model;
    try {
      // The time limit counts from here: waiting for a slot is not the server being slow.
      const signal = timeoutMs ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) : request.signal;
      yield* adapter.stream({ ...request, signal });
    } finally {
      const n = (s.running.get(model) ?? 1) - 1;
      if (n > 0) s.running.set(model, n);
      else s.running.delete(model);
      s.owners.splice(s.owners.indexOf(owner), 1);
      this.pump(s);
    }
  }

  /** Queues a ticket and resolves once `pump` starts it; rejects when the signal aborts first. */
  private wait(
    queue: Ticket[],
    signal: AbortSignal,
    model: string,
    priority: QueuePriority,
    onWait: ((ahead: number | null) => void) | undefined,
    pump: () => void,
    owner?: string,
  ): Promise<Ticket> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => {
        queue.splice(queue.indexOf(ticket), 1);
        if (ticket.ahead !== null) onWait?.(null);
        reject(signal.reason);
        pump();
      };
      const ticket: Ticket = {
        model,
        at: this.now() + HEAD_START_MS[priority],
        seq: this.seq++,
        ahead: null,
        owner,
        onWait,
        start: () => {
          signal.removeEventListener('abort', onAbort);
          if (ticket.ahead !== null) onWait?.(null);
          resolve(ticket);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      queue.push(ticket);
      pump();
    });
  }

  private pump(s: Server): void {
    const { parallel, modelsAtOnce } = s.limits();
    while (s.queue.length && sum(s.running) < Math.max(1, parallel)) {
      const next = pick(s, modelsAtOnce);
      if (!next) break;
      s.queue.splice(s.queue.indexOf(next), 1);
      s.running.set(next.model, (s.running.get(next.model) ?? 0) + 1);
      s.owners.push(next.owner);
      s.warm = [next.model, ...s.warm.filter((m) => m !== next.model)].slice(0, Number.isFinite(modelsAtOnce) ? Math.max(1, modelsAtOnce) : 8);
      next.start();
    }
    announce(byArrival(s.queue), s.owners);
  }

  private pumpAgents(s: Server): void {
    const { parallel } = s.limits();
    const waiting = byArrival(s.agents.waiting);
    while (waiting.length && s.agents.active < Math.max(1, parallel)) {
      const next = waiting.shift()!;
      s.agents.waiting.splice(s.agents.waiting.indexOf(next), 1);
      s.agents.active++;
      next.start();
    }
    announce(waiting, Array<undefined>(s.agents.active).fill(undefined));
  }
}

/** The next request to start, or none while the oldest one needs a model the server has no room for yet. */
function pick(s: Server, modelsAtOnce: number): Ticket | undefined {
  const order = byArrival(s.queue);
  const head = order[0]!;
  const fits = (t: Ticket) => s.running.has(t.model) || new Set([...s.running.keys(), t.model]).size <= Math.max(1, modelsAtOnce);
  const warm = order.find((t) => t.at <= head.at + AFFINITY_MS && s.warm.includes(t.model) && fits(t));
  return warm ?? (fits(head) ? head : undefined);
}

const byArrival = (tickets: Ticket[]) => [...tickets].sort((a, b) => a.at - b.at || a.seq - b.seq);
const sum = (running: Map<string, number>) => [...running.values()].reduce((a, b) => a + b, 0);

/**
 * Tells each waiting ticket how many are ahead of it (the running ones and the older waiting ones), when that changed.
 * Requests for the ticket's own conversation don't count; with only those ahead it hears nothing, as if running.
 */
function announce(waiting: Ticket[], running: (string | undefined)[]): void {
  waiting.forEach((t, i) => {
    const others = (owner: string | undefined) => !t.owner || owner !== t.owner;
    const ahead = running.filter(others).length + waiting.slice(0, i).filter((w) => others(w.owner)).length;
    const shown = ahead > 0 || !t.owner ? ahead : null;
    if (t.ahead === shown) return;
    t.ahead = shown;
    t.onWait?.(shown);
  });
}
