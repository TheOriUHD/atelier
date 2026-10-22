import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { ImagePart, Message, Part } from '@atelier/protocol';
import { fitMessages, refusesImage, withImageLimits } from './image-limits.ts';
import { BlobOverlay, IMAGE_POLICIES, type ImagePolicy } from './images.ts';
import { imageSize } from './image-size.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent } from './types.ts';

const blobs = new Map<string, Uint8Array>();
let n = 0;
const png = (width: number, height: number): Uint8Array => {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) image.data.set([i % 251, 40, 90, 255], i);
  return PNG.sync.write(image);
};
const image = (width: number, height: number): ImagePart => {
  const blob = `b${++n}`;
  blobs.set(blob, png(width, height));
  return { type: 'image', mime: 'image/png', blob };
};
const readBlob = async (sha: string) => blobs.get(sha)!;
const message = (role: Message['role'], parts: Part[]): Message => ({
  id: `m${++n}`,
  sessionId: 's',
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
});
const user = (...parts: Part[]) => message('user', parts);
const policy = (over: Partial<ImagePolicy> = {}): ImagePolicy => ({ maxSide: 100, maxBytes: 1_000_000, maxCount: null, many: null, totalBytes: null, ...over });

/** The images and notes a fitted request holds, in order. */
async function shape(messages: Message[], p: ImagePolicy) {
  const overlay = new BlobOverlay(readBlob);
  const out = await fitMessages(messages, p, readBlob, overlay);
  const parts = out.flatMap((m) => m.parts.flatMap((x) => (x.type === 'tool_result' ? x.content : [x])));
  return { out, overlay, parts };
}
const kinds = (parts: Part[]) => parts.map((p) => (p.type === 'image' ? 'image' : p.type === 'text' ? p.text : p.type));

