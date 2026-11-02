/**
 * The AUTOMATIC1111 web API (`/sdapi/v1`): AUTOMATIC1111, Forge, Forge Neo, reForge, SD.Next, KoboldCpp and Draw Things.
 * `txt2img` and `img2img` only answer when the picture is done, so progress comes from polling beside them. The forks
 * agree on those two routes and differ around them, which is what `Flavor` records, taken from each server's source.
 * stable-diffusion.cpp's sd-server is here too: on a real one these routes report every step with a preview, where its
 * OpenAI routes say nothing until the end.
 */
import { modelRef, type ImageCapabilities, type MessageError } from '@atelier/protocol';
import { bearer, classifyError, extractErrorMessage, jsonHeaders, probe } from '../../providers/http.ts';
import { imageSize } from '../../providers/image-size.ts';
import { sniffMime } from '../../providers/images.ts';
import { arr, num, rec, str, strings, toBase64 } from '../../providers/util.ts';
import { checkpointFamily, checkpointLabel, editSize, pickName } from '../families.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';

interface Flavor {
  /** Reports a running job at `/sdapi/v1/progress`. */
  progress: boolean;
  /** Progress answers only the caller that put this key in its request. */
  genkey: boolean;
  /** Has `/sdapi/v1/interrupt`. Without it a job ends with the connection, or runs to its end. */
  interrupt: boolean;
  /** Holds many checkpoints and switches per request. */
  checkpoints: boolean;
  /** Takes a `scheduler` field. */
  schedulers: boolean;
  /** Has `/sdapi/v1/unload-checkpoint`. */
  free: boolean;
  maxCount: number;
  mask: boolean;
  /** What to say when `/sdapi/v1` answers 404. */
  apiOff: string;
  /** Refuses any field it doesn't know, and lists no models: see `drawThingsBody`. */
  strict?: boolean;
  /** Ignores `<lora:…>` tags, and takes `lora: [{ path, multiplier }]` with the paths it listed. */
  loraPaths?: boolean;
}

const WEBUI: Flavor = { progress: true, genkey: false, interrupt: true, checkpoints: true, schedulers: true, free: true, maxCount: 4, mask: true, apiOff: 'Start it with --api.' };

const FLAVORS: Record<string, Flavor> = {
  // SD.Next's /schedulers is its sampler list under a second name, and its API has no --api switch.
  sdnext: { ...WEBUI, schedulers: false, apiOff: 'Check the address: SD.Next always has its API on.' },
  // One image per request, one model chosen at start, and it stops a job when the connection drops.
  koboldcpp: { ...WEBUI, genkey: true, interrupt: false, checkpoints: false, free: false, maxCount: 1, apiOff: 'Start it with an image model loaded.' },
  // A job runs to its end whatever happens to the connection, and there's no route to stop it. Unloading isn't offered
  // either: the native /sdcpp/v1/models/unload can't bring back a model chosen on the command line.
  'sd-server': { ...WEBUI, interrupt: false, checkpoints: false, free: false, loraPaths: true, apiOff: 'Update stable-diffusion.cpp: this sd-server has no /sdapi/v1 routes.' },
  // Four routes: txt2img, img2img, and the app's current settings at / and /sdapi/v1/options.
  drawthings: { ...WEBUI, progress: false, interrupt: false, checkpoints: false, schedulers: false, free: false, mask: false, strict: true, apiOff: 'Turn on the API Server in the app, with HTTP as the protocol.' },
};

const flavorOf = (instance: ImageInstance): Flavor => FLAVORS[instance.preset ?? ''] ?? WEBUI;

const POLL_MS = 1_000;
const STOP_TIMEOUT_MS = 5_000;
/** How much an edit may change the picture: enough to act on the prompt, while it stays the same picture. */
const EDIT_STRENGTH = 0.6;
const FILL_FROM_ORIGINAL = 1;
const MASK_BLUR = 4;
/** Draw Things works in 64-pixel steps, and refuses an input image that differs from the size asked for. */
const DRAW_THINGS_STEP = 64;

interface ServerLists {
  samplers?: string[];
  schedulers?: string[];
  loras?: string[];
}

/**
 * A checkpoint's name without the hash in its title. The hash appears once the server has computed it, which on a real
 * Forge happens on first use, so a title can't be what a person's saved choice points at. The bare name always resolves.
 */
const checkpointId = (title: string) => title.replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '');

const namesOf = (body: unknown, key = 'name'): string[] | undefined => {
  const names = arr(body).flatMap((item) => str(rec(item)[key]) ?? []);
  return names.length ? names : undefined;
};

