/**
 * Co-op's two directions over one encrypted channel (ARCHITECTURE §24): the guest calls the host on the `coop` lane
 * (CoopContract), the host calls the guest on the `peer` lane (PeerContract). Each lane is a JSON-RPC transport of its
 * own (packages/protocol/src/rpc/jsonrpc.ts), so both sides use the ordinary client and server.
 */
import type { RpcMessage, Transport } from '@atelier/protocol';

/** A channel that carries JSON both ways (channel.ts `PeerChannel` / `GuestChannel`). */
export interface JsonChannel {
  send(message: unknown): void | Promise<void>;
  onMessage(handler: (message: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
}

export interface Lanes {
  coop: Transport;
  peer: Transport;
}

export function lanes(channel: JsonChannel): Lanes {
  const make = (lane: 'coop' | 'peer'): Transport => ({
    send: (message: RpcMessage) => void Promise.resolve(channel.send({ lane, message })).catch(() => undefined),
    onMessage: (handler) =>
      channel.onMessage((frame) => {
        const f = frame as { lane?: unknown; message?: unknown };
        if (f && f.lane === lane && f.message && typeof f.message === 'object') handler(f.message as RpcMessage);
      }),
    onClose: (handler) => channel.onClose(handler),
  });
  return { coop: make('coop'), peer: make('peer') };
}
