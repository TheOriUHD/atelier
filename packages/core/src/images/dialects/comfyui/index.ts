/**
 * ComfyUI (ARCHITECTURE §23): a job is a graph of nodes. Each family of model has a recipe that writes one
 * (`templates.ts`), people can bring their own (`workflow.ts`), and what a server can run is read from it at runtime
 * (`discovery.ts`). A job reports over a socket with polling behind it (`job.ts`).
 */
import { probe } from '../../../providers/http.ts';
import { imageSize } from '../../../providers/image-size.ts';
import { mapLimit, rec } from '../../../providers/util.ts';
import { guardImages } from '../../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../../types.ts';
import { ComfyClient, type ComfyImage } from './client.ts';
import { detectFamily, discoverModels, DISCOVERY_NODES, sourceOf, stackFor, type NodeInfo, type ObjectInfo } from './discovery.ts';
import { promptError } from './errors.ts';
import { followJob, TIMING, type JobTiming } from './job.ts';
import { buildGraph, type GraphPlan } from './templates.ts';
import { applyWorkflow, readWorkflow, workflowIdOf } from './workflow.ts';

/** How many `/object_info/<node>` reads run at once: each holds up that server's other requests while it runs. */
const NODE_READS_AT_ONCE = 4;
const STOP_MS = 10_000;

/** Larger seeds lose precision as numbers, and these are more than enough. */
const newSeed = () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

export function createComfyUi(instance: ImageInstance, deps: ImageAdapterDeps, timing: JobTiming = TIMING): ImageAdapter {
  const client = new ComfyClient(instance, deps);
  /** What the server has, kept between jobs: a file list only changes when someone adds a model. */
  let known: Promise<ObjectInfo> | null = null;

  const readNodes = async (nodes: readonly string[], signal: AbortSignal | undefined): Promise<ObjectInfo> => {
    const entries = await mapLimit(nodes, NODE_READS_AT_ONCE, async (node): Promise<[string, NodeInfo | null]> => [node, await client.nodeInfo(node, signal)]);
    return Object.fromEntries(entries.filter((e): e is [string, NodeInfo] => e[1] !== null));
  };

  const serverNodes = (signal: AbortSignal | undefined, fresh = false): Promise<ObjectInfo> => {
    if (known && !fresh) return known;
    const reading = readNodes(DISCOVERY_NODES, signal);
    known = reading;
    reading.catch(() => {
      if (known === reading) known = null;
    });
    return reading;
  };

  /** The graph for a request, with its input images already on the server. */
  async function plan(request: ImageRequest, seed: number): Promise<GraphPlan> {
    const { signal, model, references } = request;
    const images = await Promise.all(references.map((image) => client.upload(image, signal)));
    const mask = request.mask ? await client.upload(request.mask, signal) : undefined;
    const workflowId = workflowIdOf(model);
    if (workflowId !== null) {
      const workflow = instance.workflows.find((w) => w.id === workflowId);
      if (!workflow) throw new Error(`${instance.name} has no workflow "${workflowId}" any more.`);
      return applyWorkflow(workflow, request, seed, images, mask);
    }
    const info = await serverNodes(signal);
    const source = sourceOf(model, info);
    const family = source && detectFamily(model, source);
    const stack = family && source && stackFor(family, model, source, info);
    if (!source || !family || !stack) {
      known = null;
      throw new Error(`${instance.name} can't run ${model} any more. Refresh it in Settings.`);
    }
    const first = references[0];
    const inputSize = first ? imageSize(first.bytes) : null;
    return buildGraph({ file: model, source, family, stack, request, seed, images, info, ...(mask ? { mask } : {}), ...(inputSize ? { inputSize } : {}) });
  }

  async function* run(request: ImageRequest): AsyncGenerator<ImageEvent> {
    const { signal } = request;
    const seed = request.seed ?? newSeed();
    const prepared = await plan(request, seed);
    const clientId = crypto.randomUUID();
    const promptId = crypto.randomUUID();
    const socket = await client.openSocket(clientId, signal, timing.connectMs);
    let abandoned = false;
    try {
      const submission = await client.submit(prepared.graph, clientId, promptId, signal);
      if (!submission.ok) {
        // Most often a file that's gone: the next job should look again rather than repeat the same list.
        known = null;
        yield { type: 'finish', reason: 'error', error: promptError(instance, submission.body) };
        return;
      }
      const outcome = yield* followJob({ instance, client, promptId, plan: prepared, socket, timing, signal });
      if ('error' in outcome) {
        abandoned = outcome.stillQueued ?? false;
        yield { type: 'finish', reason: 'error', error: outcome.error };
        return;
      }
      const images: ComfyImage[] = outcome.images;
      if (images.length === 0) {
        const warned = Object.keys(rec(submission.warnings)).length > 0;
        yield { type: 'finish', reason: 'error', error: warned ? promptError(instance, { node_errors: submission.warnings }) : { code: 'provider_error', message: `${instance.name} finished without an image.`, retryable: false } };
        return;
      }
      for (const image of images) yield { type: 'image', bytes: await client.view(image, signal), seed };
      yield { type: 'finish', reason: 'done' };
    } finally {
      socket?.close();
      // Sent after the abort, so it can't use the request's signal. The job stays ours to stop even if nobody's waiting.
      if (signal.aborted || abandoned) await client.stop(promptId, AbortSignal.timeout(STOP_MS)).catch(() => undefined);
    }
  }

  return {
    type: 'comfyui',
    async listModels(signal) {
      return discoverModels(instance, await serverNodes(signal, true));
    },
    health(signal) {
      return probe(deps, instance, client.healthUrl(), client.headers(false), signal, async (res, latencyMs) => {
        if (!res.ok) return null;
        const body = rec(await res.json().catch(() => null));
        return body.system ? { ok: true, latencyMs, warnings: [] } : { ok: false, latencyMs, warnings: [], error: `${instance.baseUrl} answers, but it isn't ComfyUI.` };
      });
    },
    generate(request) {
      return guardImages(request, instance, () => run(request));
    },
    free(signal) {
      return client.free(signal);
    },
    async parseWorkflow(source, signal) {
      const text = source.saved === undefined ? source.text : await client.userWorkflow(source.saved, signal);
      return readWorkflow({ ...source, text }, (types) => readNodes(types, signal));
    },
    savedWorkflows(signal) {
      return client.userWorkflows(signal);
    },
  };
}
