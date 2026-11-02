/**
 * Follows one job to its end. The socket and polling are one loop: a message is handled when it arrives, and when
 * none comes for a while the queue and history get a look. That covers a socket that fails, drops or goes quiet, and
 * it keeps reporting while a job waits behind someone else's on the server.
 */
import type { MessageError } from '@atelier/protocol';
import { arr, num, rec, str } from '../../../providers/util.ts';
import type { ImageEvent, ImageInstance, ImageSocket } from '../../types.ts';
import { outputImages, type ComfyClient, type ComfyImage } from './client.ts';
import { executionError, interruptedError, stalledError, vanishedError } from './errors.ts';
import { decodeFrame } from './frames.ts';
import type { GraphPlan } from './templates.ts';

export interface JobTiming {
  /** With the socket open, how long a silence lasts before the queue gets a look. */
  silenceMs: number;
  /** Without one, how often the queue gets a look. */
  pollMs: number;
  /** How long a server may not answer before the job counts as lost. A cold load can stall it for a good while. */
  lostMs: number;
  /** How long a job may sit first in line with nothing running. It normally starts at once. */
  stallMs: number;
  connectMs: number;
  requestMs: number;
}

export const TIMING: JobTiming = { silenceMs: 10_000, pollMs: 1_500, lostMs: 120_000, stallMs: 60_000, connectMs: 5_000, requestMs: 15_000 };

/** `stillQueued`: it never started and is ours to take back off the server's queue. */
export type Outcome = { images: ComfyImage[] } | { error: MessageError; stillQueued?: boolean };

type Read = { events: ImageEvent[]; ended?: 'done' | MessageError };

/** What's holding things up before the first step, by the node at work. Weights reach the GPU at the sampler, so it counts. */
function loadingWhat(classType: string | undefined): string | undefined {
  if (!classType) return undefined;
  if (/CLIP|TextEncode/.test(classType)) return 'the text encoder';
  if (/VAELoader/.test(classType)) return 'the VAE';
  if (/Lora/.test(classType)) return 'the LoRA';
  if (/Loader|Sampler/.test(classType)) return 'the model';
  return undefined;
}

/** Reads one job's messages, from the socket or replayed out of its history. */
export class JobWatch {
  readonly outputs = new Map<string, ComfyImage[]>();
  private sampling = false;
  private loading: string | undefined;
  private pass: { node: string; startedAt: number; firstStep: number } | null = null;

  constructor(
    private readonly instance: ImageInstance,
    private readonly promptId: string,
    private readonly plan: GraphPlan,
  ) {}

  private progress(data: Record<string, unknown>): ImageEvent[] {
    const value = num(data.value);
    const max = num(data.max);
    if (value === undefined || !max) return [];
    this.sampling = true;
    const node = str(data.node) ?? '';
    const now = Date.now();
    if (this.pass?.node !== node) this.pass = { node, startedAt: now, firstStep: value };
    // Timed from the first report, not the job's start: the first step also carries the model load.
    const done = value - this.pass.firstStep;
    const etaMs = done > 0 ? Math.round(((now - this.pass.startedAt) / done) * (max - value)) : undefined;
    const index = this.plan.samplers.indexOf(node);
    // With several passes the step count starts over each time, so only the whole job's share keeps moving forward.
    const fraction = this.plan.samplers.length > 1 && index >= 0 ? (index + value / max) / this.plan.samplers.length : undefined;
    return [{ type: 'progress', step: value, steps: max, ...(fraction !== undefined ? { fraction } : {}), ...(etaMs !== undefined ? { etaMs } : {}) }];
  }

  private executing(data: Record<string, unknown>): Read {
    const node = str(data.node);
    if (data.node === null) return { events: [], ended: 'done' };
    if (this.sampling || !node) return { events: [] };
    const what = loadingWhat(this.plan.graph[node]?.class_type);
    if (!what || what === this.loading) return { events: [] };
    this.loading = what;
    return { events: [{ type: 'loading', what }] };
  }

  read(type: string, data: Record<string, unknown>): Read {
    const owner = str(data.prompt_id);
    if (owner !== undefined && owner !== this.promptId) return { events: [] };
    switch (type) {
      case 'executing':
        return this.executing(data);
      case 'progress':
        return { events: this.progress(data) };
      case 'executed': {
        const node = str(data.node);
        const images = outputImages(data.output);
        if (node && images.length) this.outputs.set(node, images);
        return { events: [] };
      }
      case 'execution_success':
        return { events: [], ended: 'done' };
      case 'execution_error':
        return { events: [], ended: executionError(this.instance, data) };
      case 'execution_interrupted':
        return { events: [], ended: interruptedError(this.instance) };
      default:
        return { events: [] };
    }
  }

