/**
 * A fake ComfyUI for the unit tests. `object-info.json` is a cut of a real server's `/object_info`, and the messages
 * below are its real wire shapes. File names are neutral, not the ones on that server.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageCapabilities } from '@atelier/protocol';
import { fakeFetch, jsonResponse } from '../../../../providers/__fixtures__/harness.ts';
import type { ProviderFetch } from '../../../../providers/types.ts';
import { HOSTED_DEFAULTS } from '../../../catalog.ts';
import type { ImageEvent, ImageInstance, ImageRequest, ImageSocket } from '../../../types.ts';
import type { ObjectInfo } from '../discovery.ts';
import type { Graph } from '../templates.ts';

export const fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(join(import.meta.dirname, name), 'utf8')) as T;

export const OBJECT_INFO = fixture<ObjectInfo>('object-info.json');
export const BASE = 'http://192.168.77.20:8188';
export const instance: ImageInstance = { id: 'comfy', type: 'comfyui', name: 'ComfyUI', baseUrl: BASE, headers: {}, models: [], workflows: [] };
/** A real, one pixel PNG. */
export const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

export const capabilities = (family: string, over: Partial<ImageCapabilities> = {}): ImageCapabilities => ({ ...HOSTED_DEFAULTS, family, tunable: true, ...over });

export const imageRequest = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  model: 'z_image_turbo_bf16.safetensors',
  prompt: 'a lighthouse',
  width: 1024,
  height: 1024,
  count: 1,
  quality: 'standard',
  references: [],
  tuning: {},
  loras: [],
  capabilities: capabilities('z-image'),
  signal: new AbortController().signal,
  ...over,
});

/** A socket a test feeds by hand. */
export class FakeSocket implements ImageSocket {
  private readonly items: (string | Uint8Array)[] = [];
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  closed = false;

  private notify(): void {
    this.wake?.();
    this.wake = null;
  }

  push(...items: (string | Uint8Array | object)[]): void {
    for (const item of items) this.items.push(typeof item === 'string' || item instanceof Uint8Array ? item : JSON.stringify(item));
    this.notify();
  }

  /** The connection closes. */
  end(): void {
    this.ended = true;
    this.notify();
  }

  fail(error = new Error('The connection failed.')): void {
    this.failure = error;
    this.notify();
  }

  send(): void {}

  close(): void {
    this.closed = true;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string | Uint8Array> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

export const IMAGE = { filename: 'ComfyUI_temp_rgyec_00001_.png', subfolder: '', type: 'temp', metadata: { kind: 'image', width: 1024, height: 1024 } };

export const message = {
  status: (remaining: number) => ({ type: 'status', data: { status: { exec_info: { queue_remaining: remaining } } } }),
  start: (id: string) => ({ type: 'execution_start', data: { prompt_id: id, timestamp: 1793585298282 } }),
  cached: (id: string, nodes: string[] = []) => ({ type: 'execution_cached', data: { nodes, prompt_id: id, timestamp: 1793585298283 } }),
  executing: (id: string, node: string | null) => ({ type: 'executing', data: { node, display_node: node, prompt_id: id } }),
  progressState: (id: string) => ({ type: 'progress_state', data: { prompt_id: id, nodes: {} } }),
  progress: (id: string, value: number, max: number, node: string) => ({ type: 'progress', data: { value, max, prompt_id: id, node } }),
  executed: (id: string, node: string, images: unknown[] = [IMAGE]) => ({ type: 'executed', data: { node, display_node: node, output: { images }, prompt_id: id } }),
  success: (id: string) => ({ type: 'execution_success', data: { prompt_id: id, timestamp: 1793585314899 } }),
  error: (id: string, over: Record<string, unknown> = {}) => ({ type: 'execution_error', data: { prompt_id: id, node_id: '8', node_type: 'KSampler', exception_message: 'Something broke', exception_type: 'RuntimeError', traceback: [], ...over } }),
  interrupted: (id: string) => ({ type: 'execution_interrupted', data: { prompt_id: id, node_id: '8', node_type: 'KSampler', executed: [] } }),
};

/** A preview frame: type, then format, then the image. */
export function previewFrame(format: number, image: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])): Uint8Array {
  const frame = new Uint8Array(8 + image.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, format);
  frame.set(image, 8);
  return frame;
}

/** A preview frame with metadata: type, its length, the JSON, then the image. */
export function metadataFrame(metadata: object, image: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const frame = new Uint8Array(8 + json.length + image.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 4);
  view.setUint32(4, json.length);
  frame.set(json, 8);
  frame.set(image, 8 + json.length);
  return frame;
}

const queueEntry = (number: number, id: string) => [number, id, {}, {}, ['9']];

export interface Server {
  fetch: ProviderFetch;
  calls: ReturnType<typeof fakeFetch>['calls'];
  /** Raw request bodies, for what isn't JSON. */
  bodies: { url: string; body: unknown }[];
  /** Set what `/queue` answers. */
  queue: { running: string[]; pending: string[] };
  /** The answer for `/history/<id>`. */
  history: Record<string, unknown>;
  promptId(): string;
  socket: FakeSocket;
}

export interface ServerOptions {
  /** Runs once the job is queued, with its id. */
  onPrompt?: (id: string, server: Server) => void;
  promptResponse?: (id: string) => Response;
  info?: ObjectInfo;
  routes?: Parameters<typeof fakeFetch>[0];
}

