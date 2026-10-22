import { describe, expect, it } from 'vitest';
import { contextMetadata, estimateContext } from './context-estimator.ts';

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
