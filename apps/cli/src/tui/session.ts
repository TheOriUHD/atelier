/**
 * What the terminal needs about the person's models and their own settings: the model a new session gets (the
 * terminal's choice, the account's default for Code, the server's default), effort words, and the mode names.
 */
import { defaultModelFor, type AppContract, type Effort, type ModelInfo, type PermissionMode, type RpcClient, type Settings } from '@atelier/protocol';

export const EFFORT_WORDS: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max', ultracode: 'Ultracode' };

export const MODE_WORDS: Record<PermissionMode, string> = { auto: 'Auto', default: 'Ask', acceptEdits: 'Accept edits', plan: 'Plan', planAuto: 'Plan · Auto', bypassPermissions: 'Bypass' };
export const MODE_CYCLE: PermissionMode[] = ['auto', 'default', 'acceptEdits', 'plan'];

/** Words for a mode typed after /mode. */
export function modeFrom(word: string): PermissionMode | null {
  const w = word.toLowerCase().replace(/[\s_-]/g, '');
  const map: Record<string, PermissionMode> = { auto: 'auto', ask: 'default', default: 'default', accept: 'acceptEdits', acceptedits: 'acceptEdits', edits: 'acceptEdits', plan: 'plan', planauto: 'planAuto', autoplan: 'planAuto', bypass: 'bypassPermissions', bypasspermissions: 'bypassPermissions', yolo: 'bypassPermissions' };
  return map[w] ?? null;
}

export async function defaultCodeModel(rpc: RpcClient<AppContract>, models: ModelInfo[], wanted?: string): Promise<ModelInfo | undefined> {
  const visible = models.filter((m) => !m.hidden);
  if (wanted) {
    const exact = visible.find((m) => m.ref === wanted) ?? models.find((m) => m.ref === wanted);
    if (exact) return exact;
  }
  const [prefs, settings] = await Promise.all([rpc.call('prefs.get', {}).catch(() => null), rpc.call('settings.get', {}).catch(() => null)]);
  const preferred = prefs?.models?.code;
  const system = settings ? defaultModelFor(settings.effective as Pick<Settings, 'models'>, 'code') : undefined;
  return visible.find((m) => m.ref === preferred && m.available !== false) ?? visible.find((m) => m.ref === system) ?? visible.find((m) => !m.personal) ?? visible[0];
}

/** A model the person typed: its ref, its id or a part of its name. */
export function findModel(models: ModelInfo[], typed: string): ModelInfo | undefined {
  const t = typed.toLowerCase().trim();
  return models.find((m) => m.ref.toLowerCase() === t) ?? models.find((m) => m.modelId.toLowerCase() === t) ?? models.find((m) => m.displayName.toLowerCase() === t) ?? models.find((m) => !m.hidden && `${m.displayName} ${m.modelId}`.toLowerCase().includes(t));
}
