import { useMemo } from 'react';
import { defaultModelFor, effortGuidance, nativeEfforts, ULTRACODE_LEVEL, type Effort, type EffortGuidance, type Mode, type ModelInfo } from '@atelier/protocol';
import { useModels, usePrefs, useSettings } from '../../lib/queries.ts';

export const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra',
  max: 'Max',
  ultracode: 'Ultracode',
};

/** What each level means for the person (the effort control's help). */
export const EFFORT_HELP: Record<Effort, string> = {
  low: 'Fastest replies, fewest tool calls. Quick questions and small, well-defined edits.',
  medium: 'Balanced depth and speed for everyday work with a clear scope.',
  high: 'More thinking and checking. Bug fixes and changes where edge cases matter.',
  xhigh: 'Deep reasoning for long, multi-step work. Slower and uses more tokens.',
  max: 'Everything the model has, for the hardest problems. Can be slow and costly.',
  ultracode: 'Plans each task, investigates in parallel with sub-agents and has others check the results, within a per-request budget. Much slower, far more tokens.',
};

/** What a level asks of a model whose own setting can't express it (the context note, in the person's terms). */
const GUIDED: Record<EffortGuidance, string> = {
  brief: 'answer directly and keep it short',
  careful: 'think the problem through and check its result before answering',
  thorough: 'work step by step, try more than one approach and check each claim',
  exhaustive: 'apply the most rigor it can and verify everything it can, then re-check its answer',
};

/**
 * The help for a level of this model. A level the model's own setting has says how much it thinks; one it doesn't
 * (a thinking switch, no thinking at all, a level above its range) says what the model is asked instead. Ultracode
 * adds what its level (`ULTRACODE_LEVEL`) does on this model when the model's own setting can't run it.
 */
export function effortHelp(level: Effort, model: ModelInfo | undefined, mode: Mode = 'chat'): string {
  if (level === 'ultracode') {
    const under = effortHelp(ULTRACODE_LEVEL, model, mode);
    return under === EFFORT_HELP[ULTRACODE_LEVEL] ? EFFORT_HELP.ultracode : `${EFFORT_HELP.ultracode} ${under}`;
  }
  const guidance = effortGuidance(level, model, mode);
  const asked = guidance ? `The model is asked to ${GUIDED[guidance]}.` : null;
  switch (model?.capabilities.reasoning) {
    case 'toggle': {
      const thinking = ['xhigh', 'max'].includes(level) ? 'Thinking is always on at this level.' : 'Thinking is controlled separately and is recommended.';
      return `${thinking} ${asked ?? 'The model answers as it usually does.'}`;
    }
    case 'none':
      return asked ?? 'The model answers as it usually does.';
    default: {
      if (!guidance) return EFFORT_HELP[level];
      const native = nativeEfforts(model);
      const top = native.at(-1);
      return level === 'low' || !top
        ? `${EFFORT_LABELS[native[0] ?? 'low']} is the lowest setting the model has, so it is also asked to ${GUIDED[guidance]}.`
        : `${EFFORT_LABELS[top]} is the highest setting the model has: it runs there and is asked to ${GUIDED[guidance]}.`;
    }
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** One-line capability summary for pickers: "200K context · vision · reasoning". */
export function modelSubtitle(m: ModelInfo): string {
  const caps = [`${formatTokens(m.contextLength)} context`];
  if (m.capabilities.vision) caps.push('vision');
  if (m.capabilities.reasoning !== 'none') caps.push('reasoning');
  if (m.capabilities.tools === 'prompted') caps.push('prompted tools');
  else if (m.capabilities.tools === 'none') caps.push('no tools');
  if (m.free) caps.push('free');
  return caps.join(' · ');
}

/** Visible models grouped by provider, favorites first, then by configured order and name. */
export function useModelGroups(): { providerId: string; label: string; models: ModelInfo[] }[] {
  const { data: models } = useModels();
  const { settings } = useSettings();
  return useMemo(() => {
    const names = new Map(settings?.providers.map((p) => [p.id, p.name]) ?? []);
    const groups = new Map<string, ModelInfo[]>();
    for (const m of models ?? []) if (!m.hidden) groups.set(m.providerId, [...(groups.get(m.providerId) ?? []), m]);
    return [...groups].map(([providerId, list]) => ({
      providerId,
      label: names.get(providerId) ?? providerId,
      models: list.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.order - b.order || a.displayName.localeCompare(b.displayName)),
    }));
  }, [models, settings?.providers]);
}

/**
 * The model a new session in `mode` starts with: the person's preferred model while it is enabled, else
 * the system default, else the first visible model.
 */
export function useDefaultModel(mode: Mode): ModelInfo | undefined {
  const { data: models } = useModels();
  const { settings } = useSettings();
  const { prefs } = usePrefs();
  const preferred = prefs?.models[mode];
  const systemDefault = settings ? defaultModelFor(settings, mode) : undefined;
  return (
    models?.find((m) => m.ref === preferred && !m.hidden) ?? models?.find((m) => m.ref === systemDefault) ?? models?.find((m) => !m.hidden)
  );
}
