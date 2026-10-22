/**
 * What the model providers charge per million tokens, for the models Atelier knows them for: the cost of a request is
 * shown without anyone having to enter prices. A price set in Settings › Usage for a model wins over these.
 *
 * List prices as published on the providers' pricing pages on 2026-10-15 (docs.claude.com pricing, OpenAI API pricing).
 * They change: that is why a person's own price overrides, and why a model that isn't here shows no cost instead of a
 * guess. Cache writes are the 5-minute rate. The ChatGPT subscription has no per-token price (the plan's limits are
 * what it spends).
 */
import type { Price, ProviderType } from '@atelier/protocol';

const p = (input: number, output: number, cacheRead?: number, cacheWrite?: number, longContext?: Price['longContext']): Price => ({
  input,
  output,
  ...(cacheRead !== undefined ? { cacheRead } : {}),
  ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  ...(longContext ? { longContext } : {}),
});

/** Anthropic, by model id without a date suffix and with dashes (`claude-sonnet-5-5`). */
const ANTHROPIC: Record<string, Price> = {
  'claude-fable-5-1': p(10, 50, 0.25, 12.5),
  'claude-fable-5': p(10, 50, 1, 12.5),
  'claude-mythos-5-1': p(10, 50, 0.25, 12.5),
  'claude-mythos-5': p(10, 50, 1, 12.5),
  'claude-opus-5-5': p(4, 20, 0.2, 5),
  'claude-opus-5': p(5, 25, 0.5, 6.25),
  'claude-opus-4-8': p(5, 25, 0.5, 6.25),
  'claude-opus-4-7': p(5, 25, 0.5, 6.25),
  'claude-opus-4-6': p(5, 25, 0.5, 6.25),
  'claude-opus-4-5': p(5, 25, 0.5, 6.25),
  'claude-opus-4-1': p(15, 75, 1.5, 18.75),
  'claude-opus-4': p(15, 75, 1.5, 18.75),
  'claude-sonnet-5-5': p(2, 10, 0.1, 2.5),
  'claude-sonnet-5': p(2, 10, 0.2, 2.5),
  'claude-sonnet-4-6': p(3, 15, 0.3, 3.75),
  'claude-sonnet-4-5': p(3, 15, 0.3, 3.75),
  'claude-sonnet-4': p(3, 15, 0.3, 3.75),
  'claude-haiku-5-5': p(0.1, 0.5, 0.01, 0.125, { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }),
  'claude-haiku-4-5': p(1, 5, 0.1, 1.25),
  'claude-3-5-haiku': p(0.8, 4, 0.08, 1),
};

/** OpenAI, by model id. Past 272K input tokens a request is charged the long-context rates. */
const OPENAI: Record<string, Price> = {
  'gpt-6-astra': p(10, 50, 1, undefined, { above: 272_000, input: 20, output: 75, cacheRead: 2 }),
  'gpt-6.1-sol': p(2, 10, 0.1, undefined, { above: 272_000, input: 4, output: 15, cacheRead: 0.2 }),
  'gpt-6-sol': p(2, 10, 0.2, undefined, { above: 272_000, input: 4, output: 15, cacheRead: 0.4 }),
  'gpt-6-luna': p(0.1, 0.5, 0.01, undefined, { above: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02 }),
  'gpt-5.6-sol': p(4, 20, 0.4, undefined, { above: 272_000, input: 8, output: 30, cacheRead: 0.8 }),
  'gpt-5.6-terra': p(2, 12, 0.2, undefined, { above: 272_000, input: 4, output: 18, cacheRead: 0.4 }),
  'gpt-5.6-luna': p(0.2, 1.2, 0.02, undefined, { above: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04 }),
  'gpt-5.5': p(5, 30, 0.5, undefined, { above: 272_000, input: 10, output: 45, cacheRead: 1 }),
  'gpt-5.5-pro': p(30, 180, undefined, undefined, { above: 272_000, input: 60, output: 270 }),
  'gpt-5.4': p(2.5, 15, 0.25, undefined, { above: 272_000, input: 5, output: 22.5, cacheRead: 0.5 }),
  'gpt-5.4-pro': p(30, 180, undefined, undefined, { above: 272_000, input: 60, output: 270 }),
  'gpt-5.4-mini': p(0.75, 4.5, 0.075),
  'gpt-5.4-nano': p(0.2, 1.25, 0.02),
  'gpt-5.2': p(1.75, 14, 0.175),
  'gpt-5.2-pro': p(21, 168),
  'gpt-5.1': p(1.25, 10, 0.125),
  'gpt-5': p(1.25, 10, 0.125),
  'gpt-5-mini': p(0.25, 2, 0.025),
  'gpt-5-nano': p(0.05, 0.4, 0.005),
  'gpt-5-pro': p(15, 120),
};

/** A model id as the tables spell it: lower case, dots as dashes for Claude, a trailing date (`-20251001`) dropped. */
const normalize = (id: string) => id.toLowerCase().replace(/-\d{8}$/, '');

/** The provider's list price for the model, or null when Atelier doesn't know it (it never guesses). */
export function listPrice(type: ProviderType, modelId: string): Price | null {
  if (type === 'anthropic') return ANTHROPIC[normalize(modelId).replaceAll('.', '-')] ?? null;
  if (type === 'openai') return OPENAI[normalize(modelId)] ?? null;
  return null;
}

/** Dollars for one request's usage at `price` (per million tokens); a request past the long-context size costs all at those rates. */
export function costOf(price: Price, usage: { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined }): number {
  const read = usage.cacheRead ?? 0;
  const write = usage.cacheWrite ?? 0;
  const tier = price.longContext && usage.input + read + write > price.longContext.above ? price.longContext : null;
  const rates = tier ?? price;
  return (
    (usage.input * rates.input + usage.output * rates.output + read * (rates.cacheRead ?? price.cacheRead ?? rates.input) + write * (rates.cacheWrite ?? price.cacheWrite ?? rates.input)) /
    1_000_000
  );
}
