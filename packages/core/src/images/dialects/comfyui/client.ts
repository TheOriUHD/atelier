/**
 * ComfyUI's HTTP routes and its socket. There's no sign-in by default, but a reverse proxy may ask for one, so a key and
 * custom headers go along when they're set.
 */
import { bearer, httpError, ProviderHttpError, requestJson } from '../../../providers/http.ts';
import { arr, num, rec, str } from '../../../providers/util.ts';
import { multipart } from '../../multipart.ts';
import type { ImageAdapterDeps, ImageInput, ImageInstance, ImageSocket } from '../../types.ts';

export interface ComfyImage {
  filename: string;
  subfolder: string;
  type: string;
}

export interface QueueState {
  running: string[];
  /** In the order they'll run. */
  pending: string[];
}

export type Submission = { ok: true; warnings: unknown } | { ok: false; body: unknown };

/** Input images go in a folder of their own in ComfyUI's temp, which it empties on restart, so its input folder stays the person's. */
const UPLOAD_FOLDER = 'atelier';

/** Queue entries are `[number, prompt_id, ...]`. */
const promptIds = (entries: unknown): string[] =>
  arr(entries)
    .map((e) => (Array.isArray(e) ? { order: num(e[0]) ?? 0, id: str(e[1]) } : { order: 0, id: undefined }))
    .sort((a, b) => a.order - b.order)
    .flatMap((e) => e.id ?? []);

/**
 * `{ images: [...] }` per output node, for what comes over the socket and what's in the history alike. A video node
 * lists its file there too (`SaveVideo` and `SaveWEBM` with `animated: [true]`), and Video Helper Suite's combine node
 * under `gifs`.
 */
export function outputImages(output: unknown): ComfyImage[] {
  const files = rec(output);
  return [...arr(files.images), ...arr(files.gifs)].flatMap((image) => {
    const { filename, subfolder, type } = rec(image);
    return typeof filename === 'string' ? [{ filename, subfolder: str(subfolder) ?? '', type: str(type) ?? 'output' }] : [];
  });
}

export class ComfyClient {
  constructor(
    private readonly instance: ImageInstance,
    private readonly deps: ImageAdapterDeps,
  ) {}

  private url(path: string): string {
    return `${this.instance.baseUrl}${path}`;
  }

  headers(json = true): Record<string, string> {
    return { ...(json ? { 'content-type': 'application/json' } : {}), ...this.instance.headers, ...bearer(this.instance) };
  }

  healthUrl(): string {
    return this.url('/system_stats');
  }

  private getJson(path: string, signal: AbortSignal | undefined): Promise<unknown> {
    return requestJson(this.deps, this.instance, this.url(path), { headers: this.headers(false), ...(signal ? { signal } : {}) });
  }

