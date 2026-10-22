import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appError, createMemoryTransportPair, createRpcClient, RpcError, RpcErrorCode, serveRpc, type Contract } from './jsonrpc.ts';

const test = {
  procedures: {
    add: { input: z.object({ a: z.number(), b: z.number() }), output: z.number() },
    slow: { input: z.object({}), output: z.string() },
    fail: { input: z.object({}), output: z.null() },
    crash: { input: z.object({}), output: z.null() },
  },
  events: { tick: z.object({ n: z.number() }) },
} as const satisfies Contract;

function setup() {
  const [clientSide, serverSide] = createMemoryTransportPair();
  let slowAborted = false;
  const errors: unknown[] = [];
  const server = serveRpc(
    test,
    {
      add: ({ a, b }) => a + b,
      slow: (_input, { signal }) =>
        new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('done'), 1000);
          signal.addEventListener('abort', () => {
            slowAborted = true;
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        }),
      fail: () => {
        throw appError('provider_offline', 'Provider is offline', { fix: 'settings/providers' });
      },
      crash: () => {
        throw new Error('secret internals');
      },
    },
    serverSide,
    {},
    (_m, e) => errors.push(e),
  );
  const client = createRpcClient(test, clientSide);
  return { client, server, wasAborted: () => slowAborted, errors };
}

describe('json-rpc', () => {
  it('round-trips a call', async () => {
    const { client } = setup();
    await expect(client.call('add', { a: 2, b: 3 })).resolves.toBe(5);
  });

  it('rejects invalid params without calling the handler', async () => {
    const { client } = setup();
    await expect(client.call('add', { a: 'x', b: 1 } as never)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  });

  it('propagates application errors with code and fix link', async () => {
    const { client } = setup();
    const err = await client.call('fail', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).data).toMatchObject({ code: 'provider_offline', fix: 'settings/providers' });
  });

  it('hides unexpected errors behind Internal', async () => {
    const { client, errors } = setup();
    const err = (await client.call('crash', {}).catch((e: unknown) => e)) as RpcError;
    expect(err.code).toBe(RpcErrorCode.Internal);
    expect(err.message).not.toContain('secret');
    expect(errors).toHaveLength(1);
  });

  it('cancels in-flight requests via $/cancel', async () => {
    const { client, wasAborted } = setup();
    const controller = new AbortController();
    const p = client.call('slow', {}, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: RpcErrorCode.Cancelled });
    await new Promise((r) => setTimeout(r, 10));
    expect(wasAborted()).toBe(true);
  });

  it('delivers events to subscribers', async () => {
    const { client, server } = setup();
    const seen: number[] = [];
    const off = client.on('tick', (p) => seen.push(p.n));
    server.emit('tick', { n: 1 });
    await new Promise((r) => setTimeout(r, 5));
    off();
    server.emit('tick', { n: 2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([1]);
  });
});
