/**
 * Static capability knowledge for ids whose APIs don't describe themselves (OpenAI) or as a fallback when
 * discovery metadata is missing (Anthropic). Detection always wins over the catalog; user overrides win over both.
 */
import { ULTRACODE_LEVEL, type Capabilities, type Effort, type ModelInfo, type PromptTier, type ProviderType } from '@atelier/protocol';
import type { ListedModel, ProviderInstance } from './types.ts';

export interface CatalogEntry {
  displayName: string;
  contextLength: number;
  maxOutput: number;
  capabilities: Capabilities;
  effortLevels?: string[];
}

export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const OPENAI_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const BASIC_EFFORTS = ['low', 'medium', 'high'];

function claude(
  displayName: string,
  contextLength: number,
  maxOutput: number,
  reasoning: 'effort' | 'budget',
): CatalogEntry {
  return {
    displayName,
    contextLength,
    maxOutput,
    capabilities: { tools: 'native', vision: true, pdf: true, reasoning, caching: true },
    ...(reasoning === 'effort' ? { effortLevels: ANTHROPIC_EFFORTS } : {}),
  };
}

const ANTHROPIC: Record<string, CatalogEntry> = {
  'claude-opus-5-5': claude('Claude Opus 5.5', 1_000_000, 128_000, 'effort'),
  'claude-sonnet-5-5': claude('Claude Sonnet 5.5', 1_000_000, 128_000, 'effort'),
  'claude-haiku-5-5': claude('Claude Haiku 5.5', 1_000_000, 128_000, 'effort'),
  'claude-fable-5-1': claude('Claude Fable 5.1', 1_000_000, 128_000, 'effort'),
  'claude-opus-4-6': claude('Claude Opus 4.6', 200_000, 128_000, 'effort'),
  'claude-sonnet-4-6': claude('Claude Sonnet 4.6', 200_000, 64_000, 'effort'),
  'claude-opus-4-5': claude('Claude Opus 4.5', 200_000, 64_000, 'budget'),
  'claude-sonnet-4-5': claude('Claude Sonnet 4.5', 200_000, 64_000, 'budget'),
  'claude-haiku-4-5': claude('Claude Haiku 4.5', 200_000, 64_000, 'budget'),
  'claude-opus-4-1': claude('Claude Opus 4.1', 200_000, 32_000, 'budget'),
};

function gpt(
  displayName: string,
  contextLength: number,
  maxOutput: number,
  effortLevels: string[] | null,
  vision = true,
): CatalogEntry {
  return {
    displayName,
    contextLength,
    maxOutput,
    capabilities: { tools: 'native', vision, pdf: vision, reasoning: effortLevels ? 'effort' : 'none', caching: true },
    ...(effortLevels ? { effortLevels } : {}),
  };
}

const OPENAI: Record<string, CatalogEntry> = {
  'gpt-6-astra': gpt('GPT-6 Astra', 1_050_000, 128_000, OPENAI_EFFORTS),
  'gpt-6.1-sol': gpt('GPT-6.1 Sol', 1_050_000, 128_000, OPENAI_EFFORTS),
  'gpt-6-luna': gpt('GPT-6 Luna', 1_050_000, 128_000, OPENAI_EFFORTS),
  'gpt-5.5': gpt('GPT-5.5', 1_050_000, 128_000, OPENAI_EFFORTS),
  'gpt-5.4': gpt('GPT-5.4', 1_050_000, 128_000, OPENAI_EFFORTS),
  'gpt-5.2': gpt('GPT-5.2', 400_000, 128_000, OPENAI_EFFORTS),
  'gpt-5.1': gpt('GPT-5.1', 400_000, 128_000, BASIC_EFFORTS),
  'gpt-5': gpt('GPT-5', 400_000, 128_000, BASIC_EFFORTS),
  'gpt-5-mini': gpt('GPT-5 mini', 400_000, 128_000, BASIC_EFFORTS),
  'gpt-5-nano': gpt('GPT-5 nano', 400_000, 128_000, BASIC_EFFORTS),
  'gpt-4.1': gpt('GPT-4.1', 1_047_576, 32_768, null),
  'gpt-4.1-mini': gpt('GPT-4.1 mini', 1_047_576, 32_768, null),
  'gpt-4o': gpt('GPT-4o', 128_000, 16_384, null),
  'gpt-4o-mini': gpt('GPT-4o mini', 128_000, 16_384, null),
  o3: gpt('o3', 200_000, 100_000, BASIC_EFFORTS),
  'o4-mini': gpt('o4-mini', 200_000, 100_000, BASIC_EFFORTS),
  'o3-mini': gpt('o3-mini', 200_000, 100_000, BASIC_EFFORTS, false),
};

