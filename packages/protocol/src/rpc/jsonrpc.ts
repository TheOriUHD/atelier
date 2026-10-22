/**
 * Minimal typed JSON-RPC 2.0 over any message transport (MessagePort, WebSocket, stdio).
 * Requests carry ids; events are notifications; `$/cancel` aborts an in-flight request.
 */
import type { z } from 'zod';

export type RpcId = number | string;
export type RpcRequest = { jsonrpc: '2.0'; id: RpcId; method: string; params?: unknown };
export type RpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown };
export type RpcErrorObject = { code: number; message: string; data?: unknown };
export type RpcResponse = { jsonrpc: '2.0'; id: RpcId; result?: unknown; error?: RpcErrorObject };
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export interface Transport {
  send(message: RpcMessage): void;
  onMessage(handler: (message: RpcMessage) => void): () => void;
  onClose?(handler: () => void): () => void;
}

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  Cancelled: -32800,
  /** Application errors carry a stable string code in `data.code`. */
  Application: -32000,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: { code?: string; fix?: string; [k: string]: unknown },
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Throw from a handler to send an application error with a stable code and optional settings fix link. */
export function appError(code: string, message: string, extra?: { fix?: string; [k: string]: unknown }): RpcError {
  return new RpcError(RpcErrorCode.Application, message, { code, ...extra });
}

export type ProcedureDef = { input: z.ZodType; output: z.ZodType };
export type Contract = { procedures: Record<string, ProcedureDef>; events: Record<string, z.ZodType> };

type ProcInput<C extends Contract, M extends keyof C['procedures']> = z.input<C['procedures'][M]['input']>;
type ProcOutput<C extends Contract, M extends keyof C['procedures']> = z.output<C['procedures'][M]['output']>;
type EventPayload<C extends Contract, E extends keyof C['events']> = z.output<C['events'][E]>;

const isRequest = (m: RpcMessage): m is RpcRequest => 'method' in m && 'id' in m && m.id !== undefined;
const isNotification = (m: RpcMessage): m is RpcNotification => 'method' in m && !('id' in m && m.id !== undefined);
const isResponse = (m: RpcMessage): m is RpcResponse => !('method' in m) && 'id' in m;

// ---------------------------------------------------------------- client

export interface RpcClient<C extends Contract> {
  call<M extends keyof C['procedures'] & string>(
    method: M,
    input: ProcInput<C, M>,
    options?: { signal?: AbortSignal },
  ): Promise<ProcOutput<C, M>>;
  on<E extends keyof C['events'] & string>(event: E, handler: (payload: EventPayload<C, E>) => void): () => void;
  close(): void;
}

export function createRpcClient<C extends Contract>(_contract: C, transport: Transport): RpcClient<C> {
  let nextId = 1;
  const pending = new Map<RpcId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const offMessage = transport.onMessage((message) => {
    if (isResponse(message)) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      if (message.error) p.reject(new RpcError(message.error.code, message.error.message, message.error.data as never));
      else p.resolve(message.result);
    } else if (isNotification(message)) {
      for (const handler of listeners.get(message.method) ?? []) handler(message.params);
    }
  });
  const offClose = transport.onClose?.(() => {
    for (const p of pending.values()) p.reject(new RpcError(RpcErrorCode.Internal, 'Connection closed'));
    pending.clear();
  });

  return {
    call(method, input, options) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        if (options?.signal?.aborted) return reject(new RpcError(RpcErrorCode.Cancelled, 'Cancelled'));
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        options?.signal?.addEventListener(
          'abort',
          () => {
            if (!pending.has(id)) return;
            pending.delete(id);
            transport.send({ jsonrpc: '2.0', method: '$/cancel', params: { id } });
            reject(new RpcError(RpcErrorCode.Cancelled, 'Cancelled'));
          },
          { once: true },
        );
        transport.send({ jsonrpc: '2.0', id, method, params: input });
      });
    },
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler as (payload: unknown) => void);
      return () => set.delete(handler as (payload: unknown) => void);
    },
    close() {
      offMessage();
      offClose?.();
    },
  };
}

