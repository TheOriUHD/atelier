/** A default pointing at a removed or disabled provider, or a gone or hidden model, is passed over instead of failing. */
import type { ModelResolver, ResolvedModel } from '../agent/chat-service.ts';

/** Refs of the models the resolver lists as visible (with `userId`'s own), or null when it can't list them. */
async function visibleRefs(models: ModelResolver, userId?: string | null): Promise<ReadonlySet<string> | null> {
  if (!models.listModels) return null;
  return new Set((await models.listModels(userId)).filter((m) => !m.hidden).map((m) => m.ref));
}

/** `ref` resolved for `userId` when it can serve a request now: listed (when the resolver lists models), not hidden, provider on. */
export async function usableModel(models: ModelResolver, ref: string, visible?: ReadonlySet<string> | null, userId?: string | null): Promise<ResolvedModel | null> {
  const listed = visible === undefined ? await visibleRefs(models, userId) : visible;
  if (listed && !listed.has(ref)) return null;
  try {
    const model = await models.resolve(ref, userId);
    return model.info.hidden ? null : model;
  } catch {
    return null;
  }
}

/** The first of `refs` that can serve a request for `userId` now, else null; empty and repeated refs are skipped. */
export async function firstUsableModel(models: ModelResolver, refs: readonly (string | null | undefined)[], userId?: string | null): Promise<ResolvedModel | null> {
  const visible = await visibleRefs(models, userId);
  for (const ref of new Set(refs.filter((r): r is string => !!r))) {
    const model = await usableModel(models, ref, visible, userId);
    if (model) return model;
  }
  return null;
}
