/**
 * ACE-Step 1.5's own API server (`acestep-api`, port 8001): music with or without vocals from a description and lyrics.
 * A job goes in at `POST /release_task` and is polled at `POST /query_result` until its file is ready; the file is then
 * read from the server's `/v1/audio?path=…`. Every answer is wrapped as `{data, code, error}`.
 *
 * Read on 2026-11-06: https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md
 */
import { probe, requestJson } from '../../providers/http.ts';
import { arr, isRecord, num, rec, str } from '../../providers/util.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { soundFrom, soundModel } from './audio-common.ts';
import { assertOwnHost, failureOf, listedModel, noImage, waitFor } from './hosted.ts';

const POLL_MS = 1_500;
const MAX_POLL_FAILURES = 5;
const MODEL = 'ace-step-1.5';

const headers = (instance: ImageInstance): Record<string, string> => ({ 'content-type': 'application/json', ...instance.headers, ...(instance.apiKey ? { authorization: `Bearer ${instance.apiKey}` } : {}) });

/** `{data, code, error}`: the data when the code says it worked, else the error to show. */
function unwrap(body: unknown): { data: unknown; error?: string } {
  const top = rec(body);
  const code = num(top.code);
  if (code !== undefined && code !== 0 && code !== 200) return { data: null, error: str(top.error) ?? str(top.message) ?? `error ${code}` };
  return { data: top.data ?? body };
}

export function aceStepBody(request: ImageRequest): Record<string, unknown> {
  const audio = request.audio!;
  return {
    task_type: 'text2music',
    prompt: request.prompt,
    // An empty set of lyrics with the instrumental tag is how ACE-Step is asked for no vocals.
    lyrics: audio.instrumental ? '[instrumental]' : (audio.lyrics ?? ''),
    ...(audio.seconds !== undefined ? { audio_duration: Math.round(audio.seconds) } : {}),
    ...(audio.language ? { vocal_language: audio.language } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.tuning.steps !== undefined ? { inference_steps: request.tuning.steps } : {}),
    audio_format: 'mp3',
    batch_size: 1,
    thinking: false,
  };
}

async function* run(instance: ImageInstance, deps: ImageAdapterDeps, request: ImageRequest): AsyncGenerator<ImageEvent> {
  const res = await deps.fetch(`${instance.baseUrl}/release_task`, { method: 'POST', headers: headers(instance), body: JSON.stringify({ ...aceStepBody(request), ...(request.model !== MODEL ? { model: request.model } : {}) }), signal: request.signal });
  if (!res.ok) {
    yield await failureOf(instance, res);
    return;
  }
  const started = unwrap(await res.json());
  const id = str(rec(started.data).task_id);
  if (started.error || !id) {
    yield noImage(instance, started.error ?? 'it took the job without saying which it was');
    return;
  }
  yield { type: 'queued', ahead: 0 };
  let failures = 0;
  for (;;) {
    await waitFor(POLL_MS, request.signal);
    const polled = await requestJson(deps, instance, `${instance.baseUrl}/query_result`, { method: 'POST', headers: headers(instance), body: { task_id_list: [id] }, signal: request.signal }).catch((e: unknown) => {
      if (request.signal.aborted) throw e;
      return null;
    });
    if (polled === null) {
      if (++failures > MAX_POLL_FAILURES) {
        yield noImage(instance, 'it stopped answering while the music was made', true);
        return;
      }
      continue;
    }
    const { data, error } = unwrap(polled);
    const entry = rec(arr(data).find((d) => isRecord(d) && (str(d.task_id) ?? id) === id) ?? (isRecord(data) ? data : {}));
    const status = num(entry.status);
    if (error || status === 2) {
      yield noImage(instance, error ?? str(entry.error) ?? 'the job failed');
      return;
    }
    if (status !== 1) {
      yield { type: 'progress', ...(num(entry.progress) !== undefined ? { fraction: Math.min(1, Math.max(0, num(entry.progress)!)) } : {}) };
      continue;
    }
    // `result` is JSON in a string, with the file's path on this server.
    let result: unknown = entry.result;
    if (typeof result === 'string') result = JSON.parse(result) as unknown;
    const first = Array.isArray(result) ? result[0] : result;
    const file = str(rec(first).file) ?? str(rec(first).url) ?? str(rec(first).audio_path);
    if (!file) {
      yield noImage(instance, 'its answer had no file');
      return;
    }
    const url = assertOwnHost(instance, new URL(file, `${instance.baseUrl}/`).href);
    const download = await deps.fetch(url, { method: 'GET', headers: headers(instance), signal: request.signal });
    if (!download.ok) {
      yield await failureOf(instance, download);
      return;
    }
    const sound = await soundFrom(download);
    yield sound ?? noImage(instance, 'its file was empty');
    if (sound) yield { type: 'finish', reason: 'done' };
    return;
  }
}

export function createAceStep(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  return {
    type: 'acestep',
    async listModels(signal) {
      const body = await requestJson(deps, instance, `${instance.baseUrl}/v1/models`, { headers: headers(instance), ...(signal ? { signal } : {}) }).catch(() => null);
      const reported = arr(rec(unwrap(body).data).models ?? unwrap(body).data)
        .map((m) => (typeof m === 'string' ? m : (str(rec(m).name) ?? str(rec(m).id))))
        .filter((m): m is string => !!m);
      const ids = [...new Set([...(reported.length ? reported : [MODEL]), ...instance.models])];
      return ids.map((id) =>
        listedModel(instance, id, soundModel({ kinds: ['music'], durations: { kind: 'range', min: 10, max: 600, step: 1 }, defaultSeconds: 60, lyrics: true, vocals: 'optional' }, { family: 'ace-step', seed: true, promptStyle: 'tags', tunable: true, defaults: { steps: 8 } }), reported.includes(id) ? 'detected' : 'default', { displayName: id === MODEL ? 'ACE-Step 1.5' : id }),
      );
    },
    health(signal) {
      return probe(deps, instance, `${instance.baseUrl}/health`, headers(instance), signal);
    },
    generate(request) {
      return guardImages(request, instance, () => run(instance, deps, request));
    },
  };
}
