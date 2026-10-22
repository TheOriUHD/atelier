/**
 * Server-Sent Events parser (WHATWG event-stream rules) over a fetch body.
 * Handles comments, multi-line `data:`, CRLF, chunks split anywhere, and the OpenAI-style `[DONE]` sentinel.
 */
import { readLines } from './lines.ts';

export interface SseEvent {
  /** `event:` field, `message` when absent. */
  event: string;
  data: string;
  id?: string;
}

export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  let event = '';
  let id: string | undefined;
  let data: string[] = [];
  let hasData = false;

  const take = (): SseEvent => {
    const out: SseEvent = { event: event || 'message', data: data.join('\n') };
    if (id !== undefined) out.id = id;
    event = '';
    data = [];
    hasData = false;
    return out;
  };

  for await (const line of readLines(body, signal)) {
    if (line === '') {
      if (!hasData) {
        event = '';
        continue;
      }
      const out = take();
      if (out.data === '[DONE]') return;
      yield out;
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      data.push(value);
      hasData = true;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'id') {
      id = value;
    }
  }
  // Lenient: dispatch a final event that was not followed by a blank line.
  if (hasData) {
    const out = take();
    if (out.data !== '[DONE]') yield out;
  }
}
