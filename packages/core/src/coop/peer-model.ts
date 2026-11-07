/**
 * A co-op guest's own model, as the host's runs use it (ARCHITECTURE §24). Its ref is `peer-<keyId>/<their ref>`: the
 * host's run builds each request as usual and sends it to the guest's computer, which runs it with its own provider and
 * keys and streams the events back. Nothing falls back to the host's models: when the guest is offline, the turn fails.
 *
 * The other side is `servePeer` (gateway.ts) on the guest's computer.
 */
import { randomUUID } from 'node:crypto';
import { parsePeerModelRef, PeerContract, type ModelInfo, type PeerChatRequest, type RpcClient } from '@atelier/protocol';
import { ModelUnavailableError, type ModelResolver, type ResolvedModel } from '../agent/chat-service.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent } from '../providers/types.ts';
import type { Message } from '@atelier/protocol';

export type PeerLookup = (keyId: string) => RpcClient<typeof PeerContract> | null;

/** Thinking a guest's model wrote is kept under this provider name: no other model ever gets its replay data. */
export const peerProviderType = (keyId: string): string => `peer-${keyId}`;
/** In a request to the guest, the thinking their own model wrote: their computer puts its adapter's type back. */
export const PEER_SELF = '@self';

/**
 * Replay data (signatures, encrypted reasoning) belongs to the account that made it: the guest's computer gets only
 * what its own model wrote, as `@self`; the host's and other guests' thinking goes as plain text without it.
 */
export function peerMessages(messages: Message[], selfType: string): Message[] {
  return messages.map((m) =>
    m.role !== 'assistant' || !m.parts.some((p) => p.type === 'thinking')
      ? m
      : {
          ...m,
          parts: m.parts.map((p) => {
            if (p.type !== 'thinking') return p;
            if (p.provider === selfType) return { ...p, provider: PEER_SELF };
            const { replay: _replay, provider: _provider, ...rest } = p;
            return rest;
          }),
        },
  ) as Message[];
}

/** The request as it goes over the channel: without its signal and queue (the guest's own scheduler runs it). */
export function toPeerRequest(request: ChatRequest, ref: string, selfType: string): PeerChatRequest {
  return {
    model: ref,
    system: request.system.map((b) => ({ text: b.text, ...(b.cache ? { cache: true } : {}) })),
    messages: peerMessages(request.messages, selfType),
    ...(request.tools ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } : {}),
    ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
    maxOutputTokens: request.maxOutputTokens,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.contextLength !== undefined ? { contextLength: request.contextLength } : {}),
  };
}

/** Streams one request on the guest's computer: `model.event`s for this stream until `model.stream` returns. */
export function peerAdapter(peer: RpcClient<typeof PeerContract>, keyId: string, innerRef: string): ProviderAdapter {
  const type = peerProviderType(keyId);
  return {
    // Not one of the provider types: thinking stored under it is replayed to this guest's model only (loop.ts).
    type: type as ProviderAdapter['type'],
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: null, warnings: [] }),
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      const streamId = randomUUID();
      const queue: StreamEvent[] = [];
      let wake: (() => void) | null = null;
      let done = false;
      let failure: unknown = null;
      const push = () => {
        wake?.();
        wake = null;
      };
      const off = peer.on('model.event', ({ streamId: id, event }) => {
        if (id !== streamId) return;
        queue.push(event as StreamEvent);
        push();
      });
      const abort = () => void peer.call('model.cancel', { streamId }).catch(() => undefined);
      request.signal.addEventListener('abort', abort, { once: true });
      void peer
        .call('model.stream', { streamId, request: toPeerRequest(request, innerRef, type) }, { signal: request.signal })
        .then(
          () => undefined,
          (e: unknown) => void (failure = e),
        )
        .finally(() => {
          done = true;
          push();
        });
      let finished = false;
      try {
        for (;;) {
          while (queue.length) {
            const event = queue.shift()!;
            if (event.type === 'finish') finished = true;
            yield event;
            if (finished) return;
          }
          if (done) break;
          await new Promise<void>((resolve) => (wake = resolve));
        }
        if (request.signal.aborted) {
          yield { type: 'finish', reason: 'aborted' } as StreamEvent;
          return;
        }
        // The guest's computer went away mid-reply, or refused: the turn fails with that, never on the host's models.
        const message = failure instanceof Error ? failure.message : 'The guest’s computer stopped answering.';
        yield { type: 'finish', reason: 'error', error: { code: 'peer_offline', message: `Their model didn’t answer: ${message}` } } as StreamEvent;
      } finally {
        off();
        request.signal.removeEventListener('abort', abort);
      }
    },
  };
}

/**
 * The host's model resolver with guests' models added: `peer-…` refs go to that guest's computer while they are
 * connected; every other ref is the base resolver's.
 */
export function withPeerModels(base: ModelResolver, peerOf: PeerLookup): ModelResolver {
  const described = new Map<string, { info: ModelInfo; at: number }>();
  // The base is a class (ProviderRegistry): its methods are delegated one by one, a spread would lose them.
  const resolver: ModelResolver = {
    firstAvailable: () => base.firstAvailable(),
    resolve: async (ref, userId): Promise<ResolvedModel> => {
      const parsed = parsePeerModelRef(ref);
      if (!parsed) return base.resolve(ref, userId);
      const peer = peerOf(parsed.keyId);
      if (!peer) throw new ModelUnavailableError('Their computer isn’t connected right now, so their model can’t answer.');
      let cached = described.get(ref);
      if (!cached || Date.now() - cached.at > 5 * 60_000) {
        const info = await peer.call('model.describe', { ref: parsed.ref }).catch((e: unknown) => {
          throw new ModelUnavailableError(`Their model isn’t available: ${e instanceof Error ? e.message : String(e)}`);
        });
        // It is their model on their computer: never one of the host's own, never hidden from its user.
        cached = { info: { ...info, ref, providerId: `peer-${parsed.keyId}`, modelId: parsed.ref, hidden: false, personal: undefined } as ModelInfo, at: Date.now() };
        described.set(ref, cached);
      }
      return { adapter: peerAdapter(peer, parsed.keyId, parsed.ref), info: cached.info };
    },
  };
  if (base.listModels) resolver.listModels = (userId) => base.listModels!(userId);
  if (base.assertVisible) resolver.assertVisible = (ref, userId) => (parsePeerModelRef(ref) ? Promise.resolve() : base.assertVisible!(ref, userId));
  if (base.avoidSwap) resolver.avoidSwap = (ref, current) => (parsePeerModelRef(ref) ? ref : base.avoidSwap!(ref, current));
  if (base.agentTurn) resolver.agentTurn = (ref, signal, onWait, userId) => (parsePeerModelRef(ref) ? Promise.resolve(() => undefined) : base.agentTurn!(ref, signal, onWait, userId));
  return resolver;
}