export function fakeServer({ onPrompt, promptResponse, info = OBJECT_INFO, routes = {} }: ServerOptions = {}): Server {
  let id = '';
  const nodes = Object.fromEntries(Object.entries(info).map(([name, entry]) => [`GET /object_info/${name}`, () => jsonResponse({ [name]: entry })]));
  const server: Server = {
    fetch: async () => new Response(),
    calls: [],
    bodies: [],
    queue: { running: [], pending: [] },
    history: {},
    promptId: () => id,
    socket: new FakeSocket(),
  };
  const { fetch, calls } = fakeFetch({
    ...nodes,
    'POST /prompt': (call) => {
      id = (call.body as { prompt_id: string }).prompt_id;
      queueMicrotask(() => onPrompt?.(id, server));
      return promptResponse ? promptResponse(id) : jsonResponse({ prompt_id: id, number: 1, node_errors: {} });
    },
    'GET /queue': () => jsonResponse({ queue_running: server.queue.running.map((p, i) => queueEntry(i, p)), queue_pending: server.queue.pending.map((p, i) => queueEntry(100 + i, p)) }),
    'POST /queue': () => jsonResponse({}),
    'POST /interrupt': () => new Response(null, { status: 200 }),
    'POST /free': () => new Response(null, { status: 200 }),
    'GET /view': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    'POST /upload/image': () => jsonResponse({ name: 'input-img_ab12cd34.png', subfolder: 'atelier', type: 'temp' }),
    'GET /system_stats': () => jsonResponse({ system: { comfyui_version: '0.43.0' }, devices: [] }),
    ...routes,
  });
  server.calls = calls;
  server.fetch = (url, init) => {
    server.bodies.push({ url, body: init.body });
    const path = new URL(url).pathname;
    if (path.startsWith('/history/')) return Promise.resolve(jsonResponse(server.history));
    // Anything for a node this server doesn't have gets the empty object a real one answers with.
    if (path.startsWith('/object_info/') && !info[path.slice('/object_info/'.length)]) return Promise.resolve(jsonResponse({}));
    return fetch(url, init);
  };
  return server;
}

/** The record of a job that finished, as `/history/<id>` keeps it. */
export const historyEntry = (id: string, node: string, messages: unknown[] = [['execution_start', { prompt_id: id }], ['execution_success', { prompt_id: id }]]) => ({
  [id]: { prompt: [1, id, {}, {}, [node]], outputs: { [node]: { images: [IMAGE] } }, status: { status_str: 'success', completed: true, messages }, meta: {} },
});

export async function collectEvents(events: AsyncIterable<ImageEvent>): Promise<ImageEvent[]> {
  const out: ImageEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** What the sent graph was. */
export const sentGraph = (server: Server): Graph => (server.calls.find((c) => c.url.endsWith('/prompt'))?.body as { prompt: Graph }).prompt;

export const nodesOf = (graph: Graph, classType: string) => Object.values(graph).filter((n) => n.class_type === classType);

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

/**
 * Everything ComfyUI's own validation checks before it queues a job: the node exists, required inputs are there, links
 * point at a node with an output of the right type, and values are of the right type and inside their limits.
 */
export function validateGraph(graph: Graph, info: ObjectInfo = OBJECT_INFO): string[] {
  const problems: string[] = [];
  for (const [id, node] of Object.entries(graph)) {
    const entry = info[node.class_type] as { input: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> }; output: string[] } | undefined;
    if (!entry) {
      problems.push(`${id}: no node ${node.class_type}`);
      continue;
    }
    const specs = { ...entry.input.required, ...entry.input.optional };
    for (const name of Object.keys(entry.input.required ?? {})) if (node.inputs[name] === undefined) problems.push(`${id} ${node.class_type}: missing ${name}`);
    for (const [name, value] of Object.entries(node.inputs)) {
      const spec = specs[name];
      if (!spec) {
        problems.push(`${id} ${node.class_type}: no input ${name}`);
        continue;
      }
      const options = (spec[0] === 'COMBO' ? (spec[1] as { options: string[] }).options : Array.isArray(spec[0]) ? (spec[0] as string[]) : null) as string[] | null;
      const type = options ? 'COMBO' : (spec[0] as string);
      const limits = (spec[1] ?? {}) as { min?: number; max?: number; image_upload?: boolean };
      if (Array.isArray(value)) {
        const source = graph[String(value[0])];
        const sourceType = source ? (info[source.class_type] as { output: string[] } | undefined)?.output[value[1] as number] : undefined;
        if (!source) problems.push(`${id} ${node.class_type}.${name}: link to missing node ${String(value[0])}`);
        else if (sourceType !== type) problems.push(`${id} ${node.class_type}.${name}: wants ${type}, gets ${sourceType} from ${source.class_type}`);
        continue;
      }
      if (!WIDGET_TYPES.has(type)) problems.push(`${id} ${node.class_type}.${name}: ${type} needs a link`);
      if (options && !limits.image_upload && !options.includes(value as string)) problems.push(`${id} ${node.class_type}.${name}: ${String(value)} isn't an option`);
      if ((type === 'INT' || type === 'FLOAT') && (typeof value !== 'number' || (limits.min !== undefined && value < limits.min) || (limits.max !== undefined && value > limits.max))) problems.push(`${id} ${node.class_type}.${name}: ${String(value)} is out of range`);
      if (type === 'INT' && !Number.isInteger(value)) problems.push(`${id} ${node.class_type}.${name}: ${String(value)} isn't whole`);
    }
  }
  return problems;
}
