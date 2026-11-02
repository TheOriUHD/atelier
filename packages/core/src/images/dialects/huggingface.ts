/**
 * Hugging Face Inference Providers. There's no single text-to-image route: the router forwards to whichever provider
 * serves the model, each in its own format, and only HF Inference answers in raw bytes. The Hub says who serves what.
 * `black-forest-labs/FLUX.1-dev:replicate` picks a provider; without a suffix it's the first one Atelier can speak to.
 *
 * Read on 2026-11-02: https://huggingface.co/docs/inference-providers/tasks/text-to-image,
 * https://huggingface.co/docs/inference-providers/main/en/hub-api, https://huggingface.co/docs/inference-providers/en/index.
 * The routes aren't documented over HTTP, so they follow Hugging Face's own client (huggingface/huggingface.js,
 * packages/inference/src/providers). WaveSpeed isn't here: that provider isn't in Atelier's list of what it can speak.
 */
import { probe, requestJson } from '../../providers/http.ts';
import { arr, isRecord, rec, str } from '../../providers/util.ts';
import { HUGGINGFACE_CAPABILITIES } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { failure, failureOf, listedModel, noImage, refusal, soundsRefused, waitFor } from './hosted.ts';

const HUB = 'https://huggingface.co/api/models';
const POLL_MS = 1_000;
const LIST_LIMIT = 30;
/** Order of preference when a model is served by several: the ones that answer at once come first. */
const PROVIDERS = ['hf-inference', 'together', 'nscale', 'replicate', 'fal-ai'] as const;
type Provider = (typeof PROVIDERS)[number];
const isProvider = (name: string | undefined): name is Provider => PROVIDERS.includes(name as Provider);

const headers = (instance: ImageInstance): Record<string, string> => ({ 'content-type': 'application/json', ...instance.headers, ...(instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {}) });

/** Width, height and the rest, as every provider but HF Inference names them at the top level. */
function settings(request: ImageRequest): Record<string, unknown> {
  return {
    ...(request.width && request.height ? { width: request.width, height: request.height } : {}),
    ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
}

const steps = (request: ImageRequest) => ({
  ...(request.tuning.steps !== undefined ? { num_inference_steps: request.tuning.steps } : {}),
  ...(request.tuning.guidance !== undefined ? { guidance_scale: request.tuning.guidance } : {}),
});

async function* hfInference(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, model: string): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/hf-inference/models/${model}`, {
    method: 'POST',
    headers: { ...headers(instance), accept: 'image/png' },
    body: JSON.stringify({ inputs: request.prompt, parameters: { ...settings(request), ...steps(request) } }),
    signal: request.signal,
  });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  // Raw bytes, though some of its models answer in the images JSON shape.
  if (res.headers.get('content-type')?.includes('json')) {
    const b64 = str(rec(arr(rec(await res.json()).data)[0]).b64_json);
    if (!b64) {
      yield noImage(instance);
      return;
    }
    yield { type: 'image', bytes: Buffer.from(b64, 'base64') };
  } else yield { type: 'image', bytes: new Uint8Array(await res.arrayBuffer()) };
  yield { type: 'finish', reason: 'done' };
}

async function* openAiShaped(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, provider: Provider, model: string): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/${provider}/v1/images/generations`, {
    method: 'POST',
    headers: headers(instance),
    body: JSON.stringify({ model, prompt: request.prompt, response_format: provider === 'together' ? 'base64' : 'b64_json', ...settings(request), ...(request.tuning.steps !== undefined ? { steps: request.tuning.steps } : {}) }),
    signal: request.signal,
  });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const b64 = str(rec(arr(rec(await res.json()).data)[0]).b64_json);
  if (!b64) {
    yield noImage(instance);
    return;
  }
  yield { type: 'image', bytes: Buffer.from(b64, 'base64') };
  yield { type: 'finish', reason: 'done' };
}

async function* replicate(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, model: string): AsyncGenerator<ImageEvent> {
  // A community model is named with its version, and has no route of its own.
  const version = model.split(':')[1];
  const res = await deps.fetch(`${instance.baseUrl}/replicate/v1/${version ? 'predictions' : `models/${model}/predictions`}`, {
    method: 'POST',
    headers: { ...headers(instance), prefer: 'wait' },
    body: JSON.stringify({ input: { prompt: request.prompt, ...settings(request), ...steps(request) }, ...(version ? { version } : {}) }),
    signal: request.signal,
  });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const prediction = rec(await res.json());
  const output = prediction.output;
  const url = str(output) ?? str(arr(output)[0]);
  if (url) {
    yield { type: 'image', url };
    yield { type: 'finish', reason: 'done' };
    return;
  }
  const error = str(prediction.error);
  if (error && soundsRefused(error)) yield refusal(instance, error);
  else if (error) yield noImage(instance, error);
  // The client Hugging Face ships doesn't poll this either: the router's token isn't good for Replicate's own address.
  else yield failure({ code: 'provider_timeout', message: `${instance.name} is taking too long on Replicate. Try again, or add Replicate as its own provider.`, retryable: true });
}

