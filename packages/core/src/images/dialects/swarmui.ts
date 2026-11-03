/**
 * SwarmUI's API (docs/API.md in its repository): JSON POSTs to `/API/<route>`, each with a `session_id`, and a WebSocket
 * route that reports progress and previews while it generates. `src/WebAPI/T2IAPI.cs` is the reference for the socket:
 * its `image` message carries the path as a plain string, not the nested object the route docs show, so both are read.
 */
import { modelRef, type ImageCapabilities } from '@atelier/protocol';
import { classifyError, exceptionError, extractErrorMessage, hostPort, isAbortError, isConnectionRefused } from '../../providers/http.ts';
import { sniffMime } from '../../providers/images.ts';
import { arr, dataUrl, num, rec, str } from '../../providers/util.ts';
import { checkpointFamily, checkpointLabel, editSize, pickName } from '../families.ts';
import { guardImages } from '../guard.ts';
import { readClasses, standardSize, swarmVideoCapabilities, swarmVideoPayload, videoKind, type SwarmClasses } from './swarmui-video.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ImageSocket, ListedImageModel } from '../types.ts';

const SESSION_GONE = 'invalid_session_id';
const MODEL_FOLDER_DEPTH = 8;
/** How much an edit may change the picture: enough to act on the prompt, while it stays the same picture. */
const EDIT_CREATIVITY = 0.6;
const STOP_TIMEOUT_MS = 5_000;
const MAX_COUNT = 4;

class SessionGone extends Error {}

interface Finished {
  path: string;
  index: number;
  seed?: number;
}

/** The seed from an image's metadata, which is usually JSON and isn't promised to be. */
function seedIn(metadata: string | undefined): number | undefined {
  if (!metadata) return undefined;
  try {
    return num(rec(rec(JSON.parse(metadata)).sui_image_params).seed);
  } catch {
    return undefined;
  }
}

function finished(entry: unknown, fallbackIndex: number): Finished | null {
  const outer = rec(entry);
  const inner = rec(outer.image);
  const path = typeof entry === 'string' ? entry : (str(outer.image) ?? str(inner.image));
  if (!path) return null;
  const index = Number(str(outer.batch_index) ?? str(inner.batch_index) ?? fallbackIndex);
  const seed = seedIn(str(outer.metadata) ?? str(inner.metadata));
  return { path, index: Number.isFinite(index) ? index : fallbackIndex, ...(seed !== undefined ? { seed } : {}) };
}

function previewOf(value: unknown): Extract<ImageEvent, { type: 'preview' }> | null {
  const match = str(value)?.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  return { type: 'preview', mime: sniffMime(Buffer.from(match[2]!.slice(0, 32), 'base64')) ?? match[1]!, data: match[2]! };
}

function payload(request: ImageRequest, sessionId: string): Record<string, unknown> {
  if (request.video) return swarmVideoPayload(request, sessionId);
  const { steps, guidance, sampler, scheduler } = request.tuning;
  const input = request.references[0];
  const size = input ? editSize(request) : { width: request.width, height: request.height };
  return {
    session_id: sessionId,
    images: request.count,
    prompt: request.prompt,
    negativeprompt: request.negativePrompt ?? '',
    model: request.model,
    ...size,
    seed: request.seed ?? -1,
    ...(steps !== undefined ? { steps } : {}),
    ...(guidance !== undefined ? { cfgscale: guidance } : {}),
    ...(sampler ? { sampler } : {}),
    ...(scheduler ? { scheduler } : {}),
    // Atelier keeps the image; without this it would pile up in the person's Swarm history too.
    donotsave: true,
    ...(request.loras.length ? { loras: request.loras.map((l) => l.name).join(','), loraweights: request.loras.map((l) => l.weight).join(',') } : {}),
    ...(input ? { initimage: dataUrl(input.mime, input.bytes), initimagecreativity: EDIT_CREATIVITY } : {}),
    // White changes, as in the internal mask (images/mask.ts).
    ...(request.mask ? { maskimage: dataUrl(request.mask.mime, request.mask.bytes) } : {}),
  };
}

