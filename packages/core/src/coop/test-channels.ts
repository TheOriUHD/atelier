/**
 * In-memory stand-ins for the relay's encrypted channels, for the co-op tests: both ends of one guest's channel, JSON
 * round-tripped as the real one does, delivered asynchronously.
 */
import type { GuestChannelPort } from './gateway.ts';
import type { PeerChannelPort } from './host.ts';

interface End {
  messages: Set<(message: unknown) => void>;
  closes: Set<() => void>;
  open: boolean;
}

const end = (): End => ({ messages: new Set(), closes: new Set(), open: true });

export interface ChannelPair {
  host: PeerChannelPort;
  guest: GuestChannelPort;
  /** The link drops as a network failure would: both ends hear it. */
  drop(): void;
  hostPresent(present: boolean): void;
  reconnected(): void;
  /** The secret the guest's end was told to use for its next handshake. */
  secret: string | null;
}

export function channelPair(opts: { guestKey: string; hostKey?: string; fingerprint?: string[] }): ChannelPair {
  const h = end();
  const g = end();
  const reconnectedHandlers = new Set<() => void>();
  const hostHandlers = new Set<(present: boolean) => void>();
  const fingerprint = opts.fingerprint ?? ['🐙', '🌵', '🎈', '🚀'];
  const deliver = (to: End, message: unknown) => {
    const copy = JSON.parse(JSON.stringify(message)) as unknown;
    setImmediate(() => {
      if (to.open) for (const handler of to.messages) handler(copy);
    });
  };
  const close = () => {
    for (const e of [h, g]) {
      if (!e.open) continue;
      e.open = false;
      for (const handler of e.closes) handler();
    }
  };
  const host: PeerChannelPort = {
    remoteKey: opts.guestKey,
    fingerprint,
    send: (message) => {
      if (!h.open) throw new Error('closed');
      deliver(g, message);
    },
    onMessage: (handler) => (h.messages.add(handler), () => h.messages.delete(handler)),
    onClose: (handler) => (h.closes.add(handler), () => h.closes.delete(handler)),
    close,
  };
  const guest: GuestChannelPort = {
    remoteKey: opts.hostKey ?? 'host-key',
    fingerprint,
    send: (message) => {
      if (!g.open) throw new Error('closed');
      deliver(h, message);
    },
    onMessage: (handler) => (g.messages.add(handler), () => g.messages.delete(handler)),
    onClose: (handler) => (g.closes.add(handler), () => g.closes.delete(handler)),
    onReconnected: (handler) => void reconnectedHandlers.add(handler),
    onHost: (handler) => void hostHandlers.add(handler),
    setSecret: (secret) => void (pair.secret = secret),
    close,
  };
  const pair: ChannelPair = {
    host,
    guest,
    secret: null as string | null,
    drop: close,
    hostPresent: (present) => hostHandlers.forEach((handler) => handler(present)),
    reconnected: () => reconnectedHandlers.forEach((handler) => handler()),
  };
  return pair;
}

/** Lets the asynchronous deliveries above run. */
export const settle = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};
