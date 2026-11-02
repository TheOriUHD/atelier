/**
 * LocalAI behind the OpenAI images dialect, which copies the format's routes and then differs, going by its source: it
 * calls steps `step`, takes the negative prompt after a `|`, and has no `/v1/images/edits`, so the input picture is a
 * `file` field on the generation route. `/v1/models` lists its text models too; `/v1/models/capabilities` tells them apart.
 */
import type { ImageCapabilities } from '@atelier/protocol';
import { requestJson } from '../../providers/http.ts';
import { arr, rec, str, strings, toBase64 } from '../../providers/util.ts';
import { HOSTED_DEFAULTS, SQUARE } from '../catalog.ts';
import { checkpointFamily, editSize } from '../families.ts';
import type { ImageAdapterDeps, ImageInstance, ImageRequest } from '../types.ts';

type Headers = Record<string, string>;

const IMAGE_CAPABILITY = 'image';

/** Everything a local server's image model starts from; each server then says what it really takes. */
const LOCAL: ImageCapabilities = { ...HOSTED_DEFAULTS, family: 'local', sizes: SQUARE, seed: true };

export interface LocalModel {
  id: string;
  displayName?: string;
  capabilities: ImageCapabilities;
}

const family = (name: string) => {
  const { defaults, ...traits } = checkpointFamily(name);
  return { traits, defaults };
};

/** The request fields, changed for the server they're going to. */
export function localFields(instance: ImageInstance, request: ImageRequest, fields: Record<string, unknown>): Record<string, unknown> {
  if (instance.preset === 'localai') {
    const input = request.references[0];
    // A `|` in the prompt itself would cut it short and turn the rest into the negative prompt.
    const prompt = request.prompt.replaceAll('|', ',');
    return {
      ...fields,
      prompt: request.negativePrompt ? `${prompt}|${request.negativePrompt}` : prompt,
      ...(request.tuning.steps !== undefined ? { step: request.tuning.steps } : {}),
      ...(input ? { file: toBase64(input.bytes), ...editSizeField(request) } : {}),
    };
  }
  return fields;
}

const editSizeField = (request: ImageRequest) => {
  const { width, height } = editSize(request);
  return width && height ? { size: `${width}x${height}` } : {};
};

/** The body of an edit on a server that has no `/v1/images/edits`, and where it goes. Null: the usual route. */
export function localEdit(instance: ImageInstance, request: ImageRequest, fields: Record<string, unknown>): { url: string; body: Record<string, unknown> } | null {
  if (request.references.length === 0 || instance.preset !== 'localai') return null;
  return { url: `${instance.baseUrl}/v1/images/generations`, body: fields };
}

async function localAiModels(instance: ImageInstance, deps: ImageAdapterDeps, headers: Headers, signal?: AbortSignal): Promise<LocalModel[] | null> {
  const body = await requestJson(deps, instance, `${instance.baseUrl}/v1/models/capabilities`, { headers, ...(signal ? { signal } : {}) }).catch(() => null);
  // An older LocalAI, without the route: the name-based guess in the caller is all there is.
  if (!body) return null;
  return arr(rec(body).data).flatMap((entry) => {
    const model = rec(entry);
    const id = str(model.id);
    if (!id || !strings(model.capabilities).includes(IMAGE_CAPABILITY)) return [];
    const { traits, defaults } = family(id);
    return [{ id, capabilities: { ...LOCAL, ...traits, negativePrompt: true, edit: true, maxCount: 4, maxReferences: 1, tunable: true, defaults: { ...(defaults.steps ? { steps: defaults.steps } : {}) } } }];
  });
}

/** The models of a server with its own way of telling them apart. Null: use `/v1/models`. */
export function localModels(instance: ImageInstance, deps: ImageAdapterDeps, headers: Headers, signal?: AbortSignal): Promise<LocalModel[] | null> {
  if (instance.preset === 'localai') return localAiModels(instance, deps, headers, signal);
  return Promise.resolve(null);
}
