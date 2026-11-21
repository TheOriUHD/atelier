/** Conservative full-residency estimate, not a measurement or a guarantee that a server can load the model. */
import { num, rec, str } from './util.ts';

const GiB = 1024 ** 3;
/** The KV cache is kept in FP16 (no assumption of a quantized cache). */
const KV_BYTES = 2;
/** Recurrent state (Mamba, short convolution) is kept in F32. */
const STATE_BYTES = 4;
/**
 * A sliding-window cache holds its window plus one micro-batch, rounded up to 256 cells. Read off Ollama 0.33's own log
 * of gemma-4-12b (window 1024): "creating SWA KV cache, size = 2048 cells", so the micro-batch is 1024 there.
 */
const BATCH_SLACK = 1024;
const CELL_PAD = 256;

export interface ContextMetadata {
  trainedContext: number;
  /** Layers whose KV cache grows with the context (full attention). */
  layers: number;
  kvHeads: number;
  keyLength: number;
  valueLength: number;
  /** KV bytes per token over those layers, when they differ from each other (the four fields above describe the first). */
  kvBytesPerToken?: number;
  /** Layers that only attend to their last `size` tokens: their cache stops growing once the window is full. */
  window?: { size: number; kvBytesPerToken: number };
  /** Memory per sequence that does not grow with the context: recurrent (Mamba) and short-convolution state. */
  stateBytes?: number;
}

/** What `/api/show` told about the architecture: usable metadata, or why not. */
export interface ContextInspection {
  metadata?: ContextMetadata;
  /** The server left a field this architecture needs as `null`; asking again with `verbose: true` returns it. */
  needsVerbose?: boolean;
  architecture?: string;
}

const positive = (value: unknown): number | undefined => {
  const n = num(value);
  return n !== undefined && Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
};
const nonNegative = (value: unknown): number | undefined => {
  const n = num(value);
  return n !== undefined && Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : undefined;
};
const integers = (value: unknown, length: number): number[] | undefined => {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  const out = value.map(nonNegative);
  return out.every((n) => n !== undefined) ? (out as number[]) : undefined;
};

/** Only the language architecture's fields: never accidentally use a vision/audio tower's dimensions. */
export function contextMetadata(value: unknown): ContextMetadata | undefined {
  return inspectContext(value).metadata;
}

export function inspectContext(value: unknown): ContextInspection {
  const info = rec(value);
  const architecture = str(info['general.architecture']);
  if (!architecture) return {};
  const field = (name: string) => positive(info[`${architecture}.${name}`]);
  const trainedContext = field('context_length');
  const blocks = field('block_count');
  if (architecture === 'qwen35' || architecture === 'qwen35moe') {
    const metadata = qwenMetadata(info, architecture, trainedContext, blocks);
    return metadata ? { metadata, architecture } : { architecture };
  }
  // Ollama's `/api/show` answers long arrays (per-layer head counts, the sliding-window pattern) with null unless asked verbose.
  const raw = (name: string) => info[`${architecture}.${name}`];
  const needsVerbose = raw('attention.head_count_kv') === null || raw('attention.sliding_window_pattern') === null || (raw('feed_forward_length') === null && raw('ssm.inner_size') !== undefined);
  if (needsVerbose) return { needsVerbose: true, architecture };
  if (!trainedContext || !blocks) return { architecture };

  const kvRaw = raw('attention.head_count_kv');
  let kv: number[];
  if (Array.isArray(kvRaw)) {
    const perLayer = integers(kvRaw, blocks);
    if (!perLayer) return { architecture };
    kv = perLayer;
  } else {
    const heads = positive(kvRaw);
    if (!heads) return { architecture };
    kv = Array.from({ length: blocks }, () => heads);
  }
  const heads = field('attention.head_count');
  const embedding = field('embedding_length');
  if (heads && kv.some((n) => n > heads)) return { architecture };
  const headLength = heads && embedding && embedding % heads === 0 ? embedding / heads : undefined;
  const keyLength = field('attention.key_length') ?? headLength;
  const valueLength = field('attention.value_length') ?? headLength;
  if (!keyLength || !valueLength) return { architecture };
  const keyWindow = field('attention.key_length_swa') ?? keyLength;
  const valueWindow = field('attention.value_length_swa') ?? valueLength;

  // Layers with a sliding window, when the model lists which ones they are.
  const windowSize = field('attention.sliding_window');
  const pattern = raw('attention.sliding_window_pattern');
  let sliding: boolean[] = kv.map(() => false);
  if (windowSize && Array.isArray(pattern)) {
    if (pattern.length !== blocks || !pattern.every((p) => typeof p === 'boolean')) return { architecture };
    sliding = pattern as boolean[];
  }

  let fullLayers = 0;
  let fullBytes = 0;
  let windowBytes = 0;
  let firstKvHeads = 0;
  for (const [i, n] of kv.entries()) {
    if (n === 0) continue;
    if (sliding[i]) {
      windowBytes += n * (keyWindow + valueWindow) * KV_BYTES;
      continue;
    }
    fullLayers += 1;
    fullBytes += n * (keyLength + valueLength) * KV_BYTES;
    if (firstKvHeads === 0) firstKvHeads = n;
  }
  if (firstKvHeads === 0) return { architecture };

  // Recurrent layers (no attention): Mamba state, and a short convolution's last columns.
  let stateBytes = 0;
  const feedForward = Array.isArray(raw('feed_forward_length')) ? integers(raw('feed_forward_length'), blocks) : undefined;
  const stateSize = field('ssm.state_size');
  const inner = field('ssm.inner_size');
  const kernel = field('ssm.conv_kernel');
  const groups = field('ssm.group_count') ?? 1;
  const cache = field('shortconv.l_cache');
  for (const [i, n] of kv.entries()) {
    if (n > 0) continue;
    if (stateSize && inner && kernel) {
      // A Mamba layer is one the model gives neither attention nor a feed-forward block.
      if (!feedForward || feedForward[i] === 0) stateBytes += (stateSize * inner + (kernel - 1) * (inner + 2 * groups * stateSize)) * STATE_BYTES;
    } else if (cache && embedding) stateBytes += (cache - 1) * embedding * STATE_BYTES;
  }

  const uniform = fullBytes === fullLayers * firstKvHeads * (keyLength + valueLength) * KV_BYTES;
  const windowed = windowSize && windowBytes > 0 ? { window: { size: windowSize, kvBytesPerToken: windowBytes } } : {};
  const metadata: ContextMetadata = {
    trainedContext,
    layers: fullLayers,
    kvHeads: firstKvHeads,
    keyLength,
    valueLength,
    ...(uniform ? {} : { kvBytesPerToken: fullBytes }),
    ...windowed,
    ...(stateBytes > 0 ? { stateBytes } : {}),
  };
  return { metadata, architecture };
}

