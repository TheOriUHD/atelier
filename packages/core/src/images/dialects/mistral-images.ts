/**
 * Mistral has no image endpoint of its own: a chat model calls the built-in `image_generation` tool (Black Forest Labs'
 * FLUX1.1 [pro] Ultra, as Mistral announced it) through the Conversations API, without creating an agent. Mistral runs
 * the tool and answers with file ids, and each image is downloaded from the Files API with the same key. `store: false`
 * keeps the conversation out of the account.
 *
 * Read on 2026-11-06: https://docs.mistral.ai/studio/agents/agent-tools/image_generation,
 * https://docs.mistral.ai/api (Conversations: start a conversation, Files: download a file),
 * https://docs.mistral.ai/resources/error-glossary. Not verified against a live key.
 */
import type { ImageCapabilities } from '@atelier/protocol';
import { bearer, classifyError, jsonHeaders, probe, redact } from '../../providers/http.ts';
import { sniffMime } from '../../providers/images.ts';
import { mistralErrorMessage } from '../../providers/mistral.ts';
import { apiUrl, arr, isRecord, num, rec, str } from '../../providers/util.ts';
import { HOSTED_DEFAULTS } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import { parseRatio } from '../params.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { failure, listedModel, noImage, refusal, soundsRefused, waitFor, type ImageFinish } from './hosted.ts';

/** The one image model is the tool, whatever Mistral runs behind it. Named so it matches no list price. */
const MODEL_ID = 'image_generation';
/**
 * The chat model that calls the tool, as in Mistral's own example for it. Each image also costs its tokens. Any current
 * Mistral chat model that calls tools would do.
 */
const CHAT_MODEL = 'mistral-medium-latest';
/**
 * Makes the model call a tool instead of answering in words. Mistral's schema lists `tool_choice` (`auto`, `none`,
 * `any`, `required`) among the Conversations `completion_args`, but no page shows it with a built-in tool. If Mistral
 * turns it down, `start` sends the request again without it, and this is the one place to change it.
 */