function capabilitiesFor(flavor: Flavor, name: string, lists: ServerLists): ImageCapabilities {
  const { defaults, ...family } = checkpointFamily(name);
  const sampler = pickName(lists.samplers, defaults.sampler);
  const scheduler = pickName(lists.schedulers, defaults.scheduler);
  return {
    ...family,
    maxCount: flavor.maxCount,
    edit: true,
    mask: flavor.mask,
    maxReferences: 1,
    transparent: false,
    seed: true,
    previews: flavor.progress,
    tunable: true,
    defaults: {
      ...(defaults.steps ? { steps: defaults.steps } : {}),
      ...(defaults.guidance !== undefined ? { guidance: defaults.guidance } : {}),
      ...(sampler ? { sampler } : {}),
      ...(scheduler ? { scheduler } : {}),
    },
    ...lists,
  };
}

/** What a failed request means, in the words the server used: `errors` holds the real reason, `error` only its type. */
async function failure(instance: ImageInstance, flavor: Flavor, res: Response): Promise<MessageError> {
  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try {
    body = rec(JSON.parse(text));
  } catch {
    // Not JSON: an HTML error page, usually.
  }
  const detail = str(body.errors) || str(body.detail) || extractErrorMessage(text);
  // A real route answers 404 too, for a sampler it doesn't have; only the framework's own says the API is off.
  if (res.status === 404 && (!detail || /^not found$/i.test(detail))) return { code: 'provider_error', message: `${instance.name}'s API isn't on. ${flavor.apiOff}`, retryable: false };
  return classifyError(instance, res.status, '', detail || res.statusText);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

const withoutDataPrefix = (image: string) => image.replace(/^data:[^,]*,/, '');

/** A preview's type from its bytes: it follows the server's `samples_format` setting, so it can be PNG, JPEG or WebP. */
function previewEvent(image: unknown): ImageEvent | null {
  const raw = str(image);
  if (!raw) return null;
  const data = withoutDataPrefix(raw);
  const mime = sniffMime(Buffer.from(data.slice(0, 32), 'base64'));
  return mime ? { type: 'preview', mime, data } : null;
}

/** `info` is a JSON string on most servers, an object on some, and empty on others. */
function factsOf(info: unknown): { seed?: number; seeds: number[]; model?: string } {
  let parsed: unknown = info;
  if (typeof info === 'string') {
    try {
      parsed = JSON.parse(info);
    } catch {
      parsed = null;
    }
  }
  const { seed, all_seeds, sd_model_name } = rec(parsed);
  const first = num(seed);
  const model = str(sd_model_name);
  return { ...(first !== undefined ? { seed: first } : {}), seeds: arr(all_seeds).flatMap((s) => num(s) ?? []), ...(model ? { model } : {}) };
}

/** Whether the server used the checkpoint it was asked for. It reports `folder_name`, for a file at `folder/name.ext`. */
function ranAsAsked(asked: string, used: string | undefined): boolean {
  const label = checkpointLabel(asked);
  return !used || used === label || used.endsWith(`_${label}`);
}

function loraTags(request: ImageRequest): string {
  return request.loras.map((lora) => ` <lora:${lora.name}:${lora.weight}>`).join('');
}

/** How the LoRAs of a request reach this server: in the prompt, or as a field of their own. */
function loraFields(flavor: Flavor, request: ImageRequest): { prompt: string; lora?: { path: string; multiplier: number }[] } {
  if (!flavor.loraPaths) return { prompt: request.prompt + loraTags(request) };
  return { prompt: request.prompt, ...(request.loras.length ? { lora: request.loras.map((l) => ({ path: l.name, multiplier: l.weight })) } : {}) };
}

function webuiBody(flavor: Flavor, request: ImageRequest, genkey: string | undefined): Record<string, unknown> {
  const { steps, guidance, sampler, scheduler } = request.tuning;
  const input = request.references[0];
  const size = input ? editSize(request) : { width: request.width, height: request.height };
  return {
    ...loraFields(flavor, request),
    negative_prompt: request.negativePrompt ?? '',
    ...size,
    batch_size: request.count,
    n_iter: 1,
    seed: request.seed ?? -1,
    ...(steps !== undefined ? { steps } : {}),
    ...(guidance !== undefined ? { cfg_scale: guidance } : {}),
    ...(sampler ? { sampler_name: sampler } : {}),
    ...(scheduler && flavor.schedulers ? { scheduler } : {}),
    send_images: true,
    save_images: false,
    // Left at 10, a model of 4 or 8 steps never shows a preview. The server only draws one when it's polled, so this
    // costs a picture a second at most. If the option was never saved, Forge doesn't restore it, so it stays at 1 in the
    // server's memory until a restart; it isn't written to its config.
    ...(flavor.checkpoints ? { override_settings: { sd_model_checkpoint: request.model, show_progress_every_n_steps: 1 } } : {}),
    ...(genkey ? { genkey } : {}),
    ...(input ? { init_images: [toBase64(input.bytes)], denoising_strength: EDIT_STRENGTH, resize_mode: 0 } : {}),
    ...(input && request.mask ? { mask: toBase64(request.mask.bytes), inpainting_fill: FILL_FROM_ORIGINAL, mask_blur: MASK_BLUR } : {}),
  };
}

/** Throws what the person needs to hear: Draw Things refuses an input image of any other size than the one asked for. */
function drawThingsInputSize(request: ImageRequest): { width: number; height: number } {
  const size = imageSize(request.references[0]!.bytes);
  if (!size || size.width % DRAW_THINGS_STEP !== 0 || size.height % DRAW_THINGS_STEP !== 0) {
    throw new Error(`Draw Things needs an input image whose sides are multiples of ${DRAW_THINGS_STEP} pixels${size ? `, and this one is ${size.width}×${size.height}` : ''}.`);
  }
  return size;
}

/**
 * Only keys Draw Things knows, because any other fails the whole request ("Unrecognized keys"). The seed is always
 * chosen here: left out, it would use the app's current one and repeat the last picture.
 */
function drawThingsBody(request: ImageRequest): Record<string, unknown> {
  const { steps, guidance, sampler } = request.tuning;
  const input = request.references[0];
  return {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt ?? '',
    ...(input ? drawThingsInputSize(request) : { width: request.width, height: request.height }),
    batch_size: request.count,
    seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
    model: request.model,
    ...(steps !== undefined ? { steps } : {}),
    ...(guidance !== undefined ? { guidance_scale: guidance } : {}),
    ...(sampler ? { sampler } : {}),
    ...(input ? { init_images: [toBase64(input.bytes)], strength: EDIT_STRENGTH } : {}),
  };
}

export function createA1111(instance: ImageInstance, deps: ImageAdapterDeps, options: { pollMs?: number } = {}): ImageAdapter {
  const flavor = flavorOf(instance);
  const pollMs = options.pollMs ?? POLL_MS;
  const headers = () => jsonHeaders(instance, bearer(instance));
  const url = (path: string) => `${instance.baseUrl}/sdapi/v1/${path}`;

  /** A list that may not exist on this server, which is no reason to lose the others. */
  const optional = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    try {
      const res = await deps.fetch(url(path), { method: 'GET', headers: headers(), signal: signal ?? null });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  const listed = (name: string, lists: ServerLists, overrides: Partial<ImageCapabilities> = {}): ListedImageModel => ({
    ref: modelRef(instance.id, name),
    providerId: instance.id,
    modelId: name,
    displayName: checkpointLabel(name),
    capabilities: { ...capabilitiesFor(flavor, name, lists), ...overrides },
    source: 'detected',
  });

  /** The app's one model, with the settings it has for it, which beat what a family usually wants. */
  const drawThingsModel = async (signal?: AbortSignal): Promise<ListedImageModel[]> => {
    const settings = rec(await optional('options', signal));
    const model = str(settings.model);
    if (!model) return [];
    const { sizes, ...family } = checkpointFamily(model);
    const steps = num(settings.steps);
    const guidance = num(settings.guidance_scale);
    return [listed(model, {}, { ...family, sizes: sizes.kind === 'free' ? { ...sizes, multiple: DRAW_THINGS_STEP } : sizes, defaults: { ...(steps ? { steps } : {}), ...(guidance !== undefined ? { guidance } : {}) } })];
  };

  const interrupt = async () => {
    await deps.fetch(url('interrupt'), { method: 'POST', headers: headers(), signal: AbortSignal.timeout(STOP_TIMEOUT_MS) }).catch(() => undefined);
  };

  /** Follows the job until `done` settles. Losing a poll loses only that update, so nothing here can fail the job. */
  async function* watch(request: ImageRequest, done: Promise<unknown>, genkey: string | undefined): AsyncGenerator<ImageEvent> {
    if (!flavor.progress) {
      yield { type: 'progress' };
      return;
    }
    const over = new AbortController();
    const finished = () => over.abort();
    done.then(finished, finished);
    const signal = AbortSignal.any([request.signal, over.signal]);
    const query = `progress?skip_current_image=false${genkey ? `&genkey=${genkey}` : ''}`;
    let seen = '';
    let lastPreview = '';
    let loading = false;
    for (;;) {
      await sleep(pollMs, signal);
      if (signal.aborted) return;
      let res: Response;
      try {
        res = await deps.fetch(url(query), { method: 'GET', headers: headers(), signal });
      } catch {
        if (signal.aborted) return;
        continue;
      }
      // A server without the route won't grow one mid-job.
      if (res.status === 404) return;
      const body = res.ok ? rec(await res.json().catch(() => null)) : {};
      const state = rec(body.state);
      const step = num(state.sampling_step) ?? 0;
      const steps = num(state.sampling_steps) ?? 0;
      const fraction = Math.min(1, Math.max(0, num(body.progress) ?? 0));
      const idle = (num(state.job_count) ?? 0) === 0 && fraction === 0;
      if (idle) continue;
      if (steps === 0) {
        if (!loading) yield { type: 'loading' };
        loading = true;
      } else if (`${step}/${steps}/${fraction}` !== seen) {
        // Only news goes out, so a server that hangs mid-job still trips the service's silence limit.
        seen = `${step}/${steps}/${fraction}`;
        const eta = num(body.eta_relative);
        // Before a step has finished it's a division by its 0.01 starting point: minutes, for a job of seconds.
        yield { type: 'progress', step, steps, fraction, ...(eta && eta > 0 && step > 0 ? { etaMs: Math.round(eta * 1000) } : {}) };
      }
      const preview = str(body.current_image);
      if (preview && preview !== lastPreview) {
        lastPreview = preview;
        const event = previewEvent(preview);
        if (event) yield event;
      }
    }
  }

  async function* run(request: ImageRequest): AsyncGenerator<ImageEvent> {
    const genkey = flavor.genkey ? `atelier-${crypto.randomUUID()}` : undefined;
    const body = flavor.strict ? drawThingsBody(request) : webuiBody(flavor, request, genkey);
    const stop = () => void interrupt();
    if (flavor.interrupt) request.signal.addEventListener('abort', stop, { once: true });
    try {
      const pending = deps.fetch(url(request.references.length ? 'img2img' : 'txt2img'), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: request.signal });
      // Awaited below; this only keeps a failure from counting as unhandled while the watch is running.
      pending.catch(() => undefined);
      yield* watch(request, pending, genkey);
      const res = await pending;
      if (!res.ok) {
        yield { type: 'finish', reason: 'error', error: await failure(instance, flavor, res) };
        return;
      }
      const answer = rec(await res.json());
      const images = strings(answer.images).slice(0, request.count);
      const { seed, seeds, model } = factsOf(answer.info);
      // It takes a name it doesn't know without a word and uses whatever it has loaded, which is not what was asked for.
      if (flavor.checkpoints && !ranAsAsked(request.model, model)) {
        yield { type: 'finish', reason: 'error', error: { code: 'model_not_found', message: `${instance.name} doesn't have ${checkpointLabel(request.model)} any more, and used ${model} instead. Refresh it in Settings.`, retryable: false } };
        return;
      }
      for (const [i, image] of images.entries()) {
        const known = seeds[i] ?? (seed !== undefined ? seed + i : (body.seed as number | undefined));
        yield { type: 'image', bytes: Buffer.from(withoutDataPrefix(image), 'base64'), ...(known !== undefined && known >= 0 ? { seed: known } : {}) };
      }
      yield images.length ? { type: 'finish', reason: 'done' } : { type: 'finish', reason: 'error', error: { code: 'provider_error', message: `${instance.name} made no image.`, retryable: false } };
    } finally {
      request.signal.removeEventListener('abort', stop);
    }
  }

  return {
    type: 'a1111',
    async listModels(signal) {
      if (flavor.strict) return drawThingsModel(signal);
      const [models, samplers, schedulers, loras] = await Promise.all([optional('sd-models', signal), optional('samplers', signal), flavor.schedulers ? optional('schedulers', signal) : null, optional('loras', signal)]);
      // Forge corrects a scheduler's `name` to its `label` with a warning on every run, so the label is what's sent.
      const scheduling = namesOf(schedulers, 'label') ?? namesOf(schedulers);
      const lists = Object.fromEntries(Object.entries({ samplers: namesOf(samplers), schedulers: scheduling, loras: namesOf(loras, flavor.loraPaths ? 'path' : 'name') }).filter(([, names]) => names)) as ServerLists;
      const names = arr(models).flatMap((m) => str(rec(m).title) ?? str(rec(m).model_name) ?? []);
      return names.map((name) => listed(checkpointId(name), lists));
    },
    health(signal) {
      return probe(deps, instance, url(flavor.strict ? 'options' : 'sd-models'), headers(), signal, async (res, latencyMs) => {
        if (res.ok && !flavor.checkpoints && !flavor.strict) {
          const models = arr(await res.clone().json().catch(() => null));
          return models.length ? null : { ok: true, latencyMs, warnings: [`${instance.name} has no image model loaded.`] };
        }
        return res.status === 404 ? { ok: false, latencyMs, warnings: [], error: `${instance.name}'s API isn't on. ${flavor.apiOff}` } : null;
      });
    },
    generate: (request) => guardImages(request, instance, () => run(request)),
    ...(flavor.free
      ? {
          async free(signal?: AbortSignal) {
            await deps.fetch(url('unload-checkpoint'), { method: 'POST', headers: headers(), signal: signal ?? null });
          },
        }
      : {}),
  };
}
