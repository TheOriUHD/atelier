/**
 * OpenRouter video: submit a job, poll it, download the clip with the key. Read on 2026-11-03:
 * https://openrouter.ai/docs/guides/overview/multimodal/video-generation and the live answer of
 * https://openrouter.ai/api/v1/videos/models (its fields are used as it sends them).
 *
 * Not verified: that `frame_images` accepts a data URL (every example in the docs is an https URL), and any way to
 * cancel (none is documented, so stopping only stops waiting: the job may still be billed).
 */
import { requestJson, probe } from '../../providers/http.ts';
import { arr, dataUrl, isRecord, rec, str } from '../../providers/util.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { assertOwnHost, failure, failureOf, listedModel, noImage, refusal, soundsRefused, usageEvent, waitFor } from './hosted.ts';
import { hostedVideo, readClip, usualSeconds } from './video-common.ts';

const POLL_MS = 10_000;
const MAX_POLL_FAILURES = 5;

const headers = (instance: ImageInstance): Record<string, string> => ({ 'content-type': 'application/json', ...instance.headers, ...(instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {}) });

function describeModel(instance: ImageInstance, model: Record<string, unknown>): ListedImageModel | null {
  const id = str(model.id);
  const seconds = arr(model.supported_durations).filter((d): d is number => typeof d === 'number' && d > 0);
  // A model that takes no duration works on a video you give it (edit, upscale): GenerateVideo makes new ones.
  if (!id || seconds.length === 0) return null;
  const frames = arr(model.supported_frame_images).map(String);
  return listedModel(
    instance,
    id,
    hostedVideo({
      family: 'openrouter-video',
      ratios: arr(model.supported_aspect_ratios).map(String),
      resolutions: arr(model.supported_resolutions).map(String),
      durations: { kind: 'list', seconds: [...seconds].sort((a, b) => a - b) },
      defaultSeconds: usualSeconds(seconds),
      firstFrame: frames.includes('first_frame'),
      lastFrame: frames.includes('last_frame'),
      audio: model.generate_audio === true ? 'optional' : 'none',
      seed: model.seed === true,
    }),
    'detected',
    { displayName: str(model.name) ?? id },
  );
}

function body(request: ImageRequest): Record<string, unknown> {
  const video = request.video!;
  const frames = [
    ...(video.firstFrame ? [{ type: 'image_url', image_url: { url: dataUrl(video.firstFrame.mime, video.firstFrame.bytes) }, frame_type: 'first_frame' }] : []),
    ...(video.lastFrame ? [{ type: 'image_url', image_url: { url: dataUrl(video.lastFrame.mime, video.lastFrame.bytes) }, frame_type: 'last_frame' }] : []),
  ];
  return {
    model: request.model,
    prompt: request.prompt,
    duration: video.seconds,
    ...(video.resolution ? { resolution: video.resolution } : {}),
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
    ...(video.audio !== undefined && request.capabilities.video?.audio === 'optional' ? { generate_audio: video.audio } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(frames.length ? { frame_images: frames } : {}),
  };
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest, pollMs: number): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/v1/videos`, { method: 'POST', headers: headers(instance), body: JSON.stringify(body(request)), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const submitted = rec(await res.json());
  const pollingUrl = str(submitted.polling_url) ?? (str(submitted.id) ? `${instance.baseUrl}/v1/videos/${encodeURIComponent(str(submitted.id)!)}` : undefined);
  if (!pollingUrl) {
    yield noImage(instance, 'its answer named no job');
    return;
  }
  // The key goes to this address on every poll, whatever the answer said.
  assertOwnHost(instance, pollingUrl);
  let failures = 0;
  for (;;) {
    const poll = await deps.fetch(pollingUrl, { method: 'GET', headers: headers(instance), signal: request.signal });
    if (!poll.ok) {
      if (!(poll.status === 429 || poll.status >= 500) || ++failures > MAX_POLL_FAILURES) {
        yield await failureOf(instance, poll);
        return;
      }
    } else {
      failures = 0;
      const job = rec(await poll.json());
      const status = str(job.status);
      if (status === 'pending') yield { type: 'loading', what: 'Waiting for a free slot' };
      else if (status === 'in_progress') yield { type: 'progress' };
      else if (status === 'completed') {
        const url = str(arr(job.unsigned_urls)[0]);
        if (!url) {
          yield noImage(instance, 'the finished job had no video');
          return;
        }
        assertOwnHost(instance, url);
        const content = await deps.fetch(url, { method: 'GET', headers: headers(instance), signal: request.signal });
        if (!content.ok) {
          yield await failureOf(instance, content);
          return;
        }
        const usage = usageEvent(job.usage);
        if (usage) yield usage;
        yield { type: 'video', bytes: await readClip(content) };
        yield { type: 'finish', reason: 'done' };
        return;
      } else if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        const message = str(job.error) ?? (isRecord(job.error) ? str(job.error.message) : undefined) ?? `the job ${status}`;
        yield soundsRefused(message) ? refusal(instance, message) : failure({ code: 'provider_error', message: `${instance.name}: ${message}`, retryable: false });
        return;
      } else {
        yield noImage(instance, 'its status made no sense');
        return;
      }
    }
    await waitFor(pollMs, request.signal);
  }
}

export function createOpenRouterVideo(instance: ImageInstance, deps: ImageAdapterDeps, options: { pollMs?: number } = {}): ImageAdapter {
  const pollMs = options.pollMs ?? POLL_MS;
  return {
    type: 'openrouter-video',
    async listModels(signal) {
      const answer = rec(await requestJson(deps, instance, `${instance.baseUrl}/v1/videos/models`, { headers: headers(instance), ...(signal ? { signal } : {}) }));
      return arr(answer.data).filter(isRecord).flatMap((model) => describeModel(instance, model) ?? []);
    },
    health(signal) {
      return probe(deps, instance, `${instance.baseUrl}/v1/videos/models`, headers(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request, pollMs));
    },
  };
}
