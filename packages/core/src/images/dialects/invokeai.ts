/**
 * InvokeAI's workflow API: a graph of nodes goes in a queue, the queue item is polled, and the image is fetched by name
 * (https://invoke.ai/development/guides/workflow-api/). The graphs follow the app's own builders, buildSD1Graph and
 * buildSDXLGraph, without their canvas layers.
 *
 * Only SD 1.x, SD 2.x and SDXL are offered. FLUX and the newer families need separately installed encoders and their
 * own node types, so such a model shows nowhere rather than failing. On a real 6.14.3 the SD 1.5 graphs ran end to end;
 * the SDXL graphs pass its validation, but its machine had too little memory to finish a picture.
 */
import { modelRef, type ImageCapabilities } from '@atelier/protocol';
import { bearer, classifyError, httpError, jsonHeaders, probe, ProviderHttpError, requestJson } from '../../providers/http.ts';
import { arr, num, rec, str } from '../../providers/util.ts';
import { checkpointFamily, checkpointLabel, editSize } from '../families.ts';
import { guardImages } from '../guard.ts';
import { multipart } from '../multipart.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';

const POLL_MS = 500;
/** About ten seconds. A server under load drops the odd poll while its job runs on, and giving up would orphan that job. */
const POLL_FAILURES_ALLOWED = 20;
const STOP_TIMEOUT_MS = 5_000;
const MAX_COUNT = 4;
/** How much an edit may change the picture: enough to act on the prompt, while it stays the same picture. */
const EDIT_STRENGTH = 0.6;
/** `is_intermediate`: its gallery shouldn't fill up with what Atelier already keeps. */
const NOT_FOR_THE_GALLERY = true;
const OUTPUT_NODE = 'l2i';
/**
 * On the two VAE nodes, as the app sets it. `i2l` otherwise runs in float16: a real CPU sat on one small image for nine
 * minutes without finishing, and Invoke's own `l2i` notes that the SD VAE overflows to black images at that precision.
 */
const VAE_PRECISION = { fp32: true };
const NOISE_NODE = 'noise';

/** Invoke's one list of samplers, schedules included. */
const SCHEDULERS = ['ddim', 'ddpm', 'deis', 'deis_k', 'lms', 'lms_k', 'pndm', 'heun', 'heun_k', 'euler', 'euler_k', 'euler_a', 'kdpm_2', 'kdpm_2_k', 'kdpm_2_a', 'kdpm_2_a_k', 'dpmpp_2s', 'dpmpp_2s_k', 'dpmpp_2m', 'dpmpp_2m_k', 'dpmpp_2m_sde', 'dpmpp_2m_sde_k', 'dpmpp_3m', 'dpmpp_3m_k', 'dpmpp_sde', 'dpmpp_sde_k', 'er_sde', 'unipc', 'unipc_k', 'lcm', 'tcd'];
const FALLBACK_SCHEDULER = 'euler';
const SCHEDULER_FOR_SAMPLER: Record<string, string> = { 'DPM++ 2M': 'dpmpp_2m_k', 'DPM++ 2M SDE': 'dpmpp_2m_sde_k', 'DPM++ SDE': 'dpmpp_sde', 'Euler a': 'euler_a' };

/** The bases there are graphs for, with what the family table calls them. */
const BASES: Record<string, { label: string; families: readonly string[] }> = {
  'sd-1': { label: '', families: ['sd15', 'sd15-distilled'] },
  'sd-2': { label: 'sd2', families: ['sd2', 'sd-turbo'] },
  sdxl: { label: 'sdxl', families: ['sdxl', 'sdxl-distilled'] },
};

/** Variants that need extra inputs these graphs don't give them. */
const NEEDS_MORE = new Set(['inpaint', 'depth']);

function traitsFor(base: string, name: string) {
  const { label, families } = BASES[base]!;
  const named = checkpointFamily(`${label} ${name}`);
  // Invoke read the file and knows its base, so a stray "xl" in a name doesn't get to argue.
  return families.includes(named.family) ? named : checkpointFamily(label);
}

function capabilitiesOf(config: Record<string, unknown>): ImageCapabilities {
  const { defaults, ...family } = traitsFor(str(config.base)!, str(config.name) ?? '');
  const set = rec(config.default_settings);
  const steps = num(set.steps) ?? defaults.steps;
  const guidance = num(set.cfg_scale) ?? defaults.guidance;
  const scheduler = str(set.scheduler) ?? SCHEDULER_FOR_SAMPLER[defaults.sampler ?? ''] ?? FALLBACK_SCHEDULER;
  return {
    ...family,
    maxCount: MAX_COUNT,
    edit: true,
    mask: false,
    maxReferences: 1,
    transparent: false,
    seed: true,
    // Previews reach the app over its own socket.io channel, which isn't spoken here.
    previews: false,
    tunable: true,
    defaults: { ...(steps ? { steps } : {}), ...(guidance !== undefined ? { guidance } : {}), sampler: scheduler },
    samplers: SCHEDULERS,
  };
}

