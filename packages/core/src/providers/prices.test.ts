import { describe, expect, it } from 'vitest';
import { costOf, listPrice } from './prices.ts';

describe('listPrice', () => {
  it('knows Anthropic models by id, with or without a date or dots', () => {
    expect(listPrice('anthropic', 'claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(listPrice('anthropic', 'claude-sonnet-5.5')).toEqual(listPrice('anthropic', 'claude-sonnet-5-5'));
    expect(listPrice('anthropic', 'claude-haiku-4-5-20251001')).toMatchObject({ input: 1, output: 5 });
    expect(listPrice('anthropic', 'claude-opus-5-5')).toMatchObject({ input: 4, output: 20 });
    expect(listPrice('anthropic', 'claude-opus-5')).toMatchObject({ input: 5, output: 25 });
  });

  it('knows OpenAI models by id', () => {
    expect(listPrice('openai', 'gpt-5.6-sol')).toMatchObject({ input: 4, output: 20, cacheRead: 0.4 });
    expect(listPrice('openai', 'gpt-6.1-sol')).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 });
  });

  it('never guesses: an unknown model, another provider or the subscription has no price', () => {
    expect(listPrice('anthropic', 'claude-opus-9')).toBeNull();
    expect(listPrice('openai', 'gpt-9')).toBeNull();
    expect(listPrice('chatgpt', 'gpt-5.6-sol')).toBeNull();
    expect(listPrice('ollama', 'qwen3:8b')).toBeNull();
  });
});

describe('costOf', () => {
  it('prices input, output, cache reads and writes per million tokens', () => {
    const sonnet = listPrice('anthropic', 'claude-sonnet-5-5')!;
    // 100k fresh + 10k out + 400k from cache + 50k cache write: 0.2 + 0.1 + 0.04 + 0.125
    expect(costOf(sonnet, { input: 100_000, output: 10_000, cacheRead: 400_000, cacheWrite: 50_000 })).toBeCloseTo(0.465, 6);
  });

  it('charges the long-context rates for a whole request past the threshold', () => {
    const sol = listPrice('openai', 'gpt-5.6-sol')!;
    expect(costOf(sol, { input: 200_000, output: 1_000 })).toBeCloseTo(0.8 + 0.02, 6);
    // 300k of input in all (some cached): everything at the long-context rates.
    expect(costOf(sol, { input: 100_000, output: 1_000, cacheRead: 200_000 })).toBeCloseTo(0.8 + 0.03 + 0.16, 6);
  });
});