  private postJson(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return this.deps.fetch(this.url(path), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
  }

  private async expectOk(res: Response): Promise<void> {
    if (!res.ok) throw new ProviderHttpError(await httpError(res, this.instance));
  }

  /** Reads one node's entry: a server without that node answers with an empty object. */
  async nodeInfo(node: string, signal: AbortSignal | undefined): Promise<Record<string, unknown> | null> {
    const entry = rec(await this.getJson(`/object_info/${encodeURIComponent(node)}`, signal))[node];
    return entry === undefined ? null : rec(entry);
  }

  /** Connects to the job's events; a server or proxy that can't do WebSockets gets polled instead. */
  async openSocket(clientId: string, signal: AbortSignal, connectMs: number): Promise<ImageSocket | null> {
    const url = `${this.url('/ws').replace(/^http/, 'ws')}?clientId=${encodeURIComponent(clientId)}`;
    const connecting = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const tooLong = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        connecting.abort(new Error('The connection took too long.'));
        resolve(null);
      }, connectMs);
    });
    const opening = this.deps.socket(url, AbortSignal.any([signal, connecting.signal]));
    try {
      const socket = await Promise.race([opening, tooLong]);
      // One that opens after all, too late to be used, is closed rather than left open.
      if (!socket) void opening.then((late) => late.close()).catch(() => undefined);
      return socket;
    } catch {
      signal.throwIfAborted();
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Queues a job. Our own id means a job is ours to stop even if the answer to this request never arrives. */
  async submit(graph: unknown, clientId: string, promptId: string, signal: AbortSignal): Promise<Submission> {
    const res = await this.postJson('/prompt', { prompt: graph, client_id: clientId, prompt_id: promptId, extra_data: { preview_method: 'auto' } }, signal);
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderHttpError(await httpError(new Response(text, { status: res.ok ? 502 : res.status }), this.instance));
    }
    if (!res.ok) return { ok: false, body };
    return { ok: true, warnings: rec(body).node_errors };
  }

  async queue(signal: AbortSignal): Promise<QueueState> {
    const body = rec(await this.getJson('/queue', signal));
    return { running: promptIds(body.queue_running), pending: promptIds(body.queue_pending) };
  }

  /** A finished job's record, or null while there is none. */
  async history(promptId: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const entry = rec(await this.getJson(`/history/${encodeURIComponent(promptId)}`, signal))[promptId];
    return entry === undefined ? null : rec(entry);
  }

  async view(image: ComfyImage, signal: AbortSignal): Promise<Uint8Array> {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
    const res = await this.deps.fetch(this.url(`/view?${query}`), { method: 'GET', headers: this.headers(false), signal });
    await this.expectOk(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Puts an input image on the server and returns the name `LoadImage` reads it by. */
  async upload(image: ImageInput, signal: AbortSignal): Promise<string> {
    const { body, contentType } = multipart([
      { name: 'image', filename: image.name, mime: image.mime, bytes: image.bytes },
      { name: 'type', value: 'temp' },
      { name: 'subfolder', value: UPLOAD_FOLDER },
      { name: 'overwrite', value: 'true' },
    ]);
    const res = await this.deps.fetch(this.url('/upload/image'), { method: 'POST', headers: { ...this.headers(false), 'content-type': contentType }, body, signal });
    await this.expectOk(res);
    const { name, subfolder } = rec(await res.json());
    if (typeof name !== 'string') throw new Error(`${this.instance.name} didn't say where it put the image.`);
    return `${typeof subfolder === 'string' && subfolder ? `${subfolder}/` : ''}${name} [temp]`;
  }

  /**
   * Lets go of the models. `POST /free` is the obvious way, but it moves the weights from the GPU into RAM on the way out:
   * on a server with less RAM than the models weigh (Z-Image's are 19 GB, the box this was found on had a 12 GB limit)
   * that swaps for good and the worker stops taking jobs. A job with no model in it does the same without the detour:
   * ComfyUI drops what the last graph held, and 12.6 GB of VRAM came back with RAM unchanged.
   */
  async free(signal: AbortSignal | undefined): Promise<void> {
    const limit = signal ?? AbortSignal.timeout(15_000);
    const graph = { 1: { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: Math.floor(Math.random() * 0xffffff) } }, 2: { class_type: 'PreviewImage', inputs: { images: ['1', 0] } } };
    const sent = await this.submit(graph, crypto.randomUUID(), crypto.randomUUID(), limit);
    if (!sent.ok) throw new Error(`${this.instance.name} didn't take the job that lets go of its models.`);
  }

  /**
   * Stops a job without touching anyone else's. `/interrupt` stops whatever is running, so it's only sent when that's
   * ours; the id in its body makes newer servers check again themselves, which closes the gap since the look at the
   * queue. A waiting job comes off the queue instead, and the second look catches one that started meanwhile.
   */
  async stop(promptId: string, signal: AbortSignal): Promise<void> {
    for (let look = 0; look < 2; look++) {
      const { running, pending } = await this.queue(signal);
      if (running.includes(promptId)) {
        await this.expectOk(await this.postJson('/interrupt', { prompt_id: promptId }, signal));
        return;
      }
      if (!pending.includes(promptId)) return;
      await this.expectOk(await this.postJson('/queue', { delete: [promptId] }, signal));
    }
  }

  async userWorkflows(signal: AbortSignal | undefined): Promise<{ path: string; size?: number; modified?: number }[]> {
    const body = await this.getJson('/userdata?dir=workflows&recurse=true&split=false&full_info=true', signal);
    return arr(body).flatMap((item) => {
      const entry = rec(item);
      const path = str(entry.path);
      const size = num(entry.size);
      const modified = num(entry.modified);
      return path ? [{ path, ...(size !== undefined ? { size } : {}), ...(modified !== undefined ? { modified } : {}) }] : [];
    });
  }

  async userWorkflow(path: string, signal: AbortSignal | undefined): Promise<string> {
    const res = await this.deps.fetch(this.url(`/userdata/${encodeURIComponent(`workflows/${path}`)}`), { method: 'GET', headers: this.headers(false), signal: signal ?? null });
    await this.expectOk(res);
    return res.text();
  }
}
