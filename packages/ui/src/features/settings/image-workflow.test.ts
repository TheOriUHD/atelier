import { describe, expect, it } from 'vitest';
import type { ImageWorkflow } from '@atelier/protocol';
import { WORKFLOW_SLOTS, inputValue, mappedSummary, parseInputValue, slotOptions, withSlot, workflowInputs } from './image-workflow.ts';

const graph: ImageWorkflow['graph'] = {
  '10': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '3': { class_type: 'KSampler', inputs: { seed: 5, steps: 20, cfg: 7, sampler_name: 'euler', model: ['4', 0], positive: ['6', 0] } },
  '6': { class_type: 'CLIPTextEncode', _meta: { title: 'Positive' }, inputs: { text: 'a cat', clip: ['4', 1] } },
};
const slot = (key: string) => WORKFLOW_SLOTS.find((s) => s.key === key)!;
const workflow = { graph, map: { prompt: { node: '6', input: 'text' } } };

describe('a workflow’s inputs', () => {
  it('lists what holds a value, by node number, and leaves links out', () => {
    const inputs = workflowInputs(graph);
    expect(inputs.map((i) => `${i.node}.${i.input}`)).toEqual(['3.seed', '3.steps', '3.cfg', '3.sampler_name', '6.text', '10.width', '10.height', '10.batch_size']);
  });

  it('names a node by its title, else by its type, with its number', () => {
    const inputs = workflowInputs(graph);
    expect(inputs.find((i) => i.input === 'text')?.label).toBe('Positive #6 · text');
    expect(inputs.find((i) => i.input === 'seed')?.label).toBe('KSampler #3 · seed');
  });

  it('skips what isn’t a node', () => {
    expect(workflowInputs({ a: 1, b: { class_type: 'X' } })).toEqual([]);
  });
});

describe('a slot’s options', () => {
  it('offers only inputs of its kind', () => {
    expect(slotOptions(workflow, slot('prompt')).map((o) => o.value)).toEqual(['3|sampler_name', '6|text']);
    expect(slotOptions(workflow, slot('seed')).map((o) => o.value)).toEqual(['3|seed', '3|steps', '3|cfg', '10|width', '10|height', '10|batch_size']);
  });

  it('keeps what the parser chose even when it isn’t of that kind', () => {
    const chosen = { ...workflow, map: { ...workflow.map, seed: { node: '6', input: 'text' } } };
    expect(slotOptions(chosen, slot('seed')).at(-1)).toEqual({ value: '6|text', label: 'Positive #6 · text' });
  });
});

describe('the mapping', () => {
  it('round-trips an input through its select value, whatever the input is called', () => {
    expect(parseInputValue(inputValue({ node: '6', input: 'a|b' }))).toEqual({ node: '6', input: 'a|b' });
  });

  it('sets and clears a slot', () => {
    const map = withSlot(workflow.map, 'seed', { node: '3', input: 'seed' });
    expect(map.seed).toEqual({ node: '3', input: 'seed' });
    expect(withSlot(map, 'seed', null)).toEqual(workflow.map);
  });

  it('sums up what a workflow takes', () => {
    expect(mappedSummary(workflow.map)).toBe('Prompt');
    const input = { node: '3', input: 'x' };
    expect(mappedSummary({ ...workflow.map, seed: input, steps: input, width: input, height: input })).toBe('Prompt, Seed, Steps and 2 more');
  });
});
