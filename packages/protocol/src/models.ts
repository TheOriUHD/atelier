import { z } from 'zod';

export const ProviderType = z.enum(['ollama', 'llamacpp', 'anthropic', 'openai', 'openai-compatible', 'chatgpt', 'chatgpt-chat', 'copilot']);
export type ProviderType = z.infer<typeof ProviderType>;

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  ollama: 'Ollama',
  llamacpp: 'llama.cpp',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible',
  chatgpt: 'ChatGPT Plan',
  'chatgpt-chat': 'ChatGPT Chat',
  copilot: 'GitHub Copilot',
};

export function chatGptPlanLabel(plan: string): string {
  const key = plan.toLowerCase();
  if (key === 'prolite' || key === 'pro_lite') return 'Pro 100';
  if (key === 'pro') return 'Pro 200';
  if (key === 'promax' || key === 'pro_max') return 'Pro 500';
  const tier = /^pro[_-]?(100|200|500)$/.exec(key);
  return tier ? `Pro ${tier[1]}` : plan.charAt(0).toUpperCase() + plan.slice(1);
}

export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  ollama: 'http://localhost:11434',
  llamacpp: 'http://localhost:8080',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  'openai-compatible': 'http://localhost:1234/v1',
  chatgpt: 'https://chatgpt.com/backend-api/codex',
  'chatgpt-chat': 'https://chatgpt.com',
  copilot: 'https://api.githubcopilot.com',
};

/** Provider ids never contain "/", so a model ref splits unambiguously on the first slash. */
export const ProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'lowercase letters, digits and dashes');

export function modelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function parseModelRef(ref: string): { providerId: string; modelId: string } | null {
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) return null;
  return { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

export const ToolSupport = z.enum(['native', 'prompted', 'none']);
export type ToolSupport = z.infer<typeof ToolSupport>;
export const ReasoningSupport = z.enum(['none', 'toggle', 'effort', 'budget']);
export type ReasoningSupport = z.infer<typeof ReasoningSupport>;
export const PromptTier = z.enum(['full', 'compact']);
export type PromptTier = z.infer<typeof PromptTier>;

export const Capabilities = z.object({
  tools: ToolSupport,
  vision: z.boolean(),
  pdf: z.boolean(),
  reasoning: ReasoningSupport,
  caching: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

/**
 * Reasoning depth, lowest first. `xhigh` is "Extra". `ultracode` (Code only) runs at the model's highest level and has
 * the model orchestrate sub-agents and have their results checked (packages/core/src/agent/chat-service.ts).
 */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
export type Effort = z.infer<typeof Effort>;

export const ModelInfo = z.object({
  /** `providerId/modelId` */
  ref: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  contextLength: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  /** Cached discovery inputs keep memory estimates available while a provider is offline. */
  contextEstimate: z.object({
    modelBytes: z.number().positive(),
    metadata: z.object({ trainedContext: z.number().positive(), layers: z.number().positive(), kvHeads: z.number().positive(), keyLength: z.number().positive(), valueLength: z.number().positive() }),
  }).optional(),
  calculatedContextLength: z.number().int().positive().optional(),
  capabilities: Capabilities,
  tier: PromptTier,
  /** Where the capability data came from. */
  source: z.enum(['detected', 'catalog', 'default', 'override']),
  /** Effort levels the model accepts, when reasoning is 'effort'. */
  effortLevels: z.array(z.string()).optional(),
  /** The level the effort control starts at and marks "Recommended", per mode; Medium where unset. */
  recommendedEffort: z.object({ chat: Effort, work: Effort, code: Effort }).optional(),
  /**
   * Stops a provider fixes for the effort control (ChatGPT Chat's own picker): exactly these, lowest first, each with its
   * own name, help and warning. They replace the usual Low to Max scale, and Ultracode is not offered. `effort` is the
   * level the stop stands for, which is what the session stores. `featured` draws the stop like Ultracode (the violet
   * name and the charged field across the slider) while it is chosen; it is only a look, and only the last stop has it.
   */
  effortStops: z
    .array(z.object({ effort: Effort.exclude(['ultracode']), label: z.string(), help: z.string().optional(), warning: z.string().optional(), featured: z.boolean().optional() }))
    .optional(),
  /** The provider charges nothing for it (OpenRouter's free models, which have a daily request limit instead). */
  free: z.boolean().optional(),
  hidden: z.boolean(),
  favorite: z.boolean(),
  order: z.number(),
  /** Added by id and not reported by its provider, so Settings › Admin › Models can remove it. */
  manual: z.boolean().optional(),
  /** Sampling temperature set in Settings › Admin › Models; adapters omit it where the API disallows it. */
  temperature: z.number().min(0).max(2).optional(),
  /** A personal provider's model (personal-providers.ts): it runs on this computer of its owner's, the only one who sees it. */
  personal: z.object({ deviceId: z.string(), deviceName: z.string() }).optional(),
  /** False while a personal model's computer isn't connected or doesn't lend it: listed, but it can't answer. */
  available: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const ProviderStatus = z.object({
  providerId: z.string(),
  ok: z.boolean(),
  latencyMs: z.number().nullable(),
  version: z.string().optional(),
  modelCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  error: z.string().optional(),
  checkedAt: z.number(),
  /** The server's queue as Atelier runs it: requests at once, and models at once (null: no limit). */
  queue: z.object({ parallel: z.number().int().positive(), modelsAtOnce: z.number().int().positive().nullable() }).optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;
