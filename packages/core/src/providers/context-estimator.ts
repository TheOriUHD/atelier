/** Conservative full-residency estimate, not a measurement or a guarantee that a server can load the model. */
import { num, rec, str } from './util.ts';

const GiB = 1024 ** 3;
export interface ContextMetadata {
  trainedContext: number;
  layers: number;
  kvHeads: number;
  keyLength: number;
  valueLength: number;
}
const positive = (value: unknown): number | undefined => {
  const n = num(value);
  return n !== undefined && Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
};

/** Only the language architecture's fields: never accidentally use a vision/audio tower's dimensions. */
export function contextMetadata(value: unknown): ContextMetadata | undefined {
  const info = rec(value);
  const architecture = str(info['general.architecture']);
  if (!architecture) return undefined;
  const field = (name: string) => positive(info[`${architecture}.${name}`]);
  const trainedContext = field('context_length');
  const blocks = field('block_count');
  let layers = blocks;
  // Qwen's hybrid blocks keep fixed recurrent state; only full-attention blocks grow KV with context.
  if (blocks && (architecture === 'qwen35' || architecture === 'qwen35moe')) {
    const recurrent = info[`${architecture}.attention.recurrent_layers`];
    const interval = field('full_attention_interval');
    if (Array.isArray(recurrent)) {
      if (recurrent.length !== blocks || !recurrent.every((value) => typeof value === 'boolean')) return undefined;
      layers = recurrent.filter((value) => !value).length;
    } else if (interval) {
      layers = Math.floor(blocks / interval);
    } else return undefined;
  }
  const kvHeads = field('attention.head_count_kv');
  const heads = field('attention.head_count');
  const embedding = field('embedding_length');
  const headLength = heads && embedding && embedding % heads === 0 ? embedding / heads : undefined;
  const keyLength = field('attention.key_length') ?? headLength;
  const valueLength = field('attention.value_length') ?? headLength;
  if (!trainedContext || !layers || !kvHeads || !keyLength || !valueLength) return undefined;
  if (heads && kvHeads > heads) return undefined;
  return { trainedContext, layers, kvHeads, keyLength, valueLength };
}

export function estimateContext(options: {
  vramGiB?: number;
  modelBytes?: number;
  metadata?: ContextMetadata;
  parallelRequests?: number;
  modelsAtOnce?: number;
}): number | undefined {
  const { vramGiB, modelBytes, metadata } = options;
  if (!vramGiB || !Number.isFinite(vramGiB) || vramGiB <= 0 || !modelBytes || !Number.isFinite(modelBytes) || modelBytes <= 0 || !metadata) return undefined;
  const parallel = options.parallelRequests ?? 1;
  const models = options.modelsAtOnce ?? 1;
  if (!Number.isInteger(parallel) || parallel < 1 || !Number.isInteger(models) || models < 1) return undefined;
  // Keep a tight runtime reserve (5%, at least 512 MiB) and 2% weight overhead; FP16 KV avoids assuming cache quantization.
  const memory = vramGiB * GiB;
  const available = Math.max(0, (memory - Math.max(GiB / 2, memory * 0.05)) / models - modelBytes * 1.02);
  const perToken = metadata.layers * metadata.kvHeads * (metadata.keyLength + metadata.valueLength) * 2 * parallel;
  const tokens = Math.floor(available / perToken);
  // An unusably small window is not an allocation recommendation; retain the server fallback for CPU offload.
  if (tokens < Math.min(2048, metadata.trainedContext)) return undefined;
  return Math.min(metadata.trainedContext, Math.floor(tokens / 256) * 256);
}