export function createSwarmUi(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...instance.headers,
    ...(instance.apiKey ? { cookie: `swarm_token=${instance.apiKey}` } : {}),
  });

  const post = async (route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const res = await deps.fetch(`${instance.baseUrl}/API/${route}`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: signal ?? null });
    const text = await res.text();
    let answer: Record<string, unknown> = {};
    try {
      answer = rec(JSON.parse(text));
    } catch {
      // Not JSON: an error page, reported below.
    }
    if (str(answer.error_id) === SESSION_GONE) throw new SessionGone(str(answer.error));
    const error = str(answer.error);
    if (error) throw new Error(`${instance.name}: ${error}`);
    if (!res.ok) throw new Error(classifyError(instance, res.status, '', extractErrorMessage(text) || res.statusText).message);
    return answer;
  };

  const newSession = async (signal?: AbortSignal): Promise<string> => {
    const id = str((await post('GetNewSession', {}, signal)).session_id);
    if (!id) throw new Error(`${instance.name} didn't give a session.`);
    return id;
  };

  let session: Promise<string> | null = null;
  const currentSession = (signal?: AbortSignal): Promise<string> => {
    session ??= newSession(signal).catch((error: unknown) => {
      session = null;
      throw error;
    });
    return session;
  };

  /** A route that needs a session. Sessions end with a restart of the server, so a stale one is replaced once. */
  const call = async (route: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    try {
      return await post(route, { session_id: await currentSession(signal), ...body }, signal);
    } catch (error) {
      if (!(error instanceof SessionGone)) throw error;
      session = null;
      return post(route, { session_id: await currentSession(signal), ...body }, signal);
    }
  };

  const fetchImage = async (path: string, signal: AbortSignal): Promise<Uint8Array> => {
    if (path.startsWith('data:')) return Buffer.from(path.slice(path.indexOf(',') + 1), 'base64');
    const { 'content-type': _json, ...rest } = headers();
    const res = await deps.fetch(`${instance.baseUrl}/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'GET', headers: rest, signal });
    if (!res.ok) throw new Error(`Fetching the image failed (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };

  /** Generates over the socket. Null means it never got going, so the HTTP route should do the job instead. */
  async function* overSocket(request: ImageRequest, body: Record<string, unknown>): AsyncGenerator<ImageEvent, Finished[] | null> {
    let socket: ImageSocket;
    try {
      socket = await deps.socket(`${instance.baseUrl.replace(/^http/, 'ws')}/API/GenerateText2ImageWS`, request.signal);
    } catch (error) {
      if (request.signal.aborted) throw error;
      return null;
    }
    const images: Finished[] = [];
    const discarded = new Set<number>();
    let heard = false;
    let loading = false;
    let furthest = 0;
    try {
      socket.send(JSON.stringify(body));
      for await (const raw of socket) {
        const message = rec(JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')));
        heard = true;
        if (str(message.error_id) === SESSION_GONE) throw new SessionGone();
        const error = str(message.error);
        if (error) throw new Error(`${instance.name}: ${error}`);
        if (message.status) {
          const status = rec(message.status);
          const waiting = (num(status.loading_models) ?? 0) > 0 || (num(status.waiting_backends) ?? 0) > 0;
          if (waiting && !loading) yield { type: 'loading' };
          loading = waiting;
        }
        if (message.gen_progress) {
          const progress = rec(message.gen_progress);
          const batch = Number(str(progress.batch_index) ?? num(progress.batch_index) ?? 0);
          const within = Math.min(1, num(progress.overall_percent) ?? 0);
          const fraction = (Math.min(Number.isFinite(batch) ? batch : 0, request.count - 1) + within) / request.count;
          const current = num(progress.current_percent) ?? 0;
          const { steps } = request.tuning;
          // An edit skips the first steps, so only a new picture can count them from this.
          const counted = steps && current > 0 && request.references.length === 0 && !request.video ? { step: Math.round(current * steps), steps } : {};
          // A real server sends two series side by side, with and without previews, and each restarts per node of the
          // workflow, so only progress past the furthest so far counts: a bar shouldn't run backwards.
          if (fraction > furthest) {
            furthest = fraction;
            yield { type: 'progress', ...counted, fraction };
          }
          const preview = previewOf(progress.preview);
          if (preview) yield preview;
        }
        const image = message.image ? finished(message, images.length) : null;
        if (image) images.push(image);
        for (const index of arr(message.discard_indices)) if (typeof index === 'number') discarded.add(index);
        if (message.socket_intention === 'close') break;
      }
    } finally {
      socket.close();
    }
    return heard ? images.filter((image) => !discarded.has(image.index)) : null;
  }

  async function overHttp(request: ImageRequest, body: Record<string, unknown>): Promise<Finished[]> {
    const answer = await post('GenerateText2Image', body, request.signal);
    return arr(answer.images).flatMap((entry, i) => finished(entry, i) ?? []);
  }

  async function* run(request: ImageRequest): AsyncGenerator<ImageEvent> {
    for (let attempt = 0; ; attempt++) {
      // Its own session, so stopping this job can't stop another one running beside it.
      const sessionId = await newSession(request.signal);
      const stop = () => void post('InterruptAll', { session_id: sessionId, other_sessions: false }, AbortSignal.timeout(STOP_TIMEOUT_MS)).catch(() => undefined);
      request.signal.addEventListener('abort', stop, { once: true });
      try {
        const body = payload(request, sessionId);
        // A socket can't carry the sign-in cookie, so a server with accounts is asked over HTTP.
        const images = (instance.apiKey ? null : yield* overSocket(request, body)) ?? (await overHttp(request, body));
        // Stopping closes the socket, which ends it the same quiet way as a job with nothing to show.
        if (request.signal.aborted) return;
        if (images.length === 0) {
          yield { type: 'finish', reason: 'error', error: { code: 'provider_error', message: `${instance.name} made no image.`, retryable: false } };
          return;
        }
        // One clip: the file the server wrote, fetched through the same guarded fetch (a clip may be large).
        if (request.video) {
          const clip = images[0]!;
          yield { type: 'video', bytes: await fetchImage(clip.path, request.signal), ...(clip.seed !== undefined ? { seed: clip.seed } : {}) };
        } else for (const image of images) yield { type: 'image', bytes: await fetchImage(image.path, request.signal), ...(image.seed !== undefined ? { seed: image.seed } : {}) };
        yield { type: 'finish', reason: 'done' };
        return;
      } catch (error) {
        if (!(error instanceof SessionGone) || attempt > 0) throw error;
      } finally {
        request.signal.removeEventListener('abort', stop);
      }
    }
  }

  const listed = (file: Record<string, unknown>, lists: Pick<ImageCapabilities, 'samplers' | 'schedulers' | 'loras'>, classes: SwarmClasses): ListedImageModel | null => {
    const name = str(file.name);
    if (!name || file.is_supported_model_format === false || file.is_negative_embedding === true) return null;
    // A video model's class says so (`is_text2video`, `is_image2video`); it is a different kind of model, with a recipe of its own.
    const kind = videoKind(str(file.architecture), classes);
    if (kind) return { ref: modelRef(instance.id, name), providerId: instance.id, modelId: name, displayName: str(file.title) || checkpointLabel(name), capabilities: swarmVideoCapabilities(kind, standardSize(file)), source: 'detected' };
    const { defaults, sizes, ...family } = checkpointFamily(`${str(file.architecture) ?? ''} ${name}`);
    const width = num(file.standard_width) ?? 0;
    const height = num(file.standard_height) ?? 0;
    const sampler = pickName(lists.samplers, defaults.sampler);
    const scheduler = pickName(lists.schedulers, defaults.scheduler);
    return {
      ref: modelRef(instance.id, name),
      providerId: instance.id,
      modelId: name,
      displayName: str(file.title) || checkpointLabel(name),
      capabilities: {
        ...family,
        sizes: sizes.kind === 'free' && width > 0 && height > 0 ? { ...sizes, base: Math.round(Math.sqrt(width * height)) } : sizes,
        maxCount: MAX_COUNT,
        edit: true,
        mask: true,
        maxReferences: 1,
        transparent: false,
        seed: true,
        previews: true,
        tunable: true,
        defaults: { ...(defaults.steps ? { steps: defaults.steps } : {}), ...(defaults.guidance !== undefined ? { guidance: defaults.guidance } : {}), ...(sampler ? { sampler } : {}), ...(scheduler ? { scheduler } : {}) },
        ...lists,
      },
      source: 'detected',
    };
  };

  /** Values come as `id///Label`. */
  const choices = (params: unknown, id: string): string[] | undefined => {
    const values = arr(arr(rec(params).list).map(rec).find((p) => p.id === id)?.values).flatMap((v) => str(v)?.split('///')[0] ?? []);
    return values.length ? values : undefined;
  };

  return {
    type: 'swarmui',
    async listModels(signal) {
      const [models, params, loras] = await Promise.all([
        call('ListModels', { path: '', depth: MODEL_FOLDER_DEPTH, subtype: 'Stable-Diffusion' }, signal).catch(() => null),
        call('ListT2IParams', {}, signal).catch(() => null),
        call('ListModels', { path: '', depth: MODEL_FOLDER_DEPTH, subtype: 'LoRA' }, signal).catch(() => null),
      ]);
      const loraNames = arr(rec(loras).files).flatMap((f) => str(rec(f).name) ?? []);
      const samplers = choices(params, 'sampler');
      const schedulers = choices(params, 'scheduler');
      const lists = { ...(samplers ? { samplers } : {}), ...(schedulers ? { schedulers } : {}), ...(loraNames.length ? { loras: loraNames } : {}) };
      const classes = readClasses(params);
      return arr(rec(models).files).flatMap((file) => listed(rec(file), lists, classes) ?? []);
    },
    async health(signal) {
      const started = performance.now();
      try {
        await newSession(signal);
        return { ok: true, latencyMs: Math.round(performance.now() - started), warnings: [] };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return { ok: false, latencyMs: null, warnings: [], error: isConnectionRefused(error) ? `Nothing is listening at ${hostPort(instance.baseUrl)}.` : exceptionError(error, instance).message };
      }
    },
    generate: (request) => guardImages(request, instance, () => run(request)),
    async free(signal) {
      await call('FreeBackendMemory', { system_ram: false, backend: 'all' }, signal);
    },
  };
}