// ---------------------------------------------------------------- server

export type HandlerContext<Ctx> = Ctx & { signal: AbortSignal };
export type Handlers<C extends Contract, Ctx> = {
  [M in keyof C['procedures'] & string]: (
    input: z.output<C['procedures'][M]['input']>,
    ctx: HandlerContext<Ctx>,
  ) => Promise<ProcOutput<C, M>> | ProcOutput<C, M>;
};

export interface RpcServerConnection<C extends Contract> {
  emit<E extends keyof C['events'] & string>(event: E, payload: EventPayload<C, E>): void;
  close(): void;
}

/**
 * Serves one connection. `ctx` is passed to every handler (e.g. the connection's identity and emitter).
 * Handler errors become JSON-RPC errors; unexpected errors are reported as Internal without leaking stacks.
 */
export function serveRpc<C extends Contract, Ctx>(
  contract: C,
  handlers: Handlers<C, Ctx>,
  transport: Transport,
  ctx: Ctx,
  onUnexpectedError: (method: string, error: unknown) => void = () => {},
): RpcServerConnection<C> {
  const inflight = new Map<RpcId, AbortController>();

  const reply = (id: RpcId, body: { result: unknown } | { error: RpcErrorObject }) =>
    transport.send({ jsonrpc: '2.0', id, ...body });

  const offMessage = transport.onMessage(async (message) => {
    if (isNotification(message)) {
      if (message.method === '$/cancel') {
        const id = (message.params as { id?: RpcId } | undefined)?.id;
        if (id !== undefined) inflight.get(id)?.abort();
      }
      return;
    }
    if (!isRequest(message)) return;
    const def = contract.procedures[message.method];
    const handler = (handlers as Record<string, (i: unknown, c: unknown) => unknown>)[message.method];
    if (!def || !handler) {
      reply(message.id, { error: { code: RpcErrorCode.MethodNotFound, message: `Unknown method ${message.method}` } });
      return;
    }
    const parsed = def.input.safeParse(message.params ?? {});
    if (!parsed.success) {
      reply(message.id, {
        error: { code: RpcErrorCode.InvalidParams, message: 'Invalid params', data: { issues: parsed.error.issues } },
      });
      return;
    }
    const controller = new AbortController();
    inflight.set(message.id, controller);
    try {
      const result = await handler(parsed.data, { ...ctx, signal: controller.signal });
      reply(message.id, { result: result ?? null });
    } catch (error) {
      if (error instanceof RpcError) {
        reply(message.id, { error: { code: error.code, message: error.message, data: error.data } });
      } else if (controller.signal.aborted) {
        reply(message.id, { error: { code: RpcErrorCode.Cancelled, message: 'Cancelled' } });
      } else {
        onUnexpectedError(message.method, error);
        reply(message.id, { error: { code: RpcErrorCode.Internal, message: 'Internal error' } });
      }
    } finally {
      inflight.delete(message.id);
    }
  });
  const offClose = transport.onClose?.(() => {
    for (const c of inflight.values()) c.abort();
    inflight.clear();
  });

  return {
    emit(event, payload) {
      transport.send({ jsonrpc: '2.0', method: event, params: payload });
    },
    close() {
      for (const c of inflight.values()) c.abort();
      offMessage();
      offClose?.();
    },
  };
}

/** In-memory transport pair for tests and same-process use. */
export function createMemoryTransportPair(): [Transport, Transport] {
  const handlers: [Set<(m: RpcMessage) => void>, Set<(m: RpcMessage) => void>] = [new Set(), new Set()];
  const make = (self: 0 | 1): Transport => ({
    send: (m) => queueMicrotask(() => handlers[self === 0 ? 1 : 0].forEach((h) => h(structuredClone(m)))),
    onMessage: (h) => {
      handlers[self].add(h);
      return () => handlers[self].delete(h);
    },
  });
  return [make(0), make(1)];
}
