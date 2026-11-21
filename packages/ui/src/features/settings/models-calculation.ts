/**
 * Settings › Admin › Models: what the memory budget's context calculation says about each model, in words, and the
 * summary Calculate all shows. A server older than the calculation state sends none; callers fall back to the old label.
 */
import type { ModelInfo } from '@atelier/protocol';
import { formatTokens } from '../chat/models.ts';

type Calculation = NonNullable<ModelInfo['calculation']>;

/** The short caption under a model's context length. */
export function calculationLabel(model: ModelInfo): string {
  const calculation = model.calculation;
  switch (calculation?.state) {
    case 'calculated':
      return 'Calculated';
    case 'too-large':
      return 'Doesn’t fit the budget';
    case 'unsupported':
      return model.contextUnsized?.architecture ? `${model.contextUnsized.architecture} not supported` : 'Metadata unreadable';
    case 'unknown-size':
      return 'Size unknown';
    case 'not-applicable':
      return 'Not applicable';
    default:
      return 'Not calculated';
  }
}

/** The caption's tooltip: why the model is in that state. */
export function calculationDetail(model: ModelInfo, effective: string): string {
  const calculation = model.calculation;
  if (calculation?.state === 'calculated') return `Effective request context: ${effective}. Model overrides take priority over the calculated budget.`;
  return calculation?.detail ?? 'Not calculated. This server doesn’t say why; update it to see the reason.';
}

/** A sentence for one model after Calculate context. */
export function describeCalculation(model: ModelInfo | undefined, name: string): string {
  if (!model) return `${name} is no longer listed by its server.`;
  const calculation = model.calculation;
  if (!calculation) return `Read ${name} again from its server.`;
  if (calculation.state === 'calculated') return `${name}: ${formatTokens(model.calculatedContextLength ?? model.contextLength)} tokens of context fit the memory budget.`;
  return `${name}: ${calculation.detail ?? calculationLabel(model)}`;
}

export interface CalculationSummary {
  tone: 'success' | 'warning' | 'info';
  title: string;
  description: string;
}

/** What Calculate all tells: how many models have a calculated context, and why each of the others has none. */
export function summarizeCalculation(models: ModelInfo[], budgets: boolean, offline: string[]): CalculationSummary {
  const offlineNote = offline.length ? ` ${offline.join(', ')} couldn’t be reached; ${offline.length === 1 ? 'its' : 'their'} models keep the last calculation.` : '';
  if (!budgets) {
    return {
      tone: 'info',
      title: 'No memory budget is set',
      description: `Set a memory budget for a provider (Settings › Admin › Providers) and Atelier calculates the context of its models.${offlineNote}`,
    };
  }
  const sized = models.filter((m) => m.calculation && m.calculation.state !== 'not-applicable');
  if (sized.length === 0) {
    const text = models.some((m) => m.calculation?.state === 'not-applicable')
      ? 'Only Ollama models are sized from a memory budget; the other providers set their own context.'
      : 'This server doesn’t say which models it calculated. Update it, or read the Context column.';
    return { tone: 'info', title: 'Nothing to calculate', description: `${text}${offlineNote}` };
  }
  const states = new Map<Calculation['state'], ModelInfo[]>();
  for (const m of sized) states.set(m.calculation!.state, [...(states.get(m.calculation!.state) ?? []), m]);
  const count = (state: Calculation['state']) => states.get(state)?.length ?? 0;
  const calculated = count('calculated');
  const why: string[] = [];
  if (count('too-large')) why.push(`${count('too-large')} ${count('too-large') === 1 ? 'doesn’t' : 'don’t'} fit the memory budget`);
  const unsupported = [...new Set((states.get('unsupported') ?? []).map((m) => m.contextUnsized?.architecture).filter(Boolean))];
  if (count('unsupported')) why.push(`${count('unsupported')} can’t be read${unsupported.length ? ` (${unsupported.join(', ')})` : ''}`);
  if (count('unknown-size')) why.push(`${count('unknown-size')} ${count('unknown-size') === 1 ? 'has' : 'have'} no size from the server`);
  if (count('pending')) why.push(`${count('pending')} not worked out yet`);
  return {
    tone: calculated === sized.length && offline.length === 0 ? 'success' : 'warning',
    title: `Calculated ${calculated} of ${sized.length} models`,
    description: `${why.length ? `${why.join('; ')}. Hover the note under a model’s context for the reason.` : 'Each fits the memory budget.'}${offlineNote}`,
  };
}