/** Qwen's hybrid blocks keep fixed recurrent state; only full-attention blocks grow KV with context. */
function qwenMetadata(info: Record<string, unknown>, architecture: string, trainedContext: number | undefined, blocks: number | undefined): ContextMetadata | undefined {
  const field = (name: string) => positive(info[`${architecture}.${name}`]);
  let layers = blocks;
  if (blocks) {
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

export interface ContextBudget {
  vramGiB?: number;
  modelBytes?: number;
  metadata?: ContextMetadata;
  parallelRequests?: number;
  modelsAtOnce?: number;
}

/** A size, or why there is none: no budget set, no weight size, no usable metadata, or the model doesn't fit. */
export type ContextEstimate = { tokens: number } | { reason: 'budget' | 'size' | 'metadata' | 'invalid' | 'fit'; availableBytes?: number };

export function estimateContextResult(options: ContextBudget): ContextEstimate {
  const { vramGiB, modelBytes, metadata } = options;
  if (!vramGiB || !Number.isFinite(vramGiB) || vramGiB <= 0) return { reason: 'budget' };
  if (!modelBytes || !Number.isFinite(modelBytes) || modelBytes <= 0) return { reason: 'size' };
  if (!metadata) return { reason: 'metadata' };
  const parallel = options.parallelRequests ?? 1;
  const models = options.modelsAtOnce ?? 1;
  if (!Number.isInteger(parallel) || parallel < 1 || !Number.isInteger(models) || models < 1) return { reason: 'invalid' };
  // Keep a tight runtime reserve (5%, at least 512 MiB) and 2% weight overhead; FP16 KV avoids assuming cache quantization.
  const memory = vramGiB * GiB;
  // What does not grow with the context, for each request in flight: the sliding-window layers' caches and recurrent state.
  const windowCells = metadata.window ? Math.ceil((metadata.window.size + BATCH_SLACK) / CELL_PAD) * CELL_PAD : 0;
  const fixed = ((metadata.window ? metadata.window.kvBytesPerToken * windowCells : 0) + (metadata.stateBytes ?? 0)) * parallel;
  const available = Math.max(0, (memory - Math.max(GiB / 2, memory * 0.05)) / models - modelBytes * 1.02 - fixed);
  const perToken = (metadata.kvBytesPerToken ?? metadata.layers * metadata.kvHeads * (metadata.keyLength + metadata.valueLength) * KV_BYTES) * parallel;
  const tokens = Math.floor(available / perToken);
  // An unusably small window is not an allocation recommendation; retain the server fallback for CPU offload.
  if (tokens < Math.min(2048, metadata.trainedContext)) return { reason: 'fit', availableBytes: available };
  return { tokens: Math.min(metadata.trainedContext, Math.floor(tokens / 256) * 256) };
}

export function estimateContext(options: ContextBudget): number | undefined {
  const result = estimateContextResult(options);
  return 'tokens' in result ? result.tokens : undefined;
}
