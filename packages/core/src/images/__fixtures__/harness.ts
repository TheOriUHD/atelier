/** What the dialect tests share: a request, a socket that plays back what a server said, and tiny real image bytes. */
import { fakeFetch } from '../../providers/__fixtures__/harness.ts';
import { toBase64 } from '../../providers/util.ts';
import type { ImageCapabilities, ImageProviderType } from '@atelier/protocol';
import { HOSTED_DEFAULTS } from '../catalog.ts';
import type { ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ImageSocket } from '../types.ts';

/** A PNG header of this size, which is all `imageSize` and `sniffMime` read. */
export function pngOf(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

export const PNG = pngOf(8, 8);
export const PNG_B64 = toBase64(PNG);
export const JPEG_B64 = toBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]));
export const WEBP_B64 = toBase64(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]));

export function imageInstance(type: ImageProviderType, preset: string | undefined, baseUrl = 'http://127.0.0.1:7860', over: Partial<ImageInstance> = {}): ImageInstance {
  return { id: 'img', type, name: 'Server', baseUrl, headers: {}, models: [], workflows: [], ...(preset ? { preset } : {}), ...over };
}

const capabilities: ImageCapabilities = { ...HOSTED_DEFAULTS, sizes: { kind: 'free', min: 256, max: 2048, multiple: 8, base: 512 }, maxCount: 4, edit: true, mask: true, maxReferences: 1, tunable: true, seed: true };

export function imageRequest(over: Partial<ImageRequest> = {}): ImageRequest {
  return { model: 'model', prompt: 'a red fox', width: 512, height: 768, count: 1, quality: 'standard', references: [], tuning: {}, loras: [], capabilities, signal: new AbortController().signal, ...over };
}

export async function drain(events: AsyncIterable<ImageEvent>): Promise<ImageEvent[]> {
  const out: ImageEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

export function finishOf(events: ImageEvent[]): Extract<ImageEvent, { type: 'finish' }> {
  const finishes = events.filter((e): e is Extract<ImageEvent, { type: 'finish' }> => e.type === 'finish');
  if (finishes.length !== 1) throw new Error(`expected exactly one finish, got ${finishes.length}`);
  if (events.at(-1)?.type !== 'finish') throw new Error('finish is not the last event');
  return finishes[0]!;
}

export const imagesOf = (events: ImageEvent[]) => events.filter((e): e is Extract<ImageEvent, { type: 'image' }> => e.type === 'image');

export interface FakeSocket extends ImageSocket {
  sent: string[];
  closed: boolean;
  url: string;
}

/** A socket that hands over `messages` once something was sent, then stays open if `stayOpen` says so, as a real one does until stopped. */
export function fakeSocket(messages: readonly (string | Record<string, unknown>)[], options: { stayOpen?: AbortSignal; url?: string } = {}): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    closed: false,
    url: options.url ?? '',
    send(text) {
      socket.sent.push(text);
    },
    close() {
      socket.closed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield typeof message === 'string' ? message : new TextEncoder().encode(JSON.stringify(message));
      const stayOpen = options.stayOpen;
      if (stayOpen && !stayOpen.aborted) await new Promise((resolve) => stayOpen.addEventListener('abort', resolve, { once: true }));
    },
  };
  return socket;
}

export function adapterDeps(routes: Parameters<typeof fakeFetch>[0], socket?: (url: string, signal: AbortSignal) => Promise<ImageSocket>): { deps: ImageAdapterDeps; calls: ReturnType<typeof fakeFetch>['calls'] } {
  const { fetch, calls } = fakeFetch(routes);
  return { calls, deps: { fetch, socket: socket ?? (() => Promise.reject(new Error('no socket in this test'))) } };
}

/** A response that answers only when released: a blocking `txt2img` that polling runs beside. */
export function held(): { promise: Promise<Response>; release(res: Response): void } {
  let release!: (res: Response) => void;
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { promise, release };
}
