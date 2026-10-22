/**
 * The effort levels a model offers and the level a session runs at. The composer and the server use the same rules,
 * so the effort control always shows what the next request sends.
 */
import { Effort, type ModelInfo } from './models.ts';
import type { Mode } from './settings.ts';

const ORDER = Effort.options;
/** The levels themselves; Ultracode is a way of working at one of them. */
const LEVELS = ORDER.filter((e) => e !== 'ultracode');
/** The level Ultracode asks providers for (each adapter clamps it to the model's levels); its sub-agents use it too. */
export const ULTRACODE_LEVEL = 'xhigh' satisfies Effort;

/** Sub-agents one Ultracode request may start, across its whole tree; the Agent tool refuses more. */
export const ULTRACODE_MAX_SUBAGENTS = 24;

/** What limits the levels besides the model and the mode. */
export interface EffortOptions {
  /** The admin allows Ultracode (system setting `ultracode.enabled`, on unless switched off). */
  ultracode?: boolean;
  /** Independent reasoning switch; Extra and above always reason. */
  thinking?: boolean;
}

/**
 * The levels the model's own setting tells apart, lowest first; empty when it has none (no reasoning, or only an
 * on/off switch). Thinking budgets exist for every level; leveled APIs that list none take Low to High.
 */
export function nativeEfforts(model: ModelInfo | undefined): Effort[] {
  if (model?.effortStops?.length) return model.effortStops.map((stop) => stop.effort);
  const reasoning = model?.capabilities.reasoning;
  if (reasoning !== 'effort' && reasoning !== 'budget') return [];
  const listed = LEVELS.filter((e) => model!.effortLevels?.includes(e));
  if (listed.length > 0) return listed;
  return reasoning === 'budget' ? LEVELS : ['low', 'medium', 'high'];
}

/**
 * The levels the effort control offers, lowest first: every model has all of them, Low to Max. What the model's own
 * setting can't express (a thinking switch, no thinking at all, a level above its top one) is asked of it in a
 * context note instead (`effortGuidance`).
 */
export function modelEfforts(model: ModelInfo | undefined): Effort[] {
  if (model?.effortStops?.length) return model.effortStops.map((stop) => stop.effort);
  return model ? [...LEVELS] : [];
}

/**
 * Ultracode: every model in Code sessions, while the admin allows it, except one whose provider fixes the stops (which may
 * draw its last stop like Ultracode, `effortStops[].featured`, but gets none of its behavior). A model whose own setting has no Extra runs at
 * the nearest level it has (or its thinking switch) and is asked for Extra's rigor in a context note (`effortGuidance`).
 */
export function offersUltracode(model: ModelInfo | undefined, mode: Mode, options: EffortOptions = {}): boolean {
  return options.ultracode !== false && mode === 'code' && !!model && !model.effortStops?.length;
}

/** The stops of the effort control, lowest first. */
export function effortChoices(model: ModelInfo | undefined, mode: Mode, options: EffortOptions = {}): Effort[] {
  const levels = modelEfforts(model);
  return offersUltracode(model, mode, options) ? [...levels, 'ultracode'] : levels;
}

/** The level marked "Recommended": the model's own for the mode, else Medium, moved onto a level it has. */
export function recommendedEffort(model: ModelInfo | undefined, mode: Mode): Effort | null {
  const native = nativeEfforts(model);
  return clamp(model?.recommendedEffort?.[mode] ?? 'medium', native.length > 0 ? native : modelEfforts(model));
}

/**
 * The stop of the effort control a session is at: its own level, else the Recommended one. Ultracode where it isn't
 * offered is Extra in Code and Max elsewhere (as other modes store it, `sessionEffort`).
 */
export function shownEffort(
  effort: Effort | null,
  model: ModelInfo | undefined,
  mode: Mode,
  options: EffortOptions = {},
): Effort | null {
  if (!model) return null;
  if (!effort) return recommendedEffort(model, mode);
  const choices = effortChoices(model, mode, options);
  const wanted =
    effort === 'ultracode' && !choices.includes('ultracode') ? (mode === 'code' ? ULTRACODE_LEVEL : 'max') : effort;
  return clamp(wanted, choices);
}

/**
 * The level the request itself carries: the stop the session is at, moved to the next lower level the model's own
 * setting has. A thinking switch is independent of effort, defaults on, and is forced on at Extra and above.
 * Ultracode stays Ultracode on a leveled model (each adapter clamps `ULTRACODE_LEVEL`); whether a run works as
 * Ultracode is `shownEffort`, so a switch or a model without levels still gets it.
 */
export function effectiveEffort(
  effort: Effort | null,
  model: ModelInfo | undefined,
  mode: Mode,
  options: EffortOptions = {},
): Effort | null {
  const shown = shownEffort(effort, model, mode, options);
  if (!shown || !model) return null;
  if (model.capabilities.reasoning === 'toggle') return options.thinking !== false || ORDER.indexOf(shown) >= ORDER.indexOf('xhigh') ? 'high' : null;
  const native = nativeEfforts(model);
  if (native.length === 0) return null;
  return clamp(shown, offersUltracode(model, mode, options) ? [...native, 'ultracode'] : native);
}

/** What a context note asks of a model for a level its own setting doesn't have. */
export type EffortGuidance = 'brief' | 'careful' | 'thorough' | 'exhaustive';

const GUIDANCE: Partial<Record<Effort, EffortGuidance>> = { low: 'brief', high: 'careful', xhigh: 'thorough', max: 'exhaustive' };

/**
 * The guidance for the level a session is at, or null when the model's own setting does it (or the level is the
 * model's usual). A thinking switch or a model that doesn't think has Low to Max all by guidance; a leveled model only
 * for a level beyond its range: Max on one that stops at High asks for the rigor on top of its High. Ultracode asks
 * for what its level (`ULTRACODE_LEVEL`) would.
 */
export function effortGuidance(
  effort: Effort | null,
  model: ModelInfo | undefined,
  mode: Mode,
  options: EffortOptions = {},
): EffortGuidance | null {
  const level = shownEffort(effort, model, mode, options);
  const shown = level === 'ultracode' ? ULTRACODE_LEVEL : level;
  if (!shown) return null;
  if (shown === 'low') return 'brief';
  const native = nativeEfforts(model);
  if (native.length === 0) return GUIDANCE[shown] ?? null;
  if (native.includes(shown)) return null;
  const rank = ORDER.indexOf(shown);
  const beyond = rank > ORDER.indexOf(native.at(-1)!);
  return beyond ? (GUIDANCE[shown] ?? null) : null;
}

/** What a session may store: Ultracode exists only in Code, elsewhere it becomes Max. */
export function sessionEffort(effort: Effort | null, mode: Mode): Effort | null {
  return effort === 'ultracode' && mode !== 'code' ? 'max' : effort;
}

function clamp(effort: Effort, choices: Effort[]): Effort | null {
  const rank = ORDER.indexOf(effort);
  return choices.findLast((c) => ORDER.indexOf(c) <= rank) ?? choices[0] ?? null;
}