interface Edge {
  source: { node_id: string; field: string };
  destination: { node_id: string; field: string };
}

const edge = (from: string, field: string, to: string, into = field): Edge => ({ source: { node_id: from, field }, destination: { node_id: to, field: into } });

export function buildGraph(model: Record<string, unknown>, request: ImageRequest, seed: number, inputImage: string | undefined): Record<string, unknown> {
  const sdxl = model.base === 'sdxl';
  const { width, height } = request.references.length ? editSize(request) : request;
  const size = { width, height };
  const identifier = { key: model.key, hash: model.hash, name: model.name, base: model.base, type: model.type };
  const nodes: Record<string, Record<string, unknown>> = {};
  const add = (id: string, type: string, fields: Record<string, unknown> = {}) => (nodes[id] = { id, type, ...fields });

  add('loader', sdxl ? 'sdxl_model_loader' : 'main_model_loader', { model: identifier });
  const conditioning = (text: string) => (sdxl ? { prompt: text, style: text, original_width: width, original_height: height, target_width: width, target_height: height, crop_top: 0, crop_left: 0 } : { prompt: text });
  add('positive', sdxl ? 'sdxl_compel_prompt' : 'compel', conditioning(request.prompt));
  add('negative', sdxl ? 'sdxl_compel_prompt' : 'compel', conditioning(request.negativePrompt ?? ''));
  add(NOISE_NODE, 'noise', { seed, ...size, use_cpu: true });
  add('denoise', 'denoise_latents', {
    steps: request.tuning.steps,
    cfg_scale: request.tuning.guidance,
    scheduler: request.tuning.sampler ?? FALLBACK_SCHEDULER,
    denoising_start: inputImage ? 1 - EDIT_STRENGTH : 0,
    denoising_end: 1,
  });
  add(OUTPUT_NODE, 'l2i', { ...VAE_PRECISION, is_intermediate: NOT_FOR_THE_GALLERY, use_cache: false });

  const edges: Edge[] = [
    edge('loader', 'unet', 'denoise'),
    edge('loader', 'clip', 'positive'),
    edge('loader', 'clip', 'negative'),
    ...(sdxl ? [edge('loader', 'clip2', 'positive'), edge('loader', 'clip2', 'negative')] : []),
    edge('positive', 'conditioning', 'denoise', 'positive_conditioning'),
    edge('negative', 'conditioning', 'denoise', 'negative_conditioning'),
    edge(NOISE_NODE, 'noise', 'denoise'),
    edge('denoise', 'latents', OUTPUT_NODE),
    edge('loader', 'vae', OUTPUT_NODE),
  ];
  if (inputImage) {
    add('resize', 'img_resize', { image: { image_name: inputImage }, ...size, is_intermediate: NOT_FOR_THE_GALLERY });
    add('i2l', 'i2l', VAE_PRECISION);
    edges.push(edge('resize', 'image', 'i2l'), edge('loader', 'vae', 'i2l'), edge('i2l', 'latents', 'denoise'));
  }
  return { id: crypto.randomUUID(), nodes, edges };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/** The finished image of the output node: `results` also holds the resized input of an edit. */
function outputImage(session: Record<string, unknown>): string | undefined {
  const results = rec(session.results);
  const prepared = arr(rec(session.source_prepared_mapping)[OUTPUT_NODE]).flatMap((id) => str(id) ?? []);
  const output = prepared.map((id) => results[id]).find(Boolean) ?? Object.values(results).findLast((r) => rec(r).type === 'image_output');
  return str(rec(rec(output).image).image_name);
}

export function createInvokeAi(instance: ImageInstance, deps: ImageAdapterDeps, options: { pollMs?: number } = {}): ImageAdapter {
  const pollMs = options.pollMs ?? POLL_MS;
  const headers = () => jsonHeaders(instance, bearer(instance));
  const queue = `${instance.baseUrl}/api/v1/queue/default`;

  const upload = async (request: ImageRequest): Promise<string> => {
    const input = request.references[0]!;
    const { body, contentType } = multipart([{ name: 'file', filename: input.name, mime: input.mime, bytes: input.bytes }]);
    const res = await deps.fetch(`${instance.baseUrl}/api/v1/images/upload?image_category=general&is_intermediate=true`, { method: 'POST', headers: { ...instance.headers, ...bearer(instance), 'content-type': contentType }, body, signal: request.signal });
    if (!res.ok) throw new Error((await httpError(res, instance)).message);
    const name = str(rec(await res.json()).image_name);
    if (!name) throw new Error(`${instance.name} didn't take the image.`);
    return name;
  };

  const fetchImage = async (name: string, signal: AbortSignal): Promise<Uint8Array> => {
    const res = await deps.fetch(`${instance.baseUrl}/api/v1/images/i/${encodeURIComponent(name)}/full`, { method: 'GET', headers: { ...instance.headers, ...bearer(instance) }, signal });
    if (!res.ok) throw new Error(`Fetching the image failed (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };

  /**
   * Follows one queue item to its end. Every poll counts as news: the server just said the job is alive. A real server
   * only fills in `session.results` when the job ends, so all the queue can say is that it's running: live steps travel
   * on the app's socket.io channel, which isn't spoken here.
   */
  async function* follow(request: ImageRequest, id: number, index: number, count: number, open: Set<number>): AsyncGenerator<ImageEvent, boolean> {
    let failures = 0;
    for (;;) {
      let body: unknown;
      try {
        body = await requestJson(deps, instance, `${queue}/i/${id}`, { headers: headers(), signal: request.signal });
        failures = 0;
      } catch (error) {
        const passing = error instanceof ProviderHttpError ? error.error.retryable : true;
        if (request.signal.aborted || !passing || ++failures > POLL_FAILURES_ALLOWED) throw error;
        await sleep(pollMs, request.signal);
        continue;
      }
      const item = rec(body);
      const session = rec(item.session);
      switch (str(item.status)) {
        case 'completed': {
          open.delete(id);
          const name = outputImage(session);
          if (!name) throw new Error(`${instance.name} finished without an image.`);
          const seed = num(rec(rec(rec(session.graph).nodes)[NOISE_NODE]).seed);
          yield { type: 'image', bytes: await fetchImage(name, request.signal), ...(seed !== undefined ? { seed } : {}) };
          return true;
        }
        case 'failed': {
          open.delete(id);
          const detail = [str(item.error_type), str(item.error_message)].filter(Boolean).join(': ');
          yield { type: 'finish', reason: 'error', error: classifyError(instance, null, 'failed', detail) };
          return false;
        }
        case 'canceled':
          open.delete(id);
          if (request.signal.aborted) return false;
          yield { type: 'finish', reason: 'error', error: { code: 'provider_error', message: `The job was cancelled in ${instance.name}.`, retryable: false } };
          return false;
        case 'in_progress':
          // A batch is the one thing that moves: which of its images is under way.
          yield { type: 'progress', ...(count > 1 ? { fraction: index / count } : {}) };
          break;
      }
      await sleep(pollMs, request.signal);
      if (request.signal.aborted) return false;
    }
  }

  async function* run(request: ImageRequest): AsyncGenerator<ImageEvent> {
    const model = rec(await requestJson(deps, instance, `${instance.baseUrl}/api/v2/models/i/${encodeURIComponent(request.model)}`, { headers: headers(), signal: request.signal }));
    const inputImage = request.references.length ? await upload(request) : undefined;
    const first = request.seed ?? Math.floor(Math.random() * 2 ** 31);
    const seeds = Array.from({ length: request.count }, (_, i) => first + i);
    const res = await deps.fetch(`${queue}/enqueue_batch`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        prepend: false,
        batch: {
          graph: buildGraph(model, request, first, inputImage),
          runs: 1,
          origin: 'atelier',
          // A run per seed: the same graph twice would return one picture twice.
          data: [[{ node_path: NOISE_NODE, field_name: 'seed', items: seeds }]],
        },
      }),
      signal: request.signal,
    });
    if (!res.ok) {
      yield { type: 'finish', reason: 'error', error: await httpError(res, instance) };
      return;
    }
    const ids = arr(rec(await res.json()).item_ids).flatMap((id) => num(id) ?? []);
    if (ids.length === 0) throw new Error(`${instance.name} queued nothing.`);
    const open = new Set(ids);
    const stop = () => {
      for (const id of open) void deps.fetch(`${queue}/i/${id}/cancel`, { method: 'PUT', headers: headers(), signal: AbortSignal.timeout(STOP_TIMEOUT_MS) }).catch(() => undefined);
    };
    request.signal.addEventListener('abort', stop, { once: true });
    try {
      for (const [index, id] of ids.entries()) {
        if (!(yield* follow(request, id, index, ids.length, open))) return;
      }
      yield { type: 'finish', reason: 'done' };
    } finally {
      request.signal.removeEventListener('abort', stop);
    }
  }

  return {
    type: 'invokeai',
    async listModels(signal) {
      const body = await requestJson(deps, instance, `${instance.baseUrl}/api/v2/models/?model_type=main`, { headers: headers(), ...(signal ? { signal } : {}) });
      return arr(rec(body).models).flatMap((entry): ListedImageModel[] => {
        const config = rec(entry);
        const key = str(config.key);
        const base = str(config.base);
        if (!key || !base || !BASES[base] || NEEDS_MORE.has(str(config.variant) ?? '')) return [];
        return [{ ref: modelRef(instance.id, key), providerId: instance.id, modelId: key, displayName: str(config.name) ?? checkpointLabel(key), capabilities: capabilitiesOf(config), source: 'detected', ...(str(config.description) ? { description: str(config.description)! } : {}) }];
      });
    },
    health: (signal) => probe(deps, instance, `${instance.baseUrl}/api/v1/app/version`, headers(), signal),
    generate: (request) => guardImages(request, instance, () => run(request)),
    async free(signal) {
      await deps.fetch(`${instance.baseUrl}/api/v2/models/empty_model_cache`, { method: 'POST', headers: headers(), signal: signal ?? null });
    },
  };
}