const FORCE_TOOL = { tool_choice: 'any' } as const;
const INSTRUCTIONS = [
  'You make images and nothing else.',
  'Call the image_generation tool exactly once.',
  'The message is a description of the image, and its last line may give an aspect ratio.',
  'Give the tool the description word for word, followed by that aspect ratio.',
  'Do not reword, shorten or add to the description, do not ask questions, and write no text of your own.',
].join(' ');
/** FLUX1.1 [pro] Ultra makes shapes from 21:9 to 9:21. */
const RATIOS = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '21:9', '9:21'];
/** How a chat model words a no. Only read when no image came, and "I couldn't" stays a failure: it may be a fault. */
const DECLINED = /\b(?:unable to|not able to|can(?:no|['’])?t|won['’]t|will not) (?:help|assist|create|generate|make|produce|draw)\b/i;
/** A download that fails for a moment mustn't lose an image that's already paid for. */
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_MS = 1_000;

/**
 * The tool takes only words: the shape goes into the text, and there's no size, seed, negative prompt or input image.
 * One image per call, as the tool is asked for once.
 */
export const MISTRAL_IMAGE_CAPABILITIES: ImageCapabilities = { ...HOSTED_DEFAULTS, family: 'mistral-images', sizes: { kind: 'aspect', ratios: RATIOS, classes: [] }, maxCount: 1 };

const orientation = (ratio: string): string => {
  const value = parseRatio(ratio) ?? 1;
  return value > 1 ? 'landscape' : value < 1 ? 'portrait' : 'square';
};

/** What the chat model reads: the description as given, then the shape on its own line. */
const inputs = (request: ImageRequest): string => (request.aspectRatio ? `${request.prompt}\n\nAspect ratio: ${request.aspectRatio} (${orientation(request.aspectRatio)})` : request.prompt);

const body = (request: ImageRequest, force: boolean): Record<string, unknown> => ({
  model: CHAT_MODEL,
  inputs: inputs(request),
  instructions: INSTRUCTIONS,
  tools: [{ type: 'image_generation' }],
  ...(force ? { completion_args: FORCE_TOOL } : {}),
  stream: false,
  store: false,
});

/** Mistral's error body as a sentence, a 422's list of fields included (the text adapter's reading). */
const errorMessage = mistralErrorMessage;

function errorKind(raw: string): string {
  try {
    const json = rec(JSON.parse(raw));
    return str(json.type) ?? str(rec(json.error).type) ?? '';
  } catch {
    return '';
  }
}

async function failed(instance: ImageInstance, res: Response): Promise<ImageFinish> {
  const raw = await res.text().catch(() => '');
  const message = errorMessage(raw) || res.statusText;
  if ((res.status === 400 || res.status === 403 || res.status === 422) && soundsRefused(message)) return refusal(instance, message);
  return failure(classifyError(instance, res.status, errorKind(raw), message));
}

async function start(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): Promise<Response> {
  const post = (force: boolean) => deps.fetch(apiUrl(instance.baseUrl, '/v1/conversations'), { method: 'POST', headers: jsonHeaders(instance, bearer(instance)), body: JSON.stringify(body(request, force)), signal: request.signal });
  const res = await post(true);
  // Turned down for the forced tool: the instructions alone still ask for it.
  if ((res.status === 400 || res.status === 422) && /tool_choice/.test(await res.clone().text().catch(() => ''))) return post(false);
  return res;
}

/** The files the tool made, and what the model wrote, from every message in the answer. */
function readAnswer(answer: Record<string, unknown>): { files: string[]; text: string; toolRan: boolean } {
  const files: string[] = [];
  const text: string[] = [];
  let toolRan = false;
  for (const entry of arr(answer.outputs).filter(isRecord)) {
    if (entry.type === 'tool.execution' && entry.name === 'image_generation') toolRan = true;
    if (entry.type !== 'message.output') continue;
    if (typeof entry.content === 'string') {
      text.push(entry.content);
      continue;
    }
    for (const chunk of arr(entry.content).filter(isRecord)) {
      const fileId = str(chunk.file_id);
      // Only the image tool is offered, so every file is one of its images.
      if (chunk.type === 'tool_file' && fileId) files.push(fileId);
      else if (chunk.type === 'text') text.push(str(chunk.text) ?? '');
    }
  }
  return { files, text: text.join('').trim(), toolRan };
}

/** One image's bytes, or why they couldn't be had. */
async function download(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, fileId: string, retryMs: number): Promise<Uint8Array | ImageFinish> {
  const url = apiUrl(instance.baseUrl, `/v1/files/${encodeURIComponent(fileId)}/content`);
  for (let attempt = 1; ; attempt++) {
    const res = await deps.fetch(url, { method: 'GET', headers: { ...instance.headers, ...bearer(instance), accept: 'application/octet-stream' }, signal: request.signal });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (attempt < DOWNLOAD_ATTEMPTS && (res.status === 429 || res.status >= 500)) {
      await waitFor(retryMs, request.signal);
      continue;
    }
    const raw = await res.text().catch(() => '');
    const detail = redact(errorMessage(raw), instance);
    // Asking again would make, and pay for, another image.
    return failure({ code: classifyError(instance, res.status, errorKind(raw), detail).code, message: `${instance.name} made the image, but downloading it failed (${res.status})${detail ? `: ${detail}` : '.'}`, retryable: false });
  }
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, retryMs: number): AsyncGenerator<ImageEvent> {
  const res = await start(instance, deps, request);
  if (!res.ok) {
    yield await failed(instance, res);
    return;
  }
  const answer = rec(await res.json());
  const { files, text, toolRan } = readAnswer(answer);
  const usage = rec(answer.usage);
  const input = num(usage.prompt_tokens);
  const output = num(usage.completion_tokens);
  if (input !== undefined || output !== undefined) yield { type: 'usage', ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };

  let images = 0;
  let trouble: ImageFinish | undefined;
  for (const fileId of files) {
    const got = await download(instance, deps, request, fileId, retryMs);
    if (!(got instanceof Uint8Array)) {
      trouble ??= got;
      continue;
    }
    const mime = sniffMime(got);
    if (!mime) {
      trouble ??= noImage(instance, "the file it made isn't an image Atelier can show");
      continue;
    }
    images++;
    yield { type: 'image', bytes: got, mime };
  }
  if (trouble) yield trouble;
  else if (images > 0) yield { type: 'finish', reason: 'done' };
  // A chat model says no in its own words, and so does it when the image tool's filter stops a picture.
  else if (soundsRefused(text) || DECLINED.test(text)) yield refusal(instance, text);
  else yield noImage(instance, text || (toolRan ? 'its image tool ran and returned no file' : 'its chat model answered without calling the image tool'));
}

export function createMistralImages(instance: ImageInstance, deps: ImageAdapterDeps, options: { retryMs?: number } = {}): ImageAdapter {
  return {
    type: 'mistral-images',
    listModels: () => Promise.resolve([listedModel(instance, MODEL_ID, MISTRAL_IMAGE_CAPABILITIES, 'catalog', { displayName: 'Mistral image generation (FLUX)' })]),
    // Listing the models proves the key without making an image.
    health: (signal) => probe(deps, instance, apiUrl(instance.baseUrl, '/v1/models'), { ...instance.headers, ...bearer(instance) }, signal),
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request, options.retryMs ?? DOWNLOAD_RETRY_MS));
    },
  };
}
