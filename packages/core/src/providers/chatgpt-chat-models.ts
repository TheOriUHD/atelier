/**
 * The models ChatGPT's own picker offers, as Atelier's models. The page lists a few models (today "6" and "GPT-5.6 Sol"),
 * each with a Power slider of stops: Instant, Medium, High and, on the higher plans, Extra High and Pro. Those stops
 * are the detents of Atelier's effort control for these models (`ModelInfo.effortStops`), and choosing one picks the
 * stop on the page. What the account may use is whatever the picker shows, so a plan without Pro has no Pro stop.
 */
import type { Effort } from '@atelier/protocol';

/** The levels a stop can stand for: Ultracode is a way of working at a level, not a level. */
type Level = Exclude<Effort, 'ultracode'>;
import { listedModel } from './catalog.ts';
import type { ListedModel, ProviderInstance } from './types.ts';

/** What the driver reads from the page: a model's name in the list, and the stops of its slider in order. */
export interface PickerModel {
  name: string;
  short?: string;
  stops: { label: string; locked: boolean }[];
}

/** The window ChatGPT gives its smallest tier here (Instant 137k; the thinking settings 262k, Pro 410k), less a margin. */
const CONTEXT = 128_000;

const EFFORT_OF: Record<string, Level> = { instant: 'low', medium: 'medium', high: 'high', 'extra high': 'xhigh', pro: 'max' };
const BY_PLACE: Level[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const HELP: Record<string, string> = {
  low: 'Answers right away, with no extended thinking.',
  medium: 'Thinks briefly before it answers.',
  high: 'Thinks longer, which helps on harder problems.',
  xhigh: 'Thinks much longer. Slower, and it uses more of your plan.',
  max: 'ChatGPT’s most capable setting, which is slow and has its own, much smaller allowance.',
};

export const modelIdOf = (name: string): string => {
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-');
  return /^\d/.test(slug) ? `gpt-${slug}` : slug;
};

const displayNameOf = (name: string): string => (/^\d/.test(name.trim()) ? `GPT-${name.trim()}` : name.trim());

/** The effort each stop stands for: by its name, or by its place when a name is new or two would share a level. */
function efforts(stops: readonly { label: string }[]): Level[] {
  const named = stops.map((stop) => EFFORT_OF[stop.label.trim().toLowerCase()]);
  const complete = named.every((effort): effort is Level => !!effort) && new Set(named).size === named.length;
  return complete ? (named as Level[]) : stops.map((_, i) => BY_PLACE[Math.min(i, BY_PLACE.length - 1)]!);
}

export function parsePickerModels(json: string): PickerModel[] {
  try {
    const parsed = JSON.parse(json) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return [];
    return parsed.models.filter((model): model is PickerModel => !!model && typeof model === 'object' && typeof (model as PickerModel).name === 'string' && Array.isArray((model as PickerModel).stops));
  } catch {
    return [];
  }
}

export function pickerModelsToListed(instance: ProviderInstance, models: readonly PickerModel[]): ListedModel[] {
  return models.flatMap((model) => {
    const levels = efforts(model.stops);
    // Pro, the top of the slider, is drawn like Ultracode in the effort control (and gone with it on a plan that locks it).
    const stops = model.stops.flatMap((stop, i) => (stop.locked ? [] : [{ effort: levels[i]!, label: stop.label, help: HELP[levels[i]!]!, ...(levels[i] === 'max' ? { warning: 'Pro has its own, much smaller allowance than the other settings.', ...(i === model.stops.length - 1 ? { featured: true } : {}) } : {}) }]));
    if (stops.length === 0) return [];
    const info: Omit<ListedModel, 'ref' | 'providerId' | 'modelId' | 'tier'> = {
      displayName: displayNameOf(model.name),
      contextLength: CONTEXT,
      maxOutput: 32_768,
      capabilities: { tools: 'prompted', vision: true, pdf: true, reasoning: 'effort', caching: false },
      source: 'detected',
      effortStops: stops,
      recommendedEffort: { chat: 'medium', work: 'high', code: 'high' },
    };
    return [listedModel(instance, modelIdOf(model.name), { ...info, tier: 'full' })];
  });
}

/** The model the page is not told about (a person who picked none, a conversation from before the list): the page's own. */
export function fallbackModel(instance: ProviderInstance): ListedModel {
  return listedModel(instance, 'current', { displayName: 'ChatGPT Chat', contextLength: CONTEXT, maxOutput: 32_768, capabilities: { tools: 'prompted', vision: true, pdf: true, reasoning: 'none', caching: false }, tier: 'full', source: 'default' });
}

/** What to set in the picker for a request: the model's name, and the stop with its place in the slider. */
export function selectionFor(models: readonly PickerModel[], modelId: string, effort: string | null | undefined): { model: string; stop?: { index: number; label: string } } | null {
  const model = models.find((candidate) => modelIdOf(candidate.name) === modelId);
  if (!model) return null;
  if (!effort) return { model: model.name };
  const levels = efforts(model.stops);
  // The stop for the level asked for, or the nearest one below it the account has.
  const rank = (level: string) => BY_PLACE.indexOf(level as Level);
  const candidates = model.stops.map((stop, i) => ({ stop, index: i + 1, level: levels[i]! })).filter((c) => !c.stop.locked);
  const exact = candidates.find((c) => c.level === effort);
  const lower = candidates.filter((c) => rank(c.level) <= rank(effort)).at(-1);
  const pick = exact ?? lower ?? candidates[0];
  return pick ? { model: model.name, stop: { index: pick.index, label: pick.stop.label } } : { model: model.name };
}