type Recommended = NonNullable<ModelInfo['recommendedEffort']>;
const recommended = (code: Effort, chat: Effort, work: Effort): Recommended => ({ code, chat, work });

/** The effort level Anthropic recommends per model family and mode; models not listed start at Medium. */
const ANTHROPIC_RECOMMENDED: Record<string, Recommended> = {
  'claude-opus-5-5': recommended('medium', 'medium', 'medium'),
  'claude-sonnet-5-5': recommended('medium', 'medium', 'medium'),
  'claude-haiku-5-5': recommended('medium', 'medium', 'medium'),
  'claude-fable-5-1': recommended('high', 'medium', 'medium'),
  'claude-fable-5': recommended('high', 'high', 'high'),
  'claude-opus-5': recommended('high', 'high', 'high'),
  'claude-opus-4-8': recommended('high', 'high', 'high'),
  'claude-sonnet-5': recommended('high', 'medium', 'high'),
  'claude-opus-4-7': recommended('xhigh', 'xhigh', 'xhigh'),
  'claude-opus-4-6': recommended('high', 'medium', 'medium'),
  'claude-sonnet-4-6': recommended('high', 'low', 'medium'),
};

/** Exact id, or the longest catalog key that prefixes `id` at a `-` boundary (dated snapshots, `-latest`). */
function lookup<T>(table: Record<string, T>, id: string): T | undefined {
  const exact = table[id];
  if (exact) return exact;
  const key = Object.keys(table)
    .filter((k) => id.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key === undefined ? undefined : table[key];
}

export function anthropicCatalog(id: string): CatalogEntry | undefined {
  return lookup(ANTHROPIC, id);
}

export function openaiCatalog(id: string): CatalogEntry | undefined {
  return lookup(OPENAI, id);
}

export function anthropicRecommendedEffort(id: string): Recommended | undefined {
  return lookup(ANTHROPIC_RECOMMENDED, id);
}

/** Ultracode asks the provider for Extra (`xhigh`); each adapter then clamps that to what the model accepts. */
export function providerEffort(effort: Effort): Exclude<Effort, 'ultracode'> {
  return effort === 'ultracode' ? ULTRACODE_LEVEL : effort;
}

/** Open-weight or routed models strong enough for the full prompt tier. */
const FRONTIER = [
  /^deepseek-(v3|v4|r1|r2|chat|reasoner)/,
  /^kimi-k2/,
  /^qwen3(\.\d+)?-(coder-)?(480b|235b|max|plus)/,
  /^qwen3-coder-plus/,
  /^glm-(4\.[5-9]|5)(?!.*air)/,
  /^gpt-oss-120b/,
  /^gemini-[\d.]+-pro/,
  /^grok-[3-9]/,
  /^mistral-large/,
  /^claude-/,
];

/** `full` for Anthropic/OpenAI and catalog-known frontier ids (including routed `vendor/model` ids), else `compact`. */
export function tierFor(type: ProviderType, modelId: string): PromptTier {
  if (type === 'anthropic' || type === 'openai') return 'full';
  const bare = (modelId.split('/').pop() ?? modelId).toLowerCase().replaceAll(':', '-');
  if (anthropicCatalog(bare) || openaiCatalog(bare)) return 'full';
  return FRONTIER.some((re) => re.test(bare)) ? 'full' : 'compact';
}

export const DEFAULT_CONTEXT = 32_768;

export function defaultCapabilities(): Capabilities {
  return { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: false };
}

/** Build a `ListedModel` for this provider instance; `tier` defaults from `tierFor`. */
export function listedModel(
  instance: ProviderInstance,
  modelId: string,
  info: Omit<ListedModel, 'ref' | 'providerId' | 'modelId' | 'tier'> & { tier?: PromptTier },
): ListedModel {
  const { tier, effortLevels, ...rest } = info;
  return {
    ref: `${instance.id}/${modelId}`,
    providerId: instance.id,
    modelId,
    ...rest,
    tier: tier ?? tierFor(instance.type, modelId),
    ...(effortLevels && effortLevels.length > 0 ? { effortLevels } : {}),
  };
}

/** Clamp a requested effort to the nearest level the model accepts (prefer the next lower one). */
export function clampEffort(effort: string, levels: readonly string[] | undefined, order: readonly string[]): string {
  if (!levels || levels.length === 0 || levels.includes(effort)) return effort;
  const wanted = order.indexOf(effort);
  const ranked = levels.map((l) => ({ l, i: order.indexOf(l) })).filter((x) => x.i >= 0);
  const lower = ranked.filter((x) => x.i <= wanted).sort((a, b) => b.i - a.i)[0];
  const higher = ranked.sort((a, b) => a.i - b.i)[0];
  return (lower ?? higher)?.l ?? effort;
}
