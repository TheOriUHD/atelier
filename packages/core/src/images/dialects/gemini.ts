/**
 * Gemini image models through `generateContent`, and the same models on Vertex AI in express mode.
 *
 * Read on 2026-11-02: https://ai.google.dev/gemini-api/docs/generate-content/image-generation,
 * https://ai.google.dev/api/generate-content, https://ai.google.dev/api/models, https://ai.google.dev/gemini-api/docs/deprecations,
 * https://ai.google.dev/gemini-api/docs/migrate-to-interactions,
 * https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/vertex-ai-express-mode-api-reference
 *
 * Google recommends the Interactions API for new work, but says `generateContent` "remains fully supported" and gives
 * no end date, and Interactions isn't required for images. Imagen and its `predict` route are gone from the Gemini API
 * (shut down on 2026-08-17), so they aren't here.
 */
import { requestJson, probe } from '../../providers/http.ts';
import { arr, isRecord, rec, str, strings, toBase64 } from '../../providers/util.ts';
import { GEMINI_MODELS, lookUp } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { failureOf, listedModel, noImage, refusal } from './hosted.ts';

/** The reasons that mean the content was turned down, as opposed to the model making nothing. */
const REFUSED_FINISH = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION']);
const REFUSED_WORDS: Record<string, string> = {
  SPII: 'it may hold personal information',
  RECITATION: 'it may repeat protected material',
  IMAGE_RECITATION: 'it may repeat protected material',
  BLOCKLIST: 'it holds a blocked term',
};

/** The models list has no field for image output, so this goes by name. */
const IMAGE_MODEL = /image|nano.?banana/i;
const NOT_GENERATOR = /^imagen|embedding/i;
const MAX_PAGES = 5;

const isVertex = (instance: ImageInstance) => URL.parse(instance.baseUrl)?.hostname.endsWith('aiplatform.googleapis.com') ?? false;
const root = (instance: ImageInstance) => instance.baseUrl.replace(/\/v1(?:beta)?$/, '');
const headers = (instance: ImageInstance): Record<string, string> => ({ 'content-type': 'application/json', ...instance.headers, ...(instance.apiKey ? { 'x-goog-api-key': instance.apiKey } : {}) });

function generateUrl(instance: ImageInstance, model: string): string {
  const name = encodeURIComponent(model);
  return `${root(instance)}${isVertex(instance) ? '/v1/publishers/google/models' : '/v1/models'}/${name}:generateContent`;
}

function body(request: ImageRequest): Record<string, unknown> {
  const images = request.references.map((image) => ({ inline_data: { mime_type: image.mime, data: toBase64(image.bytes) } }));
  const imageConfig = { ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}), ...(request.sizeClass ? { imageSize: request.sizeClass } : {}) };
  return {
    contents: [{ parts: [{ text: request.prompt }, ...images] }],
    generationConfig: {
      // Asking for text as well has been reported to fall back to 1K whatever `imageSize` says, and nothing here reads text.
      responseModalities: ['IMAGE'],
      ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
    },
  };
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(generateUrl(instance, request.model), { method: 'POST', headers: headers(instance), body: JSON.stringify(body(request)), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const answer = rec(await res.json());
  const blocked = str(rec(answer.promptFeedback).blockReason);
  if (blocked && blocked !== 'BLOCK_REASON_UNSPECIFIED') {
    yield refusal(instance, str(rec(answer.promptFeedback).blockReasonMessage));
    return;
  }
  const candidate = rec(arr(answer.candidates)[0]);
  let images = 0;
  for (const part of arr(rec(candidate.content).parts).filter(isRecord)) {
    // Thinking makes up to two interim images, flagged `thought`: only the rest are the answer.
    if (part.thought === true) continue;
    const inline = rec(part.inlineData ?? part.inline_data);
    const data = str(inline.data);
    if (!data) continue;
    images++;
    yield { type: 'image', bytes: Buffer.from(data, 'base64') };
  }
  if (images > 0) {
    yield { type: 'finish', reason: 'done' };
    return;
  }
  const reason = str(candidate.finishReason) ?? '';
  if (REFUSED_FINISH.has(reason)) yield refusal(instance, REFUSED_WORDS[reason]);
  else yield noImage(instance, reason || undefined, reason === 'NO_IMAGE' || reason === 'IMAGE_OTHER' || reason === 'OTHER');
}

export function createGemini(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const listed = (id: string, source: ListedImageModel['source'], extra: { displayName?: string; description?: string } = {}) => listedModel(instance, id, lookUp(GEMINI_MODELS, id), source, extra);
  const typedIn = () => instance.models.map((id) => listed(id, 'default'));

  async function discovered(signal?: AbortSignal): Promise<ListedImageModel[]> {
    const found: ListedImageModel[] = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = `pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const json = rec(await requestJson(deps, instance, `${root(instance)}/v1beta/models?${query}`, { headers: headers(instance), ...(signal ? { signal } : {}) }));
      for (const model of arr(json.models).filter(isRecord)) {
        const id = str(model.name)?.replace(/^models\//, '');
        const displayName = str(model.displayName);
        if (!id || NOT_GENERATOR.test(id) || !IMAGE_MODEL.test(`${id} ${displayName ?? ''}`)) continue;
        if (!strings(model.supportedGenerationMethods).includes('generateContent')) continue;
        const description = str(model.description);
        found.push(listed(id, 'detected', { ...(displayName ? { displayName } : {}), ...(description ? { description } : {}) }));
      }
      pageToken = str(json.nextPageToken) ?? '';
      if (!pageToken) break;
    }
    return found;
  }

  return {
    type: 'gemini',
    async listModels(signal) {
      // Express mode on Vertex has no list of models.
      if (isVertex(instance)) return typedIn();
      const typed = new Set(instance.models);
      return [...typedIn(), ...(await discovered(signal)).filter((m) => !typed.has(m.modelId))];
    },
    health(signal) {
      if (isVertex(instance)) return Promise.resolve({ ok: true, latencyMs: null, warnings: [] });
      return probe(deps, instance, `${root(instance)}/v1beta/models?pageSize=1`, headers(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request));
    },
  };
}