  /** The job's record once it's done: the same messages the socket sends, kept in order, and the outputs. */
  readHistory(entry: Record<string, unknown>): 'done' | MessageError {
    for (const [node, output] of Object.entries(rec(entry.outputs))) {
      const images = outputImages(output);
      if (images.length) this.outputs.set(node, images);
    }
    for (const message of arr(rec(entry.status).messages)) {
      if (!Array.isArray(message)) continue;
      const { ended } = this.read(str(message[0]) ?? '', rec(message[1]));
      if (ended && ended !== 'done') return ended;
    }
    return 'done';
  }

  /** The planned output's images, or everything when a workflow's output isn't known. */
  images(): ComfyImage[] {
    return this.outputs.get(this.plan.output) ?? [...this.outputs.values()].flat();
  }
}

const TICK = Symbol('tick');
const NEVER = new Promise<never>(() => undefined);

/** Whichever comes first: `next`, or `ms` going by. Stopping always wins. */
async function nextOrTick<T>(next: Promise<T>, ms: number, signal: AbortSignal): Promise<T | typeof TICK> {
  signal.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: () => void = () => undefined;
  const tick = new Promise<typeof TICK>((resolve) => {
    timer = setTimeout(() => resolve(TICK), ms);
  });
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([next, tick, stopped]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function parseMessage(text: string): { type: string; data: Record<string, unknown> } | null {
  try {
    const message = rec(JSON.parse(text));
    return { type: str(message.type) ?? '', data: rec(message.data) };
  } catch {
    return null;
  }
}

export interface JobInput {
  instance: ImageInstance;
  client: ComfyClient;
  promptId: string;
  plan: GraphPlan;
  socket: ImageSocket | null;
  timing: JobTiming;
  signal: AbortSignal;
}

export async function* followJob({ instance, client, promptId, plan, socket, timing, signal }: JobInput): AsyncGenerator<ImageEvent, Outcome> {
  const watch = new JobWatch(instance, promptId, plan);
  const reader = socket?.[Symbol.asyncIterator]();
  let live = !!reader;
  let pending: Promise<IteratorResult<string | Uint8Array>> | null = null;
  let contact = Date.now();
  let idleSince: number | null = null;

  const request = () => AbortSignal.any([signal, AbortSignal.timeout(timing.requestMs)]);

  /** The job ended: its images came over the socket, or they're in its record if the job was all cached. */
  const finished = async (ended: 'done' | MessageError): Promise<Outcome> => {
    if (ended !== 'done') return { error: ended };
    if (watch.outputs.size === 0) {
      const entry = await client.history(promptId, request());
      if (entry) watch.readHistory(entry);
    }
    return { images: watch.images() };
  };

  /** One look at the server. A slow or silent answer is no reason to give up on a job, until it has gone on too long. */
  async function* look(): AsyncGenerator<ImageEvent, Outcome | null> {
    try {
      const { running, pending: waiting } = await client.queue(request());
      contact = Date.now();
      const place = waiting.indexOf(promptId);
      const unattended = place === 0 && running.length === 0;
      idleSince = unattended ? (idleSince ?? Date.now()) : null;
      if (idleSince !== null && Date.now() - idleSince > timing.stallMs) return { error: stalledError(instance), stillQueued: true };
      if (place >= 0) {
        yield { type: 'queued', ahead: running.length + place };
        return null;
      }
      if (running.includes(promptId)) {
        if (!live) yield { type: 'progress' };
        return null;
      }
      // Queue before history: a job moves between them at once, so missing from both means it's gone.
      const entry = await client.history(promptId, request());
      if (!entry) return { error: vanishedError(instance) };
      return await finished(watch.readHistory(entry));
    } catch (error) {
      if (signal.aborted || Date.now() - contact > timing.lostMs) throw error;
      return null;
    }
  }

  for (;;) {
    if (live && reader) pending ??= reader.next();
    let next: IteratorResult<string | Uint8Array> | typeof TICK;
    try {
      next = await nextOrTick<IteratorResult<string | Uint8Array>>(pending ?? NEVER, live ? timing.silenceMs : timing.pollMs, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // The socket failed. The job didn't, and the next look says how it's doing.
      live = false;
      pending = null;
      continue;
    }
    if (next === TICK) {
      const outcome = yield* look();
      if (outcome) return outcome;
      continue;
    }
    pending = null;
    if (next.done) {
      live = false;
      continue;
    }
    if (typeof next.value !== 'string') {
      const preview = decodeFrame(next.value);
      if (preview && (!preview.promptId || preview.promptId === promptId)) yield { type: 'preview', mime: preview.mime, data: preview.data };
      continue;
    }
    const message = parseMessage(next.value);
    if (!message) continue;
    contact = Date.now();
    const { events, ended } = watch.read(message.type, message.data);
    yield* events;
    if (ended) return await finished(ended);
  }
}
