import { describe, expect, it } from 'vitest';
import { streamResponse } from './__fixtures__/harness.ts';
import { splitLines } from './lines.ts';
import { parseNDJSON } from './ndjson.ts';
import { parseSSE, type SseEvent } from './sse.ts';

async function events(text: string, chunkSize: number): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of parseSSE(streamResponse(text, { chunkSize }).body!)) out.push(e);
  return out;
}

const FIXTURE =
  ': keep-alive comment\r\n' +
  'event: message_start\r\n' +
  'data: {"a":1}\r\n' +
  '\r\n' +
  'id: 7\n' +
  'data: line one\n' +
  'data:line two\n' +
  '\n' +
  'event: ping\n' +
  'data: {}\n' +
  '\n';

describe('parseSSE', () => {
  it.each([1, 2, 3, 5, 13, 1000])('parses events regardless of chunk boundaries (size %i)', async (size) => {
    expect(await events(FIXTURE, size)).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: 'message', data: 'line one\nline two', id: '7' },
      { event: 'ping', data: '{}', id: '7' },
    ]);
  });

  it('stops at [DONE] and ignores anything after it', async () => {
    const text = 'data: {"x":1}\n\ndata: [DONE]\n\ndata: {"x":2}\n\n';
    expect((await events(text, 4)).map((e) => e.data)).toEqual(['{"x":1}']);
  });

  it('accepts lone CR terminators and a final event without a blank line', async () => {
    expect(await events('data: a\r\rdata: b', 1)).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const [event] = await events('data: {"t":"héllo 🌍"}\n\n', 1);
    expect(JSON.parse(event!.data)).toEqual({ t: 'héllo 🌍' });
  });

  it('throws an AbortError once the signal aborts', async () => {
    const controller = new AbortController();
    const res = streamResponse('data: 1\n\n', { hangUntil: controller.signal });
    const seen: string[] = [];
    const run = (async () => {
      for await (const e of parseSSE(res.body!, controller.signal)) {
        seen.push(e.data);
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['1']);
  });

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _event of parseSSE(body)) break;
    expect(cancelled).toBe(true);
  });
});

describe('splitLines', () => {
  it('holds back a trailing CR until it knows whether LF follows', () => {
    expect(splitLines('a\r', false)).toEqual({ lines: [], rest: 'a\r' });
    expect(splitLines('a\r\nb', false)).toEqual({ lines: ['a'], rest: 'b' });
    expect(splitLines('a\r', true)).toEqual({ lines: ['a'], rest: '' });
  });
});

describe('parseNDJSON', () => {
  it('parses objects across partial chunks, CRLF and a trailing line without newline', async () => {
    const text = '{"a":1}\r\n\n{"b":"x\\ny"}\nnot json\n{"c":[1,2]}';
    for (const size of [1, 3, 64]) {
      const out: unknown[] = [];
      for await (const v of parseNDJSON(streamResponse(text, { chunkSize: size }).body!)) out.push(v);
      expect(out).toEqual([{ a: 1 }, { b: 'x\ny' }, { c: [1, 2] }]);
    }
  });
});
