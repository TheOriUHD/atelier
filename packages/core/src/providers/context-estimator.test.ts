import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contextMetadata, estimateContext, estimateContextResult, inspectContext } from './context-estimator.ts';

/** `/api/show` answers of a real Ollama 0.33 (the owner's server), trimmed to the language model's keys: plain, and verbose where that differs. */
const VM = JSON.parse(readFileSync(new URL('./__fixtures__/ollama-vm-model-info.json', import.meta.url), 'utf8')) as Record<string, { modelBytes: number; modelInfo: Record<string, unknown>; verboseModelInfo?: Record<string, unknown> }>;
const VM_BUDGET = 32e9 / 1024 ** 3; // the owner’s 32 GB, in GiB (what a provider stores)

const info = {
  'general.architecture': 'llama',
  'llama.context_length': 131072,
  'llama.block_count': 32,
  'llama.embedding_length': 4096,
  'llama.attention.head_count': 32,
  'llama.attention.head_count_kv': 8,
};
const metadata = contextMetadata(info)!;
const budget = { vramGiB: 16, modelBytes: 8 * 1024 ** 3, metadata };

describe('local context estimate', () => {
  it('uses the language architecture and actual GQA dimensions, including explicit key/value lengths', () => {
    expect(metadata).toEqual({ trainedContext: 131072, layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 });
    expect(contextMetadata({ ...info, 'llama.attention.key_length': 256, 'llama.attention.value_length': 64, 'vision.block_count': 999 })).toMatchObject({ layers: 32, keyLength: 256, valueLength: 64 });
    expect(contextMetadata({ ...info, 'general.architecture': undefined })).toBeUndefined();
    expect(contextMetadata({ ...info, 'llama.attention.head_count_kv': undefined })).toBeUndefined();
    expect(contextMetadata({ ...info, 'llama.block_count': -1 })).toBeUndefined();
  });

  it('counts only full-attention blocks for Qwen hybrid KV growth', () => {
    const hybrid = {
      'general.architecture': 'qwen35', 'qwen35.context_length': 262144, 'qwen35.block_count': 64,
      'qwen35.attention.head_count': 24, 'qwen35.attention.head_count_kv': 4,
      'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256,
      'qwen35.full_attention_interval': 4,
    };
    const metadata = contextMetadata(hybrid)!;
    expect(metadata.layers).toBe(16);
    const options = { vramGiB: 32, modelBytes: 19603117613, metadata };
    expect(estimateContext(options)).toBe(192768);
    expect(estimateContext({ ...options, metadata: { ...metadata, layers: 64 } })).toBe(48128);
    expect(contextMetadata({ ...hybrid, 'qwen35.full_attention_interval': undefined })).toBeUndefined();
    const recurrent = Array.from({ length: 64 }, (_, i) => i % 4 !== 3);
    expect(contextMetadata({ ...hybrid, 'qwen35.attention.recurrent_layers': recurrent })).toMatchObject({ layers: 16 });
    expect(contextMetadata({ ...hybrid, 'qwen35.attention.recurrent_layers': [false] })).toBeUndefined();
  });

  it('reserves runtime and weight headroom and scales KV by parallel requests', () => {
    // 16 GiB * 95% - 8 GiB * 102% leaves 7.04 GiB for 128 KiB/token FP16 KV.
    expect(estimateContext(budget)).toBe(57600);
    expect(estimateContext({ ...budget, parallelRequests: 2 })).toBe(28672);
    expect(estimateContext({ ...budget, modelBytes: 4 * 1024 ** 3 })).toBeGreaterThan(32768);
    expect(estimateContext({ ...budget, modelsAtOnce: 2 })).toBeUndefined();
  });

  it('caps at trained context, floors small budgets, and does not guess missing or invalid data', () => {
    expect(estimateContext({ ...budget, vramGiB: 1024 })).toBe(131072);
    expect(estimateContext({ ...budget, vramGiB: 1 })).toBeUndefined();
    expect(estimateContext({ ...budget, metadata: undefined })).toBeUndefined();
    expect(estimateContext({ ...budget, modelBytes: undefined })).toBeUndefined();
    expect(estimateContext({ ...budget, vramGiB: Infinity })).toBeUndefined();
    expect(estimateContext({ ...budget, parallelRequests: 0 })).toBeUndefined();
  });
});

