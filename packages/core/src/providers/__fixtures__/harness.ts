/**
 * Test harness: a fake `deps.fetch` that routes by method + path, records request bodies, and replays recorded
 * stream fixtures split into small byte chunks (to exercise partial-line parsing). No network.
 */
import type { Message, Part, ProviderType } from '@atelier/protocol';
import type { AdapterDeps, ChatRequest, ProviderFetch, ProviderInstance, StreamEvent } from '../types.ts';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: RecordedCall, signal: AbortSignal | null) => Response | Promise<Response>;

/** Routes are keyed `METHOD /path` (with or without the query string). */
export function fakeFetch(routes: Record<string, Responder>): { fetch: ProviderFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: ProviderFetch = async (input, init) => {
    const signal = init.signal ?? null;
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: RecordedCall = { url: input, method, headers, body };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
    if (!route) return new Response('not found', { status: 404 });
    return route(call, signal);
  };
  return { fetch, calls };
}

export function offlineFetch(): ProviderFetch {
  return async () => {
    throw new TypeError('fetch failed');
  };
}

export interface StreamOptions {
  chunkSize?: number;
  status?: number;
  /** After the fixture, keep the body open until `signal` aborts (simulates a stalled stream). */
  hangUntil?: AbortSignal | null;
}

export function streamResponse(text: string, options: StreamOptions = {}): Response {
  const bytes = new TextEncoder().encode(text);
  const size = options.chunkSize ?? 7;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
        return;
      }
      const signal = options.hangUntil;
      if (!signal) {
        controller.close();
        return;
      }
      return new Promise<void>((resolve) => {
        const fail = (): void => {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          resolve();
        };
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    },
  });
  return new Response(stream, { status: options.status ?? 200 });
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** Serialize SSE events; `event` adds an `event:` line (Anthropic style). */
export function sse(events: { event?: string; data: unknown }[], done = false): string {
  const lines = events.map(({ event, data }) => {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
  });
  return lines.join('') + (done ? 'data: [DONE]\n\n' : '');
}

export function ndjson(values: unknown[]): string {
  return values.map((v) => `${JSON.stringify(v)}\n`).join('');
}

export async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

export function textOf(events: StreamEvent[]): string {
  return events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
}

export function thinkingOf(events: StreamEvent[]): string {
  return events.map((e) => (e.type === 'thinking' ? e.delta : '')).join('');
}

export function finishOf(events: StreamEvent[]): Extract<StreamEvent, { type: 'finish' }> {
  const finishes = events.filter((e): e is Extract<StreamEvent, { type: 'finish' }> => e.type === 'finish');
  if (finishes.length !== 1) throw new Error(`expected exactly one finish, got ${finishes.length}`);
  if (events.at(-1)?.type !== 'finish') throw new Error('finish is not the last event');
  return finishes[0]!;
}

export function usageOf(events: StreamEvent[]): Extract<StreamEvent, { type: 'usage' }>['usage'] | undefined {
  const usage = events.filter((e) => e.type === 'usage').at(-1);
  return usage?.type === 'usage' ? usage.usage : undefined;
}

let nextId = 0;
export function message(role: Message['role'], parts: Part[]): Message {
  return {
    id: `m${++nextId}`,
    sessionId: 's1',
    parentId: null,
    role,
    parts,
    model: null,
    usage: null,
    stopReason: null,
    error: null,
    kind: 'normal',
    summarizesThroughId: null,
    createdAt: 0,
  };
}

export function userText(text: string): Message {
  return message('user', [{ type: 'text', text }]);
}

export function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'test-model',
    system: [{ text: 'You are helpful.' }],
    messages: [userText('Hello')],
    maxOutputTokens: 4096,
    signal: new AbortController().signal,
    ...overrides,
  };
}

export const API_KEY = 'sk-test-SECRET-key-123456';

export function providerInstance(type: ProviderType, baseUrl: string, apiKey?: string): ProviderInstance {
  return { id: `${type}-1`, type, name: `Test ${type}`, baseUrl, headers: {}, ...(apiKey ? { apiKey } : {}) };
}

/** Blob store with a 4-byte "PNG" and a short PDF. */
export const BLOBS: Record<string, Uint8Array> = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  pdf: new TextEncoder().encode('%PDF-1.7'),
  txt: new TextEncoder().encode('hello from a file'),
};

export function deps(fetch: ProviderFetch): AdapterDeps {
  return {
    fetch,
    readBlob: async (sha) => {
      const blob = BLOBS[sha];
      if (!blob) throw new Error(`missing blob ${sha}`);
      return blob;
    },
  };
}
