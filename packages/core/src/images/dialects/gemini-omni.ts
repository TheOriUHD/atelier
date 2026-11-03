/**
 * Gemini Omni video. Veo is gone from the Gemini API (the preview models shut down on 2026-10-22, the older ones on
 * 2026-06-30; the GA models are on Google Cloud, with its own sign-in), and `predictLongRunning` isn't documented for
 * anything now. What the API offers is Gemini Omni: one `POST /v1beta/interactions` that answers with the finished video.
 *
 * Read on 2026-11-03: https://aistudio.google.com/docs/omni, https://aistudio.google.com/docs/video,
 * https://aistudio.google.com/docs/deprecations, https://aistudio.google.com/docs/pricing.
 *
 * It takes no length, seed or negative prompt, so the model chooses the length. The first and last frame as two images
 * with prompt tags isn't shown in a complete example, so only a first frame is sent. Not verified: the shape of a
 * safety block (any answer without a finished video is read as a refusal or an error by its words).
 */
import { arr, isRecord, rec, str, toBase64 } from '../../providers/util.ts';
import { probe } from '../../providers/http.ts';
import type { ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { failure, failureOf, noImage, refusal, soundsRefused, waitFor } from './hosted.ts';
import { hostedVideo, readClip } from './video-common.ts';

export const OMNI_MODELS = ['gemini-omni-1.1-flash'];
const FILE_POLL_MS = 3_000;
const MAX_FILE_POLLS = 100;

export const omniCapabilities = hostedVideo({
  family: 'gemini-omni',
  ratios: ['16:9', '9:16'],
  // 1080p and 4k are upscaled from the generated size.
  resolutions: ['360p', '720p', '1080p', '4k'],
  durations: { kind: 'list', seconds: [8] },
  defaultSeconds: 8,
  fixedLength: true,
  firstFrame: true,
  // The sound is always generated; the prompt steers it.
  audio: 'always',
});

const root = (instance: ImageInstance) => instance.baseUrl.replace(/\/v1(?:beta)?$/, '');
const headers = (instance: ImageInstance): Record<string, string> => ({ 'content-type': 'application/json', ...instance.headers, ...(instance.apiKey ? { 'x-goog-api-key': instance.apiKey } : {}) });

function body(request: ImageRequest): Record<string, unknown> {
  const video = request.video!;
  const first = video.firstFrame;
  return {
    model: request.model,
    input: first ? [{ type: 'image', data: toBase64(first.bytes), mime_type: first.mime }, { type: 'text', text: request.prompt }] : request.prompt,
    // Nothing here is read back later, and a stored interaction can't be combined with the rest.
    store: false,
    response_format: {
      type: 'video',
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(video.resolution ? { resolution: video.resolution } : {}),
      // A hosted file for anything large: inline video in JSON is base64.
      delivery: 'uri',
    },
    ...(first ? { generation_config: { video_config: { task: 'image_to_video' } } } : {}),
  };
}

/** The finished clip in an interaction: inline bytes or the address of a file. */
function videoItem(answer: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const step of arr(answer.steps).filter(isRecord)) {
    if (step.type !== 'model_output') continue;
    const item = arr(step.content).filter(isRecord).find((c) => c.type === 'video');
    if (item) return item;
  }
  return undefined;
}

/** The id of a Files API file from its address: `…/files/abc123:download?alt=media` or `files/abc123`. */
export function fileIdOf(uri: string): string | undefined {
  return /files\/([A-Za-z0-9_-]+)/.exec(uri)?.[1];
}

export async function* runOmni(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, pollMs = FILE_POLL_MS): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${root(instance)}/v1beta/interactions`, { method: 'POST', headers: headers(instance), body: JSON.stringify(body(request)), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const answer = rec(await res.json());
  const status = str(answer.status);
  const errors = arr(answer.errors).filter(isRecord).map((e) => str(e.message) ?? str(e.code) ?? '').filter(Boolean);
  const item = videoItem(answer);
  if (status !== 'completed' || !item) {
    const message = errors.join(' ') || (status && status !== 'completed' ? `the job ended as ${status}` : 'its answer had no video');
    // A blocked prompt or output comes back without a video; Google words it differently each time.
    yield !item && (soundsRefused(message) || status === 'incomplete') ? refusal(instance, errors.join(' ') || undefined) : status === 'completed' ? noImage(instance, message) : failure({ code: 'provider_error', message: `${instance.name}: ${message}`, retryable: false });
    return;
  }
  const data = str(item.data);
  if (data) {
    yield { type: 'video', bytes: Buffer.from(data, 'base64') };
    yield { type: 'finish', reason: 'done' };
    return;
  }
  const id = fileIdOf(str(item.uri) ?? '');
  if (!id) {
    yield noImage(instance, 'the video had no file');
    return;
  }
  // A hosted file is ready when its state says so; the key goes with every call, so only this service's own address is used.
  const fileUrl = `${root(instance)}/v1beta/files/${id}`;
  for (let polls = 0; ; polls++) {
    const file = await deps.fetch(fileUrl, { method: 'GET', headers: headers(instance), signal: request.signal });
    if (!file.ok) {
      yield await failureOf(instance, file);
      return;
    }
    const state = str(rec(await file.json()).state);
    if (state === 'ACTIVE') break;
    if (state === 'FAILED' || polls >= MAX_FILE_POLLS) {
      yield failure({ code: 'provider_error', message: `${instance.name} could not prepare the video file.`, retryable: false });
      return;
    }
    yield { type: 'progress' };
    await waitFor(pollMs, request.signal);
  }
  const download = await deps.fetch(`${fileUrl}:download?alt=media`, { method: 'GET', headers: headers(instance), signal: request.signal });
  if (!download.ok) {
    yield await failureOf(instance, download);
    return;
  }
  yield { type: 'video', bytes: await readClip(download) };
  yield { type: 'finish', reason: 'done' };
}

export const omniHealth = (instance: ImageInstance, deps: ImageAdapterDeps, signal?: AbortSignal) => probe(deps, instance, `${root(instance)}/v1beta/models?pageSize=1`, headers(instance), signal);
