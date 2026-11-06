/**
 * Stability AI's Stable Audio: multipart under `/v2beta/audio`. Stable Audio 3 takes the job and answers `202` with an
 * id, polled at `/v2beta/audio/results/{id}` until the sound comes; Stable Audio 2.5 answers with the sound at once. Both
 * make music and sound effects (an effect is asked for with a `TrackType: SFX` line in the prompt) and no vocals worth
 * the name. Its moderation answers 403 or 422, which is a refusal.
 *
 * Read on 2026-11-06: https://docs.stability.ai/api-reference/stable-audio/text-to-audio.md,
 * https://docs.stability.ai/api-reference/stable-audio-2/text-to-audio.md
 */
import { str } from '../../providers/util.ts';
import { multipart, type MultipartField } from '../multipart.ts';
import type { ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest, ListedImageModel } from '../types.ts';
import { soundFrom, soundModel } from './audio-common.ts';
import { failureOf, listedModel, noImage, waitFor } from './hosted.ts';

const POLL_MS = 2_000;
const MAX_POLL_FAILURES = 5;

const MODELS = [
  { id: 'stable-audio-3', name: 'Stable Audio 3', max: 380, async: true },
  { id: 'stable-audio-2.5', name: 'Stable Audio 2.5', max: 190, async: false },
];

const authorized = (instance: ImageInstance, accept: string): Record<string, string> => ({ ...instance.headers, accept, ...(instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {}) });

export function stabilityAudioModels(instance: ImageInstance): ListedImageModel[] {
  const extra = instance.models.filter((id) => !MODELS.some((m) => m.id === id));
  return [...MODELS, ...extra.map((id) => ({ id, name: id, max: 190, async: false }))].map((m) =>
    listedModel(instance, m.id, soundModel({ kinds: ['music', 'sound'], durations: { kind: 'range', min: 1, max: m.max, step: 1 }, defaultSeconds: 30, lyrics: false, vocals: 'none' }, { seed: true }), extra.includes(m.id) ? 'default' : 'catalog', { displayName: m.name }),
  );
}

export function stabilityAudioForm(request: ImageRequest): MultipartField[] {
  const audio = request.audio!;
  const prompt = audio.kind === 'sound' && !/TrackType:\s*SFX/i.test(request.prompt) ? `${request.prompt}\nTrackType: SFX` : request.prompt;
  return [
    { name: 'prompt', value: prompt },
    { name: 'model', value: request.model },
    ...(audio.seconds !== undefined ? [{ name: 'duration', value: String(Math.round(audio.seconds)) }] : []),
    ...(request.seed !== undefined ? [{ name: 'seed', value: String(request.seed) }] : []),
    { name: 'output_format', value: 'mp3' },
  ];
}

const refused = (status: number) => status === 403 || status === 422;

export async function* stabilityAudio(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const later = MODELS.find((m) => m.id === request.model)?.async ?? false;
  const path = later ? '/v2beta/audio/stable-audio/text-to-audio' : '/v2beta/audio/stable-audio-2/text-to-audio';
  const { body, contentType } = multipart(stabilityAudioForm(request));
  const res = await deps.fetch(`${instance.baseUrl}${path}`, { method: 'POST', headers: { ...authorized(instance, later ? 'application/json' : 'audio/*'), 'content-type': contentType }, body, signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res, refused);
    return;
  }
  if (res.status !== 202) {
    const sound = await soundFrom(res);
    yield sound ?? noImage(instance, 'its answer had no sound');
    if (sound) yield { type: 'finish', reason: 'done' };
    return;
  }
  const id = str(((await res.json()) as Record<string, unknown>).id);
  if (!id) {
    yield noImage(instance, 'it took the job without saying which it was');
    return;
  }
  yield { type: 'queued', ahead: 0 };
  let failures = 0;
  for (;;) {
    await waitFor(POLL_MS, request.signal);
    const poll = await deps.fetch(`${instance.baseUrl}/v2beta/audio/results/${encodeURIComponent(id)}`, { method: 'GET', headers: authorized(instance, 'audio/*'), signal: request.signal }).catch((e: unknown) => {
      if (request.signal.aborted) throw e;
      return null;
    });
    if (!poll || poll.status >= 500) {
      if (++failures > MAX_POLL_FAILURES) {
        yield noImage(instance, 'it stopped answering while the sound was made', true);
        return;
      }
      continue;
    }
    if (poll.status === 202) {
      yield { type: 'progress' };
      continue;
    }
    if (!poll.ok) {
      yield await failureOf(instance, poll, refused);
      return;
    }
    const sound = await soundFrom(poll);
    yield sound ?? noImage(instance, 'its answer had no sound');
    if (sound) yield { type: 'finish', reason: 'done' };
    return;
  }
}
