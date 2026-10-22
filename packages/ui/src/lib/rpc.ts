import { useEffect } from 'react';
import { contract, createRpcClient, RpcError, type AppContract, type RpcClient } from '@atelier/protocol';
import type { z } from 'zod';
import { getTransport } from './platform.ts';

let client: RpcClient<AppContract> | null = null;
const signInLostHandlers = new Set<() => void>();

/** Runs `handler` whenever a call fails because this connection is not signed in (any more). */
export function onSignInLost(handler: () => void): () => void {
  signInLostHandlers.add(handler);
  return () => void signInLostHandlers.delete(handler);
}

export function rpc(): RpcClient<AppContract> {
  if (!client) {
    const base = createRpcClient(contract, getTransport());
    client = {
      ...base,
      call: (method, input, options) =>
        base.call(method, input, options).catch((e: unknown) => {
          if (errorCode(e) === 'unauthenticated') for (const handler of signInLostHandlers) handler();
          throw e;
        }),
    };
  }
  return client;
}

/** The stable application error code (`exists`, `last_admin`, …), if the error carries one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof RpcError ? error.data?.code : undefined;
}

type Events = AppContract['events'];

/** Subscribes to a backend event for the lifetime of the component. */
export function useRpcEvent<E extends keyof Events & string>(event: E, handler: (payload: z.output<Events[E]>) => void): void {
  useEffect(() => rpc().on(event, handler), [event, handler]);
}

/** Human-readable message plus the settings page that fixes it, for inline errors and toasts. */
export function describeError(error: unknown): { message: string; fix?: string } {
  if (error instanceof RpcError) return { message: error.message, ...(error.data?.fix ? { fix: error.data.fix } : {}) };
  if (error instanceof Error) return { message: error.message };
  return { message: 'Something went wrong.' };
}