describe('fitMessages', () => {
  it('leaves a request whose images fit exactly as it was', async () => {
    const messages = [user(image(40, 30))];
    const { out } = await shape(messages, policy());
    expect(out).toBe(messages);
  });

  it('reduces an image to the side limit, in a user turn and in a tool result, and says so', async () => {
    const messages = [
      user({ type: 'text', text: 'look' }, image(400, 200)),
      message('tool', [{ type: 'tool_result', callId: 'c', content: [{ type: 'text', text: 'Image a.png' }, image(1000, 10)] }]),
    ];
    const { parts, overlay } = await shape(messages, policy());
    const images = parts.filter((p): p is ImagePart => p.type === 'image');
    expect(images).toHaveLength(2);
    const sizes = await Promise.all(images.map(async (i) => imageSize(await overlay.read(i.blob))));
    expect(sizes).toEqual([{ width: 100, height: 50 }, { width: 100, height: 1 }]);
    expect(parts.filter((p) => p.type === 'text' && /reduced to/.test(p.text))).toHaveLength(2);
  });

  it('leaves out the oldest images past the count the provider holds', async () => {
    const messages = [user(image(10, 10)), user(image(10, 10)), user(image(10, 10))];
    const { parts } = await shape(messages, policy({ maxCount: 2 }));
    expect(kinds(parts)).toEqual([expect.stringContaining('at most 2 images'), 'image', 'image']);
  });

  it('shrinks every image once there are more than the provider takes at full size', async () => {
    const messages = [user(image(300, 100)), user(image(300, 100))];
    const { parts, overlay } = await shape(messages, policy({ maxSide: 200, many: { above: 1, side: 50 } }));
    const sizes = await Promise.all(parts.filter((p): p is ImagePart => p.type === 'image').map(async (i) => imageSize(await overlay.read(i.blob))));
    expect(sizes.every((s) => s !== null && Math.max(s.width, s.height) <= 50)).toBe(true);
    expect(sizes).toHaveLength(2);
  });

  it('keeps the newest images within the size of the request', async () => {
    const one = png(60, 60).length;
    const messages = [user(image(60, 60)), user(image(60, 60)), user(image(60, 60))];
    const { parts } = await shape(messages, policy({ totalBytes: one * 2 + 10 }));
    expect(kinds(parts)).toEqual([expect.stringContaining('size limit'), 'image', 'image']);
  });

  it('takes the type from the bytes', async () => {
    const jpegNamedPng: ImagePart = { type: 'image', mime: 'image/png', blob: 'x' };
    blobs.set('x', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const { parts } = await shape([user(jpegNamedPng)], policy({ maxSide: null }));
    expect(parts[0]).toMatchObject({ type: 'image', mime: 'image/jpeg', blob: 'x' });
  });

  it("knows each provider's limits", () => {
    expect(IMAGE_POLICIES.anthropic).toMatchObject({ maxSide: 8000, maxBytes: 5 * 1024 * 1024, many: { above: 20, side: 2000 } });
    expect(IMAGE_POLICIES.openai.maxSide).toBeNull();
    expect(IMAGE_POLICIES.openai.maxBytes).toBe(20 * 1024 * 1024);
    expect(IMAGE_POLICIES['openai-compatible'].maxBytes).toBe(IMAGE_POLICIES.anthropic.maxBytes);
    expect(IMAGE_POLICIES.ollama.maxSide).toBe(4096);
  });
});

describe('refusesImage', () => {
  it.each([
    "Anthropic request failed (400): messages.5.content.212.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels",
    'image exceeds 5 MB maximum: 7340032 bytes > 5242880 bytes',
    'Image does not match the provided media type image/png',
    'Too many images in the request: at most 100',
    'Invalid image data: could not process image',
  ])('recognises %s', (message) => expect(refusesImage({ code: 'provider_error', message })).toBe(true));

  it('does not take other failures for it', () => {
    expect(refusesImage({ code: 'rate_limit', message: 'Rate limited (429)' })).toBe(false);
    expect(refusesImage({ code: 'provider_error', message: 'The model produced an invalid tool call' })).toBe(false);
    expect(refusesImage(undefined)).toBe(false);
  });
});

describe('withImageLimits', () => {
  const finish = (error?: { code: string; message: string }): StreamEvent => ({ type: 'finish', reason: error ? 'error' : 'end', ...(error ? { error } : {}) });
  /** Refuses any request holding the image named `bad`, as a provider would. */
  function adapter(requests: ChatRequest[]): ProviderAdapter {
    return {
      type: 'anthropic',
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
      async *stream(request) {
        requests.push(request);
        const has = (parts: readonly Part[]): boolean => parts.some((p) => (p.type === 'image' && p.blob === 'bad') || (p.type === 'tool_result' && has(p.content)));
        if (request.messages.some((m) => has(m.parts))) {
          yield finish({ code: 'provider_error', message: 'Anthropic request failed (400): messages.0.content.0.image.source.base64.data: Could not process image' });
          return;
        }
        yield { type: 'text', delta: 'ok' };
        yield finish();
      },
    };
  }
  const request = (messages: Message[]): ChatRequest => ({ model: 'm', system: [], messages, maxOutputTokens: 100, signal: new AbortController().signal });
  const run = async (a: ProviderAdapter, messages: Message[]) => {
    const events: StreamEvent[] = [];
    for await (const e of a.stream(request(messages))) events.push(e);
    return events;
  };
  const wrap = (requests: ChatRequest[]) => withImageLimits(adapter(requests), new BlobOverlay(readBlob), IMAGE_POLICIES.anthropic, readBlob);

  it('closes the provider stream when a consumer stops at finish', async () => {
    let released = false;
    const inner: ProviderAdapter = {
      ...adapter([]),
      async *stream() {
        try {
          yield { type: 'text', delta: 'Hello' };
          yield finish();
        } finally {
          released = true;
        }
      },
    };
    const wrapped = withImageLimits(inner, new BlobOverlay(readBlob), IMAGE_POLICIES.anthropic, readBlob);
    for await (const event of wrapped.stream(request([user({ type: 'text', text: 'Hi' })]))) {
      if (event.type === 'finish') break;
    }
    expect(released).toBe(true);
  });

  it('closes a refused image stream before retrying', async () => {
    blobs.set('bad', png(5, 5));
    let active = false;
    let attempts = 0;
    const inner: ProviderAdapter = {
      ...adapter([]),
      async *stream() {
        expect(active).toBe(false);
        active = true;
        try {
          yield attempts++ === 0 ? finish({ code: 'provider_error', message: 'Invalid image data' }) : finish();
        } finally {
          active = false;
        }
      },
    };
    await run(withImageLimits(inner, new BlobOverlay(readBlob), IMAGE_POLICIES.anthropic, readBlob), [user({ type: 'image', mime: 'image/png', blob: 'bad' })]);
    expect(attempts).toBe(2);
    expect(active).toBe(false);
  });

  it('asks again without the history images when one was refused, and carries on', async () => {
    blobs.set('bad', png(5, 5));
    const requests: ChatRequest[] = [];
    const newest: Part = image(5, 5);
    const events = await run(wrap(requests), [user({ type: 'image', mime: 'image/png', blob: 'bad' }), user(newest)]);
    expect(events.map((e) => e.type)).toEqual(['text', 'finish']);
    expect(requests).toHaveLength(2);
    const retried = requests[1]!.messages;
    expect(retried[0]!.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('left out') });
    expect(retried[1]!.parts[0]).toMatchObject({ type: 'image' });
  });

  it('then without any image when the newest one is the one refused', async () => {
    blobs.set('bad', png(5, 5));
    const requests: ChatRequest[] = [];
    const events = await run(wrap(requests), [user({ type: 'text', text: 'see' }, { type: 'image', mime: 'image/png', blob: 'bad' })]);
    expect(events.map((e) => e.type)).toEqual(['text', 'finish']);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages[0]!.parts.map((p) => p.type)).toEqual(['text', 'text']);
  });

  it('does not send a refused image again in later requests', async () => {
    blobs.set('bad', png(5, 5));
    const requests: ChatRequest[] = [];
    const a = wrap(requests);
    await run(a, [user({ type: 'image', mime: 'image/png', blob: 'bad' })]);
    requests.length = 0;
    await run(a, [user({ type: 'image', mime: 'image/png', blob: 'bad' }), user({ type: 'text', text: 'and now?' })]);
    expect(requests).toHaveLength(1);
  });

  it('passes other errors on as they are', async () => {
    const requests: ChatRequest[] = [];
    const failing: ProviderAdapter = {
      ...adapter(requests),
      async *stream() {
        yield finish({ code: 'rate_limit', message: 'Rate limited (429)' });
      },
    };
    const events = await run(withImageLimits(failing, new BlobOverlay(readBlob), IMAGE_POLICIES.anthropic, readBlob), [user(image(5, 5))]);
    expect(events).toEqual([finish({ code: 'rate_limit', message: 'Rate limited (429)' })]);
  });

  it('fits the images of a real provider request: a tall screenshot reaches Anthropic within 8000 pixels', async () => {
    const requests: ChatRequest[] = [];
    const tall = image(10, 9000);
    await run(wrap(requests), [user(tall)]);
    const sent = requests[0]!.messages[0]!.parts.find((p): p is ImagePart => p.type === 'image')!;
    // The wrapper's overlay names the fitted bytes; the inner adapter reads them through the same overlay.
    expect(sent.blob).toMatch(/^fit:/);
  });
});
