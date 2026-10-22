import { describe, expect, it } from 'vitest';
import {
  effectiveEffort,
  effortChoices,
  effortGuidance,
  modelEfforts,
  nativeEfforts,
  offersUltracode,
  recommendedEffort,
  sessionEffort,
  shownEffort,
} from './effort.ts';
import { Effort, type ModelInfo } from './models.ts';
import { Mode } from './settings.ts';

const model = (
  patch: Partial<ModelInfo> = {},
  reasoning: ModelInfo['capabilities']['reasoning'] = 'effort',
): ModelInfo => ({
  ref: 'p/m',
  providerId: 'p',
  modelId: 'm',
  displayName: 'M',
  contextLength: 200_000,
  maxOutput: 64_000,
  capabilities: { tools: 'native', vision: true, pdf: true, reasoning, caching: true },
  tier: 'full',
  source: 'catalog',
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  hidden: false,
  favorite: false,
  order: 0,
  ...patch,
});

describe('effort levels', () => {
  const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('lists the levels a model’s own setting has, every budget or Low to High when it lists none, and none without one', () => {
    expect(nativeEfforts(model())).toEqual(ALL);
    expect(nativeEfforts(model({ effortLevels: ['max', 'low', 'medium', 'high'] }))).toEqual(['low', 'medium', 'high', 'max']);
    expect(nativeEfforts(model({ effortLevels: undefined }))).toEqual(['low', 'medium', 'high']);
    expect(nativeEfforts(model({ effortLevels: undefined }, 'budget'))).toEqual(ALL);
    expect(nativeEfforts(model({}, 'toggle'))).toEqual([]);
    expect(nativeEfforts(model({}, 'none'))).toEqual([]);
    expect(nativeEfforts(undefined)).toEqual([]);
  });

  it('offers every level, Low to Max, on every model: what its own setting lacks is asked of it', () => {
    for (const shape of [model(), model({ effortLevels: ['high'] }), model({ effortLevels: undefined }, 'budget'), model({}, 'toggle'), model({}, 'none')]) {
      expect(modelEfforts(shape)).toEqual(ALL);
    }
    expect(modelEfforts(undefined)).toEqual([]);
  });

  it('adds Ultracode in Code on every model, and nowhere else', () => {
    expect(effortChoices(model(), 'code')).toEqual([...ALL, 'ultracode']);
    expect(effortChoices(model(), 'chat')).toEqual(ALL);
    expect(effortChoices(model(), 'work')).not.toContain('ultracode');
    expect(offersUltracode(model({ tier: 'compact' }), 'code')).toBe(true);
    expect(offersUltracode(model({ capabilities: { ...model().capabilities, tools: 'prompted' } }), 'code')).toBe(true);
    expect(offersUltracode(model({ effortLevels: ['high'] }), 'code')).toBe(true);
    expect(offersUltracode(model({}, 'toggle'), 'code')).toBe(true);
    expect(offersUltracode(model({}, 'none'), 'code')).toBe(true);
    expect(offersUltracode(model({ effortLevels: undefined }, 'budget'), 'code')).toBe(true);
    expect(offersUltracode(model({}, 'none'), 'chat')).toBe(false);
    expect(offersUltracode(undefined, 'code')).toBe(false);
    // The admin's switch.
    expect(effortChoices(model(), 'code', { ultracode: false })).toEqual(ALL);
    expect(effortChoices(model({}, 'none'), 'code', { ultracode: false })).toEqual(ALL);
    expect(offersUltracode(model(), 'code', { ultracode: true })).toBe(true);
  });

  it('marks the model’s own level for the mode as Recommended, else Medium, on a level it has', () => {
    const fable = model({ recommendedEffort: { chat: 'medium', work: 'medium', code: 'high' } });
    expect(recommendedEffort(fable, 'code')).toBe('high');
    expect(recommendedEffort(fable, 'chat')).toBe('medium');
    expect(recommendedEffort(model(), 'code')).toBe('medium');
    expect(recommendedEffort(model({ effortLevels: ['high', 'max'] }), 'chat')).toBe('high');
    // A model without a setting of its own: Medium, its usual way of answering.
    expect(recommendedEffort(model({}, 'none'), 'chat')).toBe('medium');
    expect(recommendedEffort(model({}, 'toggle'), 'code')).toBe('medium');
    expect(recommendedEffort(undefined, 'chat')).toBeNull();
  });

  it('shows a session at its own level, else the Recommended one, and Ultracode where it isn’t offered as Extra or Max', () => {
    expect(shownEffort(null, model({ recommendedEffort: { chat: 'low', work: 'medium', code: 'high' } }), 'chat')).toBe('low');
    expect(shownEffort('max', model({}, 'toggle'), 'chat')).toBe('max');
    expect(shownEffort('xhigh', model({}, 'none'), 'code')).toBe('xhigh');
    expect(shownEffort('ultracode', model(), 'code')).toBe('ultracode');
    expect(shownEffort('ultracode', model(), 'chat')).toBe('max');
    expect(shownEffort('ultracode', model(), 'code', { ultracode: false })).toBe('xhigh');
    expect(shownEffort('ultracode', model({}, 'toggle'), 'code')).toBe('ultracode');
    expect(shownEffort('ultracode', model({}, 'toggle'), 'code', { ultracode: false })).toBe('xhigh');
    expect(shownEffort('high', undefined, 'chat')).toBeNull();
  });

  it('sends the level the model’s own setting has: the next lower one, on/off for a switch, none without a setting', () => {
    const sonnet46 = model({ effortLevels: ['low', 'medium', 'high', 'max'] });
    expect(effectiveEffort(null, model({ recommendedEffort: { chat: 'low', work: 'medium', code: 'high' } }), 'chat')).toBe('low');
    expect(effectiveEffort('xhigh', sonnet46, 'code')).toBe('high');
    expect(effectiveEffort('ultracode', model(), 'code')).toBe('ultracode');
    expect(effectiveEffort('max', model({ effortLevels: ['low', 'medium', 'high'] }), 'code')).toBe('high');
    // No setting at all: nothing is sent, at any level.
    for (const level of Effort.options) expect(effectiveEffort(level, model({}, 'none'), 'chat')).toBeNull();
    // Thinking defaults on independently of effort, but Extra and above cannot disable it.
    expect(effectiveEffort(null, model({}, 'toggle'), 'chat')).toBe('high');
    expect(effectiveEffort('low', model({}, 'toggle'), 'chat')).toBe('high');
    expect(effectiveEffort('low', model({}, 'toggle'), 'chat', { thinking: false })).toBeNull();
    expect(effectiveEffort('high', model({}, 'toggle'), 'chat', { thinking: false })).toBeNull();
    expect(effectiveEffort('xhigh', model({}, 'toggle'), 'chat', { thinking: false })).toBe('high');
    expect(effectiveEffort('medium', model({}, 'toggle'), 'chat')).toBe('high');
    expect(effectiveEffort('high', model({}, 'toggle'), 'chat')).toBe('high');
    expect(effectiveEffort('max', model({}, 'toggle'), 'chat')).toBe('high');
    expect(effectiveEffort('ultracode', model({}, 'toggle'), 'code')).toBe('high');
    // Ultracode on a leveled model, whatever its levels: the adapter clamps it to the nearest one.
    expect(effectiveEffort('ultracode', model({ effortLevels: ['high'] }), 'code')).toBe('ultracode');
    expect(effectiveEffort('ultracode', model({ tier: 'compact' }), 'code')).toBe('ultracode');
  });

  it('runs a stored Ultracode where it isn’t offered at Extra in Code and at Max elsewhere, clamped like any level', () => {
    expect(effectiveEffort('ultracode', model(), 'chat')).toBe('max');
    expect(effectiveEffort('ultracode', model(), 'work')).toBe('max');
    expect(effectiveEffort('ultracode', model(), 'code', { ultracode: false })).toBe('xhigh');
    expect(effectiveEffort('ultracode', model({ tier: 'compact' }), 'code', { ultracode: false })).toBe('xhigh');
    expect(
      effectiveEffort('ultracode', model({ effortLevels: ['low', 'medium', 'high', 'max'] }), 'code', { ultracode: false }),
    ).toBe('high');
  });

  it('asks for what the model’s own setting lacks: all levels on a switch or a model that doesn’t think, the rest beyond a range', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    // A thinking switch and a model without thinking: every level but Medium is by guidance.
    for (const shape of [model({}, 'toggle'), model({}, 'none')]) {
      expect(levels.map((l) => effortGuidance(l, shape, 'chat'))).toEqual(['brief', null, 'careful', 'thorough', 'exhaustive']);
      expect(effortGuidance(null, shape, 'chat')).toBeNull();
    }
    // A model that stops at High: Extra and Max are High plus the guidance; its own levels need none.
    const upToHigh = model({ effortLevels: ['low', 'medium', 'high'] });
    expect(levels.map((l) => effortGuidance(l, upToHigh, 'chat'))).toEqual(['brief', null, null, 'thorough', 'exhaustive']);
    expect(effectiveEffort('max', upToHigh, 'chat')).toBe('high');
    // A model that starts at High: Low asks for brevity, Medium is its usual.
    const fromHigh = model({ effortLevels: ['high', 'max'] });
    expect(effortGuidance('low', fromHigh, 'chat')).toBe('brief');
    expect(effortGuidance('medium', fromHigh, 'chat')).toBeNull();
    // Full range, and Ultracode on it, which has notes of its own: nothing to add.
    expect(levels.map((l) => effortGuidance(l, model(), 'chat'))).toEqual(['brief', null, null, null, null]);
    expect(effortGuidance('ultracode', model(), 'code')).toBeNull();
    // Ultracode where the model's own setting has no Extra: asked for Extra's rigor.
    expect(effortGuidance('ultracode', upToHigh, 'code')).toBe('thorough');
    expect(effortGuidance('ultracode', model({}, 'toggle'), 'code')).toBe('thorough');
    expect(effortGuidance('ultracode', model({}, 'none'), 'code')).toBe('thorough');
    expect(effortGuidance('ultracode', model({ effortLevels: ['low', 'medium', 'high', 'xhigh'] }), 'code')).toBeNull();
    expect(effortGuidance('max', undefined, 'chat')).toBeNull();
  });

  // Every model shape in every mode, with and without the admin's Ultracode switch: the control offers Low to Max
  // everywhere, a session is shown at one of its stops, and the request carries a level the model's own setting has
  // (or none), and Ultracode is offered in Code while the admin allows it.
  const shapes: [string, ModelInfo][] = [
    ['effort levels', model()],
    ['effort levels, compact tier', model({ tier: 'compact' })],
    ['effort levels, prompted tools', model({ capabilities: { ...model().capabilities, tools: 'prompted' } })],
    ['effort levels, Low to High', model({ effortLevels: ['low', 'medium', 'high'] })],
    ['one level', model({ effortLevels: ['high'] })],
    ['thinking budget', model({ effortLevels: undefined }, 'budget')],
    ['on/off switch', model({ effortLevels: undefined }, 'toggle')],
    ['on/off switch, compact tier', model({ effortLevels: undefined, tier: 'compact' }, 'toggle')],
    ['no reasoning', model({ effortLevels: undefined }, 'none')],
    ['no reasoning, no tools', model({ effortLevels: undefined, capabilities: { ...model().capabilities, tools: 'none', reasoning: 'none' } }, 'none')],
  ];
  describe.each(shapes)('%s', (_, shape) => {
    it.each(Mode.options.flatMap((mode) => [true, false].map((allowed) => [mode, allowed] as const)))(
      'in %s, Ultracode allowed: %s',
      (mode, allowed) => {
        const options = { ultracode: allowed };
        const choices = effortChoices(shape, mode, options);
        expect(choices.slice(0, 5)).toEqual(ALL);
        expect(choices.includes('ultracode')).toBe(mode === 'code' && allowed);
        const native = nativeEfforts(shape);
        for (const stored of [null, ...Effort.options]) {
          const shown = shownEffort(stored, shape, mode, options);
          expect(choices).toContain(shown);
          expect(shown === 'ultracode').toBe(stored === 'ultracode' && choices.includes('ultracode'));
          const sent = effectiveEffort(stored, shape, mode, options);
          if (shape.capabilities.reasoning === 'toggle') expect([null, 'high']).toContain(sent);
          else if (native.length === 0) expect(sent).toBeNull();
          else expect(sent === 'ultracode' ? choices : native).toContain(sent);
        }
      },
    );
  });

  it('stores Ultracode only for Code sessions', () => {
    expect(sessionEffort('ultracode', 'code')).toBe('ultracode');
    expect(sessionEffort('ultracode', 'chat')).toBe('max');
    expect(sessionEffort('ultracode', 'work')).toBe('max');
    expect(sessionEffort('xhigh', 'chat')).toBe('xhigh');
    expect(sessionEffort(null, 'chat')).toBeNull();
  });
});

