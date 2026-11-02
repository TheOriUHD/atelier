/** What the dialect tests share: a request, an instance, and a way to read back multipart bodies. No network. */
import type { ImageProviderType } from '@atelier/protocol';
import { collect, fakeFetch, jsonResponse } from '../../../providers/__fixtures__/harness.ts';
import type { ProviderFetch } from '../../../providers/types.ts';
import { HOSTED_DEFAULTS } from '../../catalog.ts';
import type { ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../../types.ts';

export { fakeFetch, jsonResponse };
export const KEY = 'sk-test-SECRET-key-123456';
/** 1×1 red PNG. */
export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
export const PNG = new Uint8Array(Buffer.from(PNG_B64, 'base64'));
export const INPUT = { bytes: PNG, mime: 'image/png', name: 'input.png' };

export const instance = (type: ImageProviderType, baseUrl: string, over: Partial<ImageInstance> = {}): ImageInstance => ({ id: 'img', type, name: 'Service', baseUrl, apiKey: KEY, headers: {}, models: [], workflows: [], ...over });

export const request = (over: Partial<ImageRequest> = {}): ImageRequest => ({ model: 'm', prompt: 'a red lighthouse', count: 1, quality: 'standard', references: [], tuning: {}, loras: [], capabilities: HOSTED_DEFAULTS, signal: new AbortController().signal, ...over });

export const deps = (fetch: ProviderFetch): ImageAdapterDeps => ({ fetch, socket: () => Promise.reject(new Error('no sockets here')) });

export const events = (stream: AsyncIterable<ImageEvent>) => collect(stream as never) as unknown as Promise<ImageEvent[]>;

export const finishOf = (list: ImageEvent[]) => {
  const finishes = list.filter((e) => e.type === 'finish');
  if (finishes.length !== 1 || list.at(-1)?.type !== 'finish') throw new Error(`expected one finish, last: ${JSON.stringify(list.at(-1))}`);
  return finishes[0]!;
};

export const imagesOf = (list: ImageEvent[]) => list.filter((e) => e.type === 'image');

/** A signal already fired, which `fakeFetch` answers the way fetch does. */
export const stopped = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

/** Keeps each request's raw body, which `fakeFetch` drops unless it's JSON. */
export function keepingBodies(fetch: ProviderFetch) {
  const bodies: Uint8Array[] = [];
  const wrapped: ProviderFetch = (input, init) => {
    if (init.body instanceof Uint8Array) bodies.push(init.body);
    return fetch(input, init);
  };
  return { fetch: wrapped, bodies };
}

/** A multipart body as `name → value`, with files as `file:<their name>`; a repeated name collects into a list. */
export function formFields(body: Uint8Array): Record<string, string | string[]> {
  const text = Buffer.from(body).toString('latin1');
  const boundary = text.slice(0, text.indexOf('\r\n'));
  const out: Record<string, string | string[]> = {};
  for (const part of text.split(boundary).slice(1, -1)) {
    const name = /name="([^"]*)"/.exec(part)?.[1] ?? '';
    const filename = /filename="([^"]*)"/.exec(part)?.[1];
    const value = filename ? `file:${filename}` : part.slice(part.indexOf('\r\n\r\n') + 4, -2);
    const had = out[name];
    out[name] = had === undefined ? value : [...(Array.isArray(had) ? had : [had]), value];
  }
  return out;
}
