/** A ComfyUI workflow's mapping: which of its inputs Atelier fills in for each image. The graph is ComfyUI's API format. */
import type { ImageWorkflow, ImageWorkflowInput } from '@atelier/protocol';
import type { SelectOption } from '../../components/ui/index.ts';

export type WorkflowMap = ImageWorkflow['map'];

/** `kind` says which inputs can fill a slot, so a long workflow's list stays short. */
export const WORKFLOW_SLOTS = [
  { key: 'prompt', label: 'Prompt', kind: 'text' },
  { key: 'negative', label: 'Negative prompt', kind: 'text' },
  { key: 'seed', label: 'Seed', kind: 'number' },
  { key: 'steps', label: 'Steps', kind: 'number' },
  { key: 'guidance', label: 'Guidance', kind: 'number' },
  { key: 'sampler', label: 'Sampler', kind: 'text' },
  { key: 'scheduler', label: 'Scheduler', kind: 'text' },
  { key: 'width', label: 'Width', kind: 'number' },
  { key: 'height', label: 'Height', kind: 'number' },
  { key: 'count', label: 'Images per run', kind: 'number' },
  { key: 'image', label: 'Input image', kind: 'text' },
  { key: 'mask', label: 'Mask', kind: 'text' },
] as const;

type Slot = (typeof WORKFLOW_SLOTS)[number];
export type SlotKey = Slot['key'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** "CLIP Text Encode #6": the title someone gave a node, else its type, and its number to tell two of a kind apart. */
function nodeLabel(id: string, node: Record<string, unknown>): string {
  const meta = node._meta;
  const title = isObject(meta) && typeof meta.title === 'string' ? meta.title : undefined;
  return `${title ?? (typeof node.class_type === 'string' ? node.class_type : 'Node')} #${id}`;
}

export interface WorkflowInput extends ImageWorkflowInput {
  label: string;
  kind: 'text' | 'number';
}

/** The inputs that hold a value of their own, by node number. A link to another node (`["4", 0]`) isn't something to fill in. */
export function workflowInputs(graph: ImageWorkflow['graph']): WorkflowInput[] {
  return Object.entries(graph)
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .flatMap(([node, value]) => {
      if (!isObject(value) || !isObject(value.inputs)) return [];
      const where = nodeLabel(node, value);
      return Object.entries(value.inputs).flatMap(([input, held]): WorkflowInput[] => {
        if (typeof held !== 'string' && typeof held !== 'number') return [];
        return [{ node, input, label: `${where} · ${input}`, kind: typeof held === 'string' ? 'text' : 'number' }];
      });
    });
}

export const inputValue = (input: ImageWorkflowInput) => `${input.node}|${input.input}`;

export function parseInputValue(value: string): ImageWorkflowInput {
  const split = value.indexOf('|');
  return { node: value.slice(0, split), input: value.slice(split + 1) };
}

/** What can fill a slot; what the parser chose stays listed even if it isn't of that kind. */
export function slotOptions(workflow: Pick<ImageWorkflow, 'graph' | 'map'>, slot: Slot, inputs = workflowInputs(workflow.graph)): SelectOption[] {
  const options: SelectOption[] = inputs.filter((i) => i.kind === slot.kind).map((i) => ({ value: inputValue(i), label: i.label }));
  const chosen = workflow.map[slot.key];
  if (chosen && !options.some((o) => o.value === inputValue(chosen))) options.push({ value: inputValue(chosen), label: inputs.find((i) => inputValue(i) === inputValue(chosen))?.label ?? `#${chosen.node} · ${chosen.input}` });
  return options;
}

/** The map with one slot set, or gone on null. */
export function withSlot(map: WorkflowMap, key: SlotKey, input: ImageWorkflowInput | null): WorkflowMap {
  if (input) return { ...map, [key]: input };
  const { [key]: _gone, ...rest } = map;
  return rest as WorkflowMap;
}

/** "Prompt, Seed, Steps and 3 more": what a workflow in the list takes. */
export function mappedSummary(map: WorkflowMap): string {
  const names = WORKFLOW_SLOTS.filter((s) => map[s.key]).map((s) => s.label);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
}