async function* fal(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, model: string, pollMs: number): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/fal-ai/${model}?_subdomain=queue`, {
    method: 'POST',
    headers: headers(instance),
    body: JSON.stringify({ prompt: request.prompt, ...settings(request), ...steps(request), ...(request.width && request.height ? { image_size: { width: request.width, height: request.height } } : {}) }),
    signal: request.signal,
  });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const submitted = rec(await res.json());
  const responseUrl = str(submitted.response_url);
  if (!responseUrl || !URL.canParse(responseUrl)) {
    yield noImage(instance, 'its answer had no queue address');
    return;
  }
  // The path of fal's own address, through the router, as the key is for the router.
  const path = `${instance.baseUrl}/fal-ai${new URL(responseUrl).pathname}`;
  for (;;) {
    const status = await deps.fetch(`${path}/status?_subdomain=queue`, { method: 'GET', headers: headers(instance), signal: request.signal });
    if (!status.ok) {
      yield await failureOf(instance, status);
      return;
    }
    const state = str(rec(await status.json()).status);
    if (state === 'COMPLETED') break;
    yield state === 'IN_PROGRESS' ? { type: 'progress' } : { type: 'loading' };
    await waitFor(pollMs, request.signal);
  }
  const result = await deps.fetch(`${path}?_subdomain=queue`, { method: 'GET', headers: headers(instance), signal: request.signal });
  if (!result.ok) {
    yield await failureOf(instance, result);
    return;
  }
  const url = str(rec(arr(rec(await result.json()).images)[0]).url);
  if (!url) {
    yield noImage(instance);
    return;
  }
  yield { type: 'image', url };
  yield { type: 'finish', reason: 'done' };
}

/** Who serves a model and under what name, from the Hub. */
async function mapping(instance: ImageInstance, deps: ImageAdapterDeps, model: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  // Public, and on another host, so the key stays out of it.
  const res = await deps.fetch(`${HUB}/${model}?expand[]=inferenceProviderMapping`, { method: 'GET', headers: {}, signal });
  if (!res.ok) throw new Error(`Hugging Face doesn't know the model "${model}".`);
  return rec(rec(await res.json()).inferenceProviderMapping);
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, pollMs: number): AsyncGenerator<ImageEvent> {
  const [model, suffix] = request.model.split(':') as [string, string | undefined];
  const providers = await mapping(instance, deps, model, request.signal);
  const live = (name: string) => str(rec(providers[name]).status) === 'live';
  const provider = suffix ? (isProvider(suffix) ? suffix : undefined) : PROVIDERS.find(live);
  if (!provider) {
    const serving = Object.keys(providers).filter(live);
    yield failure({ code: 'provider_error', message: suffix ? `Atelier can't speak to the provider "${suffix}" yet.` : serving.length ? `${model} is only served by ${serving.join(', ')}, which Atelier can't speak to through Hugging Face yet.` : `No provider is serving ${model} right now.`, retryable: false });
    return;
  }
  const providerModel = str(rec(providers[provider]).providerId) ?? model;
  if (provider === 'hf-inference') yield* hfInference(instance, deps, request, providerModel);
  else if (provider === 'replicate') yield* replicate(instance, deps, request, providerModel);
  else if (provider === 'fal-ai') yield* fal(instance, deps, request, providerModel, pollMs);
  else yield* openAiShaped(instance, deps, request, provider, providerModel);
}

export function createHuggingFace(instance: ImageInstance, deps: ImageAdapterDeps, options: { pollMs?: number } = {}): ImageAdapter {
  const pollMs = options.pollMs ?? POLL_MS;
  return {
    type: 'huggingface',
    async listModels(signal) {
      const typed = instance.models.map((id) => listedModel(instance, id, HUGGINGFACE_CAPABILITIES, 'default'));
      const found = await requestJson(deps, { ...instance, headers: {} }, `${HUB}?inference_provider=${PROVIDERS.join(',')}&pipeline_tag=text-to-image&limit=${LIST_LIMIT}`, { headers: {}, ...(signal ? { signal } : {}) }).catch(() => null);
      const seen = new Set(instance.models);
      const listed = arr(found).filter(isRecord).flatMap((model) => {
        const id = str(model.id);
        return id && !seen.has(id) ? [listedModel(instance, id, HUGGINGFACE_CAPABILITIES, 'detected')] : [];
      });
      return [...typed, ...listed];
    },
    health(signal) {
      return probe(deps, instance, `${instance.baseUrl}/v1/models`, headers(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request, pollMs));
    },
  };
}
