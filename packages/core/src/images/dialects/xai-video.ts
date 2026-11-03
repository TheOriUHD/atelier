/**
 * xAI video (Grok Imagine): submit to `/v1/videos/generations`, poll `/v1/videos/{request_id}`, download the clip from the
 * URL it names. Read on 2026-11-03: https://docs.x.ai/developers/model-capabilities/video/generation,
 * https://docs.x.ai/developers/model-capabilities/video/image-to-video, https://docs.x.ai/developers/rest-api-reference/inference/videos.
 *
 * Left out because the docs don't pin them down: a last frame (its JSON shape isn't in the schema), reference images,
 * keyframes, and any way to cancel a job (none is documented).
 */
import { probe } from '../../providers/http.ts';
import { dataUrl, isRecord, num, rec, str } from '../../providers/util.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { failure, failureOf, listedModel, noImage, refusal, soundsRefused, usageEvent, waitFor } from './hosted.ts';
import { hostedVideo } from './video-common.ts';

const POLL_MS = 5_000;
const MAX_POLL_FAILURES = 5;
export const XAI_VIDEO_MODELS = ['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite', 'grok-imagine-video'];

const headers = (instance: ImageInstance): Record<string, string> => ({ 'content-type': 'application/json', ...instance.headers, ...(instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {}) });

/** The classic model stops at 720p; the 1.5 models list 1080p (the lite one upscales it). */
const capabilitiesOf = (model: string) =>
  hostedVideo({
    family: 'grok-imagine-video',
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
    resolutions: model === 'grok-imagine-video' ? ['480p', '720p'] : ['480p', '720p', '1080p'],
    durations: { kind: 'range', min: 1, max: 15, step: 1 },
    defaultSeconds: 5,
    firstFrame: true,
    audio: 'optional',
  });

function body(request: ImageRequest): Record<string, unknown> {
  const video = request.video!;
  return {
    model: request.model,
    prompt: request.prompt,
    duration: video.seconds,
    ...(video.resolution ? { resolution: video.resolution } : {}),
    // Ignored by the service for image to video, where the picture sets the shape.
    ...(request.aspectRatio && !video.firstFrame ? { aspect_ratio: request.aspectRatio } : {}),
    ...(video.audio !== undefined ? { generate_audio: video.audio } : {}),
    ...(video.firstFrame ? { image: { url: dataUrl(video.firstFrame.mime, video.firstFrame.bytes) } } : {}),
  };
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, pollMs: number): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/v1/videos/generations`, { method: 'POST', headers: headers(instance), body: JSON.stringify(body(request)), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const id = str(rec(await res.json()).request_id);
  if (!id) {
    yield noImage(instance, 'its answer named no job');
    return;
  }
  let failures = 0;
  for (;;) {
    const poll = await deps.fetch(`${instance.baseUrl}/v1/videos/${encodeURIComponent(id)}`, { method: 'GET', headers: headers(instance), signal: request.signal });
    if (!poll.ok) {
      if (!(poll.status === 429 || poll.status >= 500) || ++failures > MAX_POLL_FAILURES) {
        yield await failureOf(instance, poll);
        return;
      }
    } else {
      failures = 0;
      const job = rec(await poll.json());
      const status = str(job.status);
      if (status === 'pending') {
        const progress = num(job.progress);
        yield progress !== undefined ? { type: 'progress', fraction: Math.min(1, progress / 100) } : { type: 'progress' };
      } else if (status === 'done') {
        const video = rec(job.video);
        const url = str(video.url);
        // xAI blanks a clip its moderation caught, and says so.
        if (!url || video.respect_moderation === false) {
          yield refusal(instance, 'the clip was held back by moderation');
          return;
        }
        const usage = usageEvent(job.usage);
        if (usage) yield usage;
        yield { type: 'video', url };
        yield { type: 'finish', reason: 'done' };
        return;
      } else if (status === 'failed' || status === 'expired') {
        const error = isRecord(job.error) ? job.error : {};
        const code = str(error.code) ?? '';
        const message = str(error.message) ?? `the job ${status}`;
        yield code === 'permission_denied' || soundsRefused(message)
          ? refusal(instance, message)
          : failure({ code: 'provider_error', message: `${instance.name}: ${message}`, retryable: code === 'service_unavailable' || code === 'internal_error' });
        return;
      } else {
        yield noImage(instance, 'its status made no sense');
        return;
      }
    }
    await waitFor(pollMs, request.signal);
  }
}

export function createXaiVideo(instance: ImageInstance, deps: ImageAdapterDeps, options: { pollMs?: number } = {}): ImageAdapter {
  const pollMs = options.pollMs ?? POLL_MS;
  return {
    type: 'xai-video',
    async listModels() {
      // The API lists no video models apart from the others, so these are the documented ones, and any typed in.
      const ids = [...new Set([...XAI_VIDEO_MODELS, ...instance.models])];
      return ids.map((id) => listedModel(instance, id, capabilitiesOf(id), instance.models.includes(id) ? 'default' : 'catalog'));
    },
    health(signal) {
      return probe(deps, instance, `${instance.baseUrl}/v1/models`, headers(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request, pollMs));
    },
  };
}
