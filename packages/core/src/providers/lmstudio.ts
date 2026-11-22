/**
 * LM Studio's own model list (`GET /api/v1/models`, beside its OpenAI-compatible `/v1`): the one place that says what
 * kind each model is (`llm`, `embedding`, `decision`) and whether it is loaded. `/v1/models` lists decision models
 * among the chat models with nothing to tell them apart.
 */

export interface LmStudioModel {
  /** The id requests name it by. */
  key: string;
  type: string;
  /** Its loaded instances' ids (a model can be loaded more than once, under other ids). */
  loaded: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The models in LM Studio's answer; null when the answer isn't LM Studio's list (another server, or an older LM Studio). */
export function lmStudioModels(json: unknown): LmStudioModel[] | null {
  if (!isRecord(json) || !Array.isArray(json.models)) return null;
  const rows = json.models.filter(isRecord);
  // LM Studio says every model's type; a list without types is someone else's.
  if (rows.length && !rows.every((m) => typeof m.type === 'string')) return null;
  return rows.flatMap((m) => {
    const key = typeof m.key === 'string' ? m.key : typeof m.id === 'string' ? m.id : null;
    if (!key) return [];
    const loaded = (Array.isArray(m.loaded_instances) ? m.loaded_instances : []).flatMap((i) => (isRecord(i) && typeof i.id === 'string' ? [i.id] : []));
    return [{ key, type: String(m.type), loaded }];
  });
}

/** Every id that names one of these models: their keys and their loaded instances. */
export const lmStudioIds = (models: readonly LmStudioModel[]): Set<string> => new Set(models.flatMap((m) => [m.key, ...m.loaded]));
