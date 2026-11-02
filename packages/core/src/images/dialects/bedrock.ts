/**
 * Amazon Bedrock's `InvokeModel`, with no SDK: a Bedrock API key as a bearer token, or `ACCESS_KEY:SECRET[:SESSION_TOKEN]`
 * signed with Signature Version 4 by hand. The region comes from the base URL.
 *
 * Nova Canvas reached end of life on 2026-09-30 and Titan Image Generator before it, so what's left are Stability's
 * models, in us-west-2. Their inputs are named as on Stability's own API; answers are `{ images, seeds, finish_reasons }`.
 *
 * Read on 2026-11-02: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html,
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html, .../model-card-amazon-nova-canvas.html,
 * .../model-parameters-diffusion-3-5-large.html, .../stable-image-services.html, .../api-keys.html
 */
import { createHash, createHmac } from 'node:crypto';
import { arr, num, rec, str, toBase64 } from '../../providers/util.ts';
import { BEDROCK_MODEL_IDS, BEDROCK_MODELS, lookUp } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { failureOf, listedModel, noImage, refusal } from './hosted.ts';

/** Masks go to this service whichever model was chosen, as no other Bedrock model takes one. */
const INPAINT_MODEL = 'us.stability.stable-image-inpaint-v1:0';
/** How far an input image may be changed; the tool has no field for it. */
const IMAGE_STRENGTH = 0.7;
const SERVICE = 'bedrock';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const hmac = (key: string | Buffer, text: string) => createHmac('sha256', key).update(text).digest();

export interface SignatureInput {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  method: string;
  /** The path as sent, already percent-encoded once. */
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  now: Date;
}

/** The `Authorization` value for a request, and the headers it signed that the caller has to send. */
export function signV4(input: SignatureInput): { authorization: string; headers: Record<string, string> } {
  const stamp = input.now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const extra: Record<string, string> = { 'x-amz-date': stamp, ...(input.sessionToken ? { 'x-amz-security-token': input.sessionToken } : {}) };
  const signed = Object.entries({ ...input.headers, ...extra }).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const).sort(([a], [b]) => (a < b ? -1 : 1));
  const names = signed.map(([name]) => name).join(';');
  // Every service but S3 signs the path encoded a second time.
  const canonicalPath = input.path.replace(/%/g, '%25');
  const canonical = [input.method, canonicalPath, input.query ?? '', ...signed.map(([name, value]) => `${name}:${value}`), '', names, hash(input.body)].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, hash(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${names}, Signature=${signature}`, headers: extra };
}

/** `bedrock-runtime.us-west-2.amazonaws.com` says the region. */
export function regionOf(baseUrl: string): string | null {
  return /^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/.exec(URL.parse(baseUrl)?.hostname ?? '')?.[1] ?? null;
}

function invokeBody(request: ImageRequest): Record<string, unknown> {
  const input = request.references[0];
  const shared = { prompt: request.prompt, output_format: 'png', ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}) };
  if (input && request.mask) return { ...shared, image: toBase64(input.bytes), mask: toBase64(request.mask.bytes) };
  if (input) return { ...shared, mode: 'image-to-image', image: toBase64(input.bytes), strength: IMAGE_STRENGTH };
  return { ...shared, ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}) };
}

function authorize(instance: ImageInstance, region: string, path: string, body: string, now: Date): Record<string, string> {
  const key = instance.apiKey ?? '';
  const parts = key.split(':');
  if (parts.length < 2) return { authorization: `Bearer ${key}` };
  const [accessKey, secretKey, sessionToken] = parts as [string, string, string | undefined];
  const host = new URL(instance.baseUrl).host;
  const { authorization, headers } = signV4({ accessKey, secretKey, ...(sessionToken ? { sessionToken } : {}), region, service: SERVICE, method: 'POST', path, headers: { host, 'content-type': 'application/json' }, body, now });
  return { authorization, ...headers };
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, now: () => Date): AsyncGenerator<ImageEvent> {
  const region = regionOf(instance.baseUrl);
  if (!region) {
    yield { type: 'finish', reason: 'error', error: { code: 'provider_error', message: `${instance.baseUrl} doesn't say which AWS region to use. It should look like https://bedrock-runtime.us-west-2.amazonaws.com.`, retryable: false } };
    return;
  }
  const model = request.mask && request.references.length > 0 ? INPAINT_MODEL : request.model;
  const path = `/model/${encodeURIComponent(model)}/invoke`;
  const body = JSON.stringify(invokeBody(request));
  const res = await deps.fetch(`${instance.baseUrl}${path}`, {
    method: 'POST',
    headers: { ...instance.headers, 'content-type': 'application/json', accept: 'application/json', ...authorize(instance, region, path, body, now()) },
    body,
    signal: request.signal,
  });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const answer = rec(await res.json());
  const reasons = arr(answer.finish_reasons).map(str);
  const seeds = arr(answer.seeds);
  let images = 0;
  for (const [index, image] of arr(answer.images).entries()) {
    const data = str(image);
    if (!data || reasons[index]) continue;
    images++;
    const seed = num(seeds[index]);
    yield { type: 'image', bytes: Buffer.from(data, 'base64'), ...(seed !== undefined ? { seed } : {}) };
  }
  const reason = reasons.find(Boolean);
  if (images > 0) yield { type: 'finish', reason: 'done' };
  else if (reason && /filter/i.test(reason)) yield refusal(instance, reason);
  else yield noImage(instance, reason, reason === 'Inference error');
}

export function createBedrock(instance: ImageInstance, deps: ImageAdapterDeps, options: { now?: () => Date } = {}): ImageAdapter {
  const now = options.now ?? (() => new Date());
  const ids = [...new Set([...BEDROCK_MODEL_IDS, ...instance.models])];
  return {
    type: 'bedrock',
    listModels: () => Promise.resolve(ids.map((id) => listedModel(instance, id, lookUp(BEDROCK_MODELS, id), instance.models.includes(id) ? 'default' : 'catalog'))),
    // A key can only be tried on a real model call, which costs money: this checks what can be checked for free.
    health() {
      if (!regionOf(instance.baseUrl)) return Promise.resolve({ ok: false, latencyMs: null, warnings: [], error: 'The address should look like https://bedrock-runtime.us-west-2.amazonaws.com.' });
      if (!instance.apiKey) return Promise.resolve({ ok: false, latencyMs: null, warnings: [], error: 'This needs a Bedrock API key, or an access key and secret.' });
      return Promise.resolve({ ok: true, latencyMs: null, warnings: [] });
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request, now));
    },
  };
}