describe('effort stops fixed by a provider', () => {
  const stops: NonNullable<ModelInfo['effortStops']> = [
    { effort: 'low', label: 'Instant' },
    { effort: 'medium', label: 'Medium' },
    { effort: 'high', label: 'High' },
    { effort: 'max', label: 'Pro', warning: 'Pro counts against a small weekly allowance.', featured: true },
  ];
  const chatgpt = model({ effortStops: stops, effortLevels: undefined, recommendedEffort: { chat: 'medium', work: 'high', code: 'high' } });

  it('offers exactly those stops, and no Ultracode in Code', () => {
    expect(modelEfforts(chatgpt)).toEqual(['low', 'medium', 'high', 'max']);
    expect(nativeEfforts(chatgpt)).toEqual(['low', 'medium', 'high', 'max']);
    expect(offersUltracode(chatgpt, 'code')).toBe(false);
    expect(effortChoices(chatgpt, 'code')).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('draws the last stop like Ultracode without giving it Ultracode’s behavior', () => {
    // The look is the effort control's; the level a session stores and sends stays Max, with no Ultracode guidance.
    expect(shownEffort('max', chatgpt, 'code')).toBe('max');
    expect(effectiveEffort('max', chatgpt, 'code')).toBe('max');
    expect(effortGuidance('max', chatgpt, 'code')).toBeNull();
    expect(offersUltracode(chatgpt, 'code')).toBe(false);
  });

  it('moves a level the stops lack onto the nearest lower one, and asks for no extra guidance', () => {
    expect(shownEffort('xhigh', chatgpt, 'code')).toBe('high');
    expect(shownEffort('ultracode', chatgpt, 'code')).toBe('high');
    expect(effectiveEffort('xhigh', chatgpt, 'chat')).toBe('high');
    expect(effectiveEffort('max', chatgpt, 'chat')).toBe('max');
    expect(effortGuidance('max', chatgpt, 'chat')).toBeNull();
    expect(recommendedEffort(chatgpt, 'code')).toBe('high');
  });
});