describe('local context estimate for the architectures `/api/show` hides arrays of', () => {
  /** What the adapter does: ask plain, and ask again verbose when the answer says its arrays are null. */
  const discover = (name: string) => {
    const model = VM[name]!;
    const plain = inspectContext(model.modelInfo);
    return { plain, final: plain.needsVerbose ? inspectContext(model.verboseModelInfo) : plain, modelBytes: model.modelBytes };
  };
  const tokens = (name: string, extra: object = {}) => {
    const { final, modelBytes } = discover(name);
    const result = estimateContextResult({ vramGiB: VM_BUDGET, modelBytes, metadata: final.metadata, ...extra });
    return 'tokens' in result ? result.tokens : result.reason;
  };

  it('asks for verbose exactly where the plain answer has nulls the estimate needs', () => {
    for (const name of ['gemma-4-26b-a4b:q4_0', 'gemma-4-e2b:q4_0', 'lfm2-24b-a2b-q8_0:latest', 'nemotron-3-nano-30b-a3b:q4_k_m']) {
      const { plain, final } = discover(name);
      expect(plain.metadata, name).toBeUndefined();
      expect(plain.needsVerbose, name).toBe(true);
      expect(final.metadata, name).toBeDefined();
      expect(final.needsVerbose).toBeUndefined();
    }
    for (const name of ['qwen3-8b:q4_k_m', 'gpt-oss-20b:mxfp4', 'mistral-small-3.2-24b:q5_k_m', 'qwen3.6-27b:q4_k_m']) expect(discover(name).plain.needsVerbose, name).toBeUndefined();
  });

  it('sizes the context of every model on the server, and keeps what it already sized', () => {
    expect(Object.fromEntries(Object.keys(VM).filter((n) => !n.startsWith('embedding')).map((n) => [n, tokens(n)]))).toEqual({
      'lfm2-24b-a2b-q8_0:latest': 128000,
      'lfm2.5-230m-qad-q4_0:latest': 128000,
      'lfm2.5-230m-q4_0:latest': 128000,
      'lfm2-350m-q4_k_m:latest': 128000,
      'lfm2-350m-q4_0:latest': 128000,
      'lfm2-1.2b-q8_0:latest': 128000,
      'gemma-4-26b-a4b:q4_0': 262144,
      'gemma-4-31b:q4_0': 116480,
      'qwen3.8-27b:q4_k_m': 158720,
      'nemotron-3.5-lightning-30b-a3b:q4_0': 1048576,
      'nemotron-3-nano-30b-a3b:q4_k_m': 1048576,
      'gpt-oss-20b:mxfp4': 131072,
      'mistral-small-3.2-24b:q5_k_m': 75520,
      'gemma-4-e2b:q4_0': 131072,
      'gemma-4-e4b:q4_0': 131072,
      'gemma-4-12b:q4_0': 262144,
      'qwen3-8b:q4_k_m': 40960,
      'qwen3-coder-30b-a3b:ud-q4_k_xl': 125696,
      'qwen3.6-35b-a3b:q4_k_m': 262144,
      'qwen3.6-27b:q4_k_m': 156672,
    });
  });

  it('counts only the attention layers of a hybrid model, with the state of the others as a fixed cost', () => {
    const lfm = discover('lfm2-24b-a2b-q8_0:latest').final.metadata!;
    // 10 of 40 layers attend (8 KV heads of 2048 / 32 = 64); the 30 short-convolution layers keep (3 - 1) x 2048 F32 values.
    expect(lfm).toMatchObject({ trainedContext: 128000, layers: 10, kvHeads: 8, keyLength: 64, valueLength: 64, stateBytes: 30 * 2 * 2048 * 4 });
    const nemotron = discover('nemotron-3-nano-30b-a3b:q4_k_m').final.metadata!;
    // 6 of 52 layers attend (2 KV heads of 128); 23 are Mamba layers (no attention, no feed-forward block).
    expect(nemotron).toMatchObject({ layers: 6, kvHeads: 2, keyLength: 128, valueLength: 128 });
    expect(nemotron.stateBytes).toBe(23 * (128 * 4096 + 3 * (4096 + 2 * 8 * 128)) * 4);
    // 1M tokens of the 6 attention layers' cache fit next to the weights; a Mamba state is no per-token cost.
    expect(estimateContextResult({ vramGiB: 16, modelBytes: 1e9, metadata: nemotron })).toEqual({ tokens: 1048576 });
  });

  it('holds a sliding-window layer to its window, as Ollama 0.33 allocates it (its own log of gemma-4-12b at 32768)', () => {
    const gemma = discover('gemma-4-12b:q4_0').final.metadata!;
    // 8 global layers of 1 KV head x (512 + 512), 40 window layers of 8 KV heads x (256 + 256), window 1024.
    expect(gemma).toMatchObject({ trainedContext: 262144, layers: 8, kvHeads: 1, keyLength: 512, valueLength: 512, window: { size: 1024, kvBytesPerToken: 40 * 8 * (256 + 256) * 2 } });
    // The server logged "non-SWA KV cache, 32768 cells, 8 layers: 272 MiB" and "SWA KV cache, 2048 cells, 40 layers: 340 MiB"
    // with its cache in q8_0 (34 bytes for 32 values) where the estimate assumes FP16.
    const q8 = 34 / 64;
    expect((gemma.layers * gemma.kvHeads * (gemma.keyLength + gemma.valueLength) * 2 * 32768 * q8) / 2 ** 20).toBe(272);
    expect((gemma.window!.kvBytesPerToken * 2048 * q8) / 2 ** 20).toBe(340);
    // 10 GiB, 7.38 GB of weights and 0.54 GB of reserve leave 2.68 GB: 0.67 GB of that is the window layers' 2048 cells,
    // and the rest holds 16 KiB per token of the 8 global layers.
    expect(estimateContextResult({ vramGiB: 10, modelBytes: 7_378_661_069, metadata: gemma })).toEqual({ tokens: 122112 });
  });

  it('adds up layers whose head counts differ and leaves a pure sliding-window or ragged model unsupported', () => {
    const base = { 'general.architecture': 'x', 'x.context_length': 8192, 'x.block_count': 4, 'x.embedding_length': 512, 'x.attention.head_count': 8 };
    const ragged = inspectContext({ ...base, 'x.attention.head_count_kv': [4, 2, 0, 2] }).metadata!;
    expect(ragged).toMatchObject({ layers: 3, kvHeads: 4, keyLength: 64, kvBytesPerToken: (4 + 2 + 2) * 128 * 2 });
    expect(inspectContext({ ...base, 'x.attention.head_count_kv': [4, 2] }).metadata).toBeUndefined();
    expect(inspectContext({ ...base, 'x.attention.head_count_kv': [0, 0, 0, 0] }).metadata).toBeUndefined();
    expect(inspectContext({ ...base, 'x.attention.head_count_kv': [16, 2, 2, 2] }).metadata).toBeUndefined();
    expect(inspectContext({ ...base, 'x.attention.head_count_kv': null })).toEqual({ needsVerbose: true, architecture: 'x' });
    // A window without a pattern naming its layers (Gemma 3, Mistral) stays full-attention, as before.
    expect(inspectContext({ ...base, 'x.attention.head_count_kv': 4, 'x.attention.sliding_window': 1024 }).metadata).toEqual({ trainedContext: 8192, layers: 4, kvHeads: 4, keyLength: 64, valueLength: 64 });
    expect(inspectContext({ ...base, 'x.attention.head_count_kv': 4, 'x.attention.sliding_window': 1024, 'x.attention.sliding_window_pattern': [true, true, false] }).metadata).toBeUndefined();
  });

  it('says why a model has no size: no budget, no weight size, no metadata, invalid settings or too little room', () => {
    const metadata = discover('qwen3-8b:q4_k_m').final.metadata!;
    expect(estimateContextResult({ modelBytes: 5e9, metadata })).toEqual({ reason: 'budget' });
    expect(estimateContextResult({ vramGiB: 16, metadata })).toEqual({ reason: 'size' });
    expect(estimateContextResult({ vramGiB: 16, modelBytes: 5e9 })).toEqual({ reason: 'metadata' });
    expect(estimateContextResult({ vramGiB: 16, modelBytes: 5e9, metadata, parallelRequests: 0 })).toEqual({ reason: 'invalid' });
    expect(estimateContextResult({ vramGiB: 4, modelBytes: 5e9, metadata })).toMatchObject({ reason: 'fit' });
    expect(estimateContextResult({ vramGiB: 16, modelBytes: 5e9, metadata })).toEqual({ tokens: 40960 });
  });
});
