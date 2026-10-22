import { describe, expect, it } from 'vitest';
import { modelIdOf, parsePickerModels, pickerModelsToListed, selectionFor, type PickerModel } from './chatgpt-chat-models.ts';
import { providerInstance } from './__fixtures__/harness.ts';

const instance = providerInstance('chatgpt-chat', 'https://chatgpt.com');
const stops = (...labels: string[]) => labels.map((label) => ({ label, locked: false }));
const pro: PickerModel[] = [
  { name: '6', short: '6', stops: stops('Instant', 'Medium', 'High', 'Extra High', 'Pro') },
  { name: 'GPT-5.6 Sol', short: '5.6', stops: stops('Instant', 'Medium', 'High', 'Extra High', 'Pro') },
];

describe('ChatGPT Chat models', () => {
  it('lists the picker’s models with its stops as the effort stops', () => {
    const [six, sol] = pickerModelsToListed(instance, pro);
    expect(six).toMatchObject({ ref: 'chatgpt-chat-1/gpt-6', displayName: 'GPT-6', contextLength: 128_000, capabilities: { reasoning: 'effort', vision: true, pdf: true, tools: 'prompted' }, recommendedEffort: { chat: 'medium', work: 'high', code: 'high' } });
    expect(six!.effortStops!.map((stop) => [stop.effort, stop.label])).toEqual([['low', 'Instant'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra High'], ['max', 'Pro']]);
    expect(six!.effortStops!.at(-1)!.warning).toMatch(/smaller allowance/);
    expect(six!.effortStops![0]!.warning).toBeUndefined();
    // Only Pro, the top of the slider, is drawn like Ultracode.
    expect(six!.effortStops!.map((stop) => stop.featured)).toEqual([undefined, undefined, undefined, undefined, true]);
    expect(sol).toMatchObject({ ref: 'chatgpt-chat-1/gpt-5.6-sol', displayName: 'GPT-5.6 Sol' });
  });

  it('offers only what the plan has: a locked stop is left out, and the stops of a smaller slider keep their names', () => {
    const plus: PickerModel[] = [{ name: '6', stops: [...stops('Instant', 'Medium', 'High'), { label: 'Extra High', locked: true }, { label: 'Pro', locked: true }] }];
    expect(pickerModelsToListed(instance, plus)[0]!.effortStops!.map((stop) => stop.label)).toEqual(['Instant', 'Medium', 'High']);
    expect(pickerModelsToListed(instance, plus)[0]!.effortStops!.some((stop) => stop.featured)).toBe(false);
    const small: PickerModel[] = [{ name: '6', stops: stops('Instant', 'Thinking') }];
    expect(pickerModelsToListed(instance, small)[0]!.effortStops!.map((stop) => [stop.effort, stop.label])).toEqual([['low', 'Instant'], ['medium', 'Thinking']]);
  });

  it('turns an effort into the stop of the slider, with its place, or the nearest one below when there is none', () => {
    expect(selectionFor(pro, 'gpt-6', 'xhigh')).toEqual({ model: '6', stop: { index: 4, label: 'Extra High' } });
    expect(selectionFor(pro, 'gpt-5.6-sol', 'low')).toEqual({ model: 'GPT-5.6 Sol', stop: { index: 1, label: 'Instant' } });
    const plus: PickerModel[] = [{ name: '6', stops: [...stops('Instant', 'Medium', 'High'), { label: 'Extra High', locked: true }] }];
    expect(selectionFor(plus, 'gpt-6', 'xhigh')).toEqual({ model: '6', stop: { index: 3, label: 'High' } });
    expect(selectionFor(pro, 'gpt-6', null)).toEqual({ model: '6' });
    expect(selectionFor(pro, 'current', 'high')).toBeNull();
  });

  it('reads the driver’s list, and an unreadable one as none', () => {
    expect(parsePickerModels(JSON.stringify({ models: pro }))).toHaveLength(2);
    expect(parsePickerModels('{}')).toEqual([]);
    expect(parsePickerModels('not json')).toEqual([]);
    expect(modelIdOf('GPT-5.6 Sol')).toBe('gpt-5.6-sol');
    expect(modelIdOf('6')).toBe('gpt-6');
  });
});
