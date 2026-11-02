/** ComfyUI's failures in plain words: a person reads these, and so does the text model that has to explain them. */
import type { MessageError } from '@atelier/protocol';
import { redact, type ProviderIdentity } from '../../../providers/http.ts';
import { arr, rec, str } from '../../../providers/util.ts';

/** Inputs that name a file on the server, so a bad value means the file isn't there. */
const FILE_INPUT = /^(ckpt|unet|vae|clip|lora|model|control_net|upscale_model|style_model)(_name)?\d*$/;
const OUT_OF_MEMORY = /out of memory|outofmemory|\boom\b|failed to allocate|allocation on device|not enough memory/i;
const MISSING_FILE = /FileNotFoundError|no such file/i;
const MAX_DETAIL = 300;

const failure = (instance: ProviderIdentity, message: string): MessageError => ({ code: 'provider_error', message: redact(message, instance), retryable: false });

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL)}…` : line;
}

function nodeError(classType: string, error: Record<string, unknown>): string {
  const extra = rec(error.extra_info);
  const input = str(extra.input_name) ?? '';
  const received = extra.received_value === undefined ? undefined : String(extra.received_value);
  if (error.type === 'value_not_in_list' && FILE_INPUT.test(input)) return `Missing model ${received}`;
  if (error.type === 'value_not_in_list') return `${classType}: "${received}" isn't a valid ${input}`;
  if (error.type === 'required_input_missing') return `${classType} is missing its ${input} input`;
  const details = firstLine(str(error.details) ?? '');
  return `${classType}: ${str(error.message) ?? 'not valid'}${details ? ` (${details})` : ''}`;
}

/** What `POST /prompt` refused, one line for each thing wrong; nothing was queued. */
export function promptError(instance: ProviderIdentity, body: unknown): MessageError {
  const { error, node_errors: nodeErrors } = rec(body);
  const lines = new Set<string>();
  for (const value of Object.values(rec(nodeErrors))) {
    const node = rec(value);
    for (const entry of arr(node.errors)) lines.add(nodeError(str(node.class_type) ?? 'A node', rec(entry)));
  }
  if (lines.size > 0) return failure(instance, [...lines].join('. '));
  const top = rec(error);
  if (top.type === 'missing_node_type') return failure(instance, `${instance.name} has no ${str(rec(top.extra_info).class_type) ?? 'node of the kind this needs'}. Install it on the server, or update ComfyUI.`);
  const detail = firstLine(str(top.details) ?? '') || firstLine(str(top.message) ?? str(error) ?? '');
  return failure(instance, `${instance.name} refused the job${detail ? `: ${detail}` : '.'}`);
}

/** What stopped a job that was already running. */
export function executionError(instance: ProviderIdentity, data: Record<string, unknown>): MessageError {
  const message = str(data.exception_message) ?? '';
  const kind = str(data.exception_type) ?? '';
  const node = str(data.node_type) ?? 'A node';
  if (OUT_OF_MEMORY.test(`${kind} ${message}`)) return failure(instance, `The GPU on ${instance.name} ran out of memory. Close other models that are using it, or ask for a smaller image or fewer at once.`);
  if (MISSING_FILE.test(`${kind} ${message}`)) return failure(instance, `${node} can't find a file on ${instance.name}: ${firstLine(message)}`);
  return failure(instance, `${node} failed on ${instance.name}: ${firstLine(message) || kind || 'no details'}`);
}

/** Somebody pressed cancel on the server itself: our own stop never reaches this. */
export const interruptedError = (instance: ProviderIdentity): MessageError => failure(instance, `This job was stopped on ${instance.name} itself.`);

/** Its queue answers but nothing leaves it: seen on a real server, and only a restart cures it. */
export const stalledError = (instance: ProviderIdentity): MessageError => failure(instance, `${instance.name} isn't starting jobs: this one was next in line with nothing else running. Restart ComfyUI and try again.`);

export const vanishedError = (instance: ProviderIdentity): MessageError => ({ code: 'provider_error', message: `${instance.name} dropped this job from its queue, or restarted.`, retryable: true });
