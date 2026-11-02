/**
 * Image generation (ARCHITECTURE §23): image providers are separate from text providers. A few wire dialects cover many
 * services, as presets; a model's capabilities say what it takes, so one tool call fits every backend.
 */
import { z } from 'zod';
import { ProviderId, type ProviderStatus } from './models.ts';

/** How a service is spoken to. A service that uses a known wire format is a preset, not a new type. */
export const ImageProviderType = z.enum(['comfyui', 'a1111', 'swarmui', 'invokeai', 'openai-images', 'gemini', 'chat-images', 'responses-image', 'bfl', 'stability', 'fal', 'replicate', 'huggingface', 'ideogram', 'bedrock']);
export type ImageProviderType = z.infer<typeof ImageProviderType>;

export const ImageSize = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
export type ImageSize = z.infer<typeof ImageSize>;

/** The sizes a model makes: any within limits, a fixed list, or aspect ratios with size names. */
export const ImageSizes = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('free'),
    min: z.number().int().positive(),
    max: z.number().int().positive(),
    /** Width and height must be multiples of this. */
    multiple: z.number().int().positive(),
    /** The side of the square the model was made for: `medium` is this many pixels squared. */
    base: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('fixed'), list: z.array(ImageSize).min(1) }),
  z.object({ kind: z.literal('aspect'), ratios: z.array(z.string()).min(1), classes: z.array(z.string()) }),
]);
export type ImageSizes = z.infer<typeof ImageSizes>;

/** Sampling settings a model works best with, or that a person set for it. */
export const ImageTuning = z.object({
  steps: z.number().int().min(1).max(200),
  guidance: z.number().min(0).max(50),
  sampler: z.string().max(100),
  scheduler: z.string().max(100),
}).partial();
export type ImageTuning = z.infer<typeof ImageTuning>;

export const ImageCapabilities = z.object({
  /** `sd15`, `sdxl`, `sdxl-distilled`, `flux`, `flux2`, `z-image`, `hosted` and so on: which recipe a model needs. */
  family: z.string().max(40),
  /** Comma-separated tags or plain sentences. */
  promptStyle: z.enum(['natural', 'tags']),
  negativePrompt: z.boolean(),
  sizes: ImageSizes,
  /** Images one request can return. */
  maxCount: z.number().int().min(1),
  /** Takes input images: edits, image to image, or references. */
  edit: z.boolean(),
  /** Takes a mask with an input image, to change one area. */
  mask: z.boolean(),
  maxReferences: z.number().int().min(0),
  transparent: z.boolean(),
  seed: z.boolean(),
  /** Sends pictures while it works. */
  previews: z.boolean(),
  /** The sampling settings it takes. */
  tunable: z.boolean(),
  defaults: ImageTuning.optional(),
  samplers: z.array(z.string()).optional(),
  schedulers: z.array(z.string()).optional(),
  loras: z.array(z.string()).optional(),
});
export type ImageCapabilities = z.infer<typeof ImageCapabilities>;

/** A workflow someone brought to ComfyUI: its graph in API format, and which inputs mean what. */
export const ImageWorkflowInput = z.object({ node: z.string().max(40), input: z.string().max(100) });
export type ImageWorkflowInput = z.infer<typeof ImageWorkflowInput>;
export const ImageWorkflow = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  name: z.string().min(1).max(100),
  graph: z.record(z.string(), z.unknown()),
  map: z.object({
    prompt: ImageWorkflowInput,
    negative: ImageWorkflowInput.optional(),
    seed: ImageWorkflowInput.optional(),
    steps: ImageWorkflowInput.optional(),
    guidance: ImageWorkflowInput.optional(),
    sampler: ImageWorkflowInput.optional(),
    scheduler: ImageWorkflowInput.optional(),
    width: ImageWorkflowInput.optional(),
    height: ImageWorkflowInput.optional(),
    count: ImageWorkflowInput.optional(),
    image: ImageWorkflowInput.optional(),
    mask: ImageWorkflowInput.optional(),
  }),
  capabilities: ImageCapabilities.partial().optional(),
});
export type ImageWorkflow = z.infer<typeof ImageWorkflow>;

export const ImageProviderConfig = z.object({
  id: ProviderId,
  type: ImageProviderType,
  /** The service it was added as (`IMAGE_PROVIDER_PRESETS`), which says how that service differs. */
  preset: z.string().max(40).optional(),
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  /** Usually `${secret:<id>}`. */
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  parallelRequests: z.number().int().min(1).max(64).optional(),
  /** A local text provider on the same GPU: an image job waits its turn there and unloads what it holds. */
  sharesGpuWith: z.string().max(48).optional(),
  /** Unloads the image model after every job, so the GPU is free for others. */
  freeAfterRun: z.boolean().optional(),
  /** Model ids typed in, for services with no list of models. */
  models: z.array(z.string().min(1).max(200)).max(200).optional(),
  workflows: z.array(ImageWorkflow).max(50).optional(),
});
export type ImageProviderConfig = z.infer<typeof ImageProviderConfig>;

export const ImageProviderDraft = ImageProviderConfig.omit({ apiKey: true }).extend({
  apiKey: z.string().optional(),
  apiKeyFromEnv: z.string().optional(),
  /** Copies the key of this text provider, so nobody pastes it twice. */
  apiKeyFromProvider: z.string().optional(),
});
export type ImageProviderDraft = z.infer<typeof ImageProviderDraft>;

export const ImageModelOverride = z
  .object({
    hidden: z.boolean(),
    displayName: z.string().max(100),
    favorite: z.boolean(),
    order: z.number().int(),
    /** What it's good at, in the admin's words: the text model reads this when it chooses. */
    description: z.string().max(200),
    tuning: ImageTuning,
    /** Listed by hand, for a model the service doesn't report. */
    manual: z.boolean(),
  })
  .partial();
export type ImageModelOverride = z.infer<typeof ImageModelOverride>;

export const ImageModelInfo = z.object({
  ref: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  capabilities: ImageCapabilities,
  description: z.string().optional(),
  source: z.enum(['detected', 'catalog', 'default', 'override']),
  hidden: z.boolean(),
  favorite: z.boolean(),
  order: z.number(),
  personal: z.object({ deviceId: z.string(), deviceName: z.string() }).optional(),
  available: z.boolean().optional(),
});
export type ImageModelInfo = z.infer<typeof ImageModelInfo>;

/** What an image costs, whichever way the service counts. Any of these may be set; the first that fits is used. */
export const ImagePrice = z.object({
  perImage: z.number().nonnegative().optional(),
  /** Dollars per image by `1024x1024` or by size name. */
  bySize: z.record(z.string(), z.number().nonnegative()).optional(),
  perMegapixel: z.number().nonnegative().optional(),
  /** Dollars per million tokens, for services that count those. */
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
});
export type ImagePrice = z.infer<typeof ImagePrice>;

/** A generated image, as the transcript shows it. Providers never see this. */
export const GeneratedImageMeta = z.object({
  /** What the model calls it: `img_` and the start of its hash. */
  id: z.string(),
  blob: z.string(),
  mime: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  prompt: z.string(),
  revisedPrompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  ref: z.string(),
  modelName: z.string(),
  seed: z.number().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  /** The cost comes from a price list, not from the service. */
  costEstimated: z.boolean().optional(),
});
export type GeneratedImageMeta = z.infer<typeof GeneratedImageMeta>;

/** How far a running generation is, while it runs. Not stored. */
export const ImageProgress = z.object({
  phase: z.enum(['queued', 'freeing', 'loading', 'generating', 'finishing']),
  /** Jobs ahead in the queue. */
  ahead: z.number().int().nonnegative().optional(),
  step: z.number().int().nonnegative().optional(),
  steps: z.number().int().nonnegative().optional(),
  /** 0 to 1. */
  fraction: z.number().min(0).max(1).optional(),
  etaMs: z.number().nonnegative().optional(),
  /** The size it will be, so the frame has its shape from the start. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  count: z.number().int().positive().optional(),
  /** A small picture of the work so far. */
  preview: z.object({ mime: z.string(), data: z.string().max(400_000) }).optional(),
});
export type ImageProgress = z.infer<typeof ImageProgress>;

/** A generated image in the person's library. */
export const GeneratedImage = GeneratedImageMeta.extend({ sessionId: z.string().nullable(), sessionTitle: z.string().nullable(), createdAt: z.number() });
export type GeneratedImage = z.infer<typeof GeneratedImage>;

export const IMAGE_ID_PREFIX = 'img_';
/** What the model calls an image: short enough to repeat, and only looked up among the images of its own session. */
export const imageId = (sha256: string): string => `${IMAGE_ID_PREFIX}${sha256.slice(0, 8)}`;

export type ImagePresetGroup = 'local' | 'cloud' | 'aggregator' | 'custom';

export interface ImagePreset {
  id: string;
  label: string;
  type: ImageProviderType;
  group: ImagePresetGroup;
  baseUrl: string;
  /** Needs a key; null where one is optional. */
  key: 'required' | 'optional' | 'none';
  /** Where to get a key. */
  keyUrl?: string;
  /** One line under the form, such as how to start the server. */
  help?: string;
  /** The service reports no models: they are typed in, starting from these. */
  suggestedModels?: readonly string[];
  /** The text provider type whose key works here too. */
  sharesKeyWith?: 'openai' | 'openai-compatible';
}

/** Every service in the Add dialog, in its order. */
export const IMAGE_PROVIDER_PRESETS: readonly ImagePreset[] = [
  { id: 'comfyui', label: 'ComfyUI', type: 'comfyui', group: 'local', baseUrl: 'http://127.0.0.1:8188', key: 'none', help: 'Your checkpoints appear as models. To reach it from another computer, start it with --listen.' },
  { id: 'forge', label: 'Forge', type: 'a1111', group: 'local', baseUrl: 'http://127.0.0.1:7860', key: 'none', help: 'Start it with --api. Forge Neo and reForge work the same way.' },
  { id: 'a1111', label: 'AUTOMATIC1111', type: 'a1111', group: 'local', baseUrl: 'http://127.0.0.1:7860', key: 'none', help: 'Start it with --api.' },
  { id: 'sdnext', label: 'SD.Next', type: 'a1111', group: 'local', baseUrl: 'http://127.0.0.1:7860', key: 'none' },
  { id: 'swarmui', label: 'SwarmUI', type: 'swarmui', group: 'local', baseUrl: 'http://127.0.0.1:7801', key: 'none' },
  { id: 'invokeai', label: 'InvokeAI', type: 'invokeai', group: 'local', baseUrl: 'http://127.0.0.1:9090', key: 'none' },
  { id: 'drawthings', label: 'Draw Things', type: 'a1111', group: 'local', baseUrl: 'http://127.0.0.1:7860', key: 'none', help: 'Turn on the API Server in the app, with HTTP as the protocol.' },
  { id: 'koboldcpp', label: 'KoboldCpp', type: 'a1111', group: 'local', baseUrl: 'http://127.0.0.1:5001', key: 'none', help: 'Start it with an image model loaded.' },
  { id: 'sd-server', label: 'stable-diffusion.cpp', type: 'openai-images', group: 'local', baseUrl: 'http://127.0.0.1:1234', key: 'none', help: 'Use its sd-server program.' },
  { id: 'localai', label: 'LocalAI', type: 'openai-images', group: 'local', baseUrl: 'http://127.0.0.1:8080', key: 'optional' },
  { id: 'ollama', label: 'Ollama', type: 'openai-images', group: 'local', baseUrl: 'http://127.0.0.1:11434', key: 'none', help: 'Image models in Ollama are experimental, and only some of its builds can run them.' },
  { id: 'openai', label: 'OpenAI', type: 'openai-images', group: 'cloud', baseUrl: 'https://api.openai.com', key: 'required', keyUrl: 'https://platform.openai.com/api-keys', sharesKeyWith: 'openai' },
  { id: 'chatgpt', label: 'ChatGPT Plan', type: 'responses-image', group: 'cloud', baseUrl: 'https://chatgpt.com/backend-api/codex', key: 'none', help: 'Uses your ChatGPT Plan sign-in, and your plan’s limits.' },
  { id: 'gemini', label: 'Google Gemini', type: 'gemini', group: 'cloud', baseUrl: 'https://generativelanguage.googleapis.com', key: 'required', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'bfl', label: 'Black Forest Labs', type: 'bfl', group: 'cloud', baseUrl: 'https://api.bfl.ai', key: 'required', keyUrl: 'https://api.bfl.ai' },
  { id: 'stability', label: 'Stability AI', type: 'stability', group: 'cloud', baseUrl: 'https://api.stability.ai', key: 'required', keyUrl: 'https://platform.stability.ai/account/keys' },
  { id: 'xai', label: 'xAI', type: 'openai-images', group: 'cloud', baseUrl: 'https://api.x.ai', key: 'required', keyUrl: 'https://console.x.ai' },
  { id: 'ideogram', label: 'Ideogram', type: 'ideogram', group: 'cloud', baseUrl: 'https://api.ideogram.ai', key: 'required', keyUrl: 'https://ideogram.ai/manage-api' },
  { id: 'recraft', label: 'Recraft', type: 'openai-images', group: 'cloud', baseUrl: 'https://external.api.recraft.ai', key: 'required', keyUrl: 'https://www.recraft.ai/profile/api' },
  { id: 'azure', label: 'Azure OpenAI', type: 'openai-images', group: 'cloud', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com', key: 'required', help: 'Add each image deployment by name as a model.' },
  { id: 'bedrock', label: 'Amazon Bedrock', type: 'bedrock', group: 'cloud', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', key: 'required', help: 'Paste a Bedrock API key, or an access key and secret as ACCESS_KEY:SECRET.' },
  { id: 'openrouter', label: 'OpenRouter', type: 'chat-images', group: 'aggregator', baseUrl: 'https://openrouter.ai/api', key: 'required', keyUrl: 'https://openrouter.ai/keys', sharesKeyWith: 'openai-compatible' },
  { id: 'fal', label: 'fal.ai', type: 'fal', group: 'aggregator', baseUrl: 'https://queue.fal.run', key: 'required', keyUrl: 'https://fal.ai/dashboard/keys', suggestedModels: ['fal-ai/flux/schnell', 'fal-ai/flux-2/pro'] },
  { id: 'replicate', label: 'Replicate', type: 'replicate', group: 'aggregator', baseUrl: 'https://api.replicate.com', key: 'required', keyUrl: 'https://replicate.com/account/api-tokens', suggestedModels: ['black-forest-labs/flux-schnell', 'black-forest-labs/flux-1.1-pro'] },
  { id: 'together', label: 'Together AI', type: 'openai-images', group: 'aggregator', baseUrl: 'https://api.together.xyz', key: 'required', keyUrl: 'https://api.together.ai/settings/api-keys', suggestedModels: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.2-dev'] },
  { id: 'huggingface', label: 'Hugging Face', type: 'huggingface', group: 'aggregator', baseUrl: 'https://router.huggingface.co', key: 'required', keyUrl: 'https://huggingface.co/settings/tokens', suggestedModels: ['black-forest-labs/FLUX.1-dev'] },
  { id: 'openai-compatible', label: 'OpenAI-compatible images', type: 'openai-images', group: 'custom', baseUrl: 'http://127.0.0.1:8000', key: 'optional', help: 'Any server with /v1/images/generations, such as LiteLLM.' },
];

export const imagePreset = (id: string | undefined): ImagePreset | undefined => IMAGE_PROVIDER_PRESETS.find((p) => p.id === id);

/** One image provider's health; the same shape as a text provider's. */
export type ImageProviderStatus = ProviderStatus;

/** A local image server found on a default port. */
export const DetectedImageServer = z.object({ preset: z.string(), type: ImageProviderType, baseUrl: z.string(), label: z.string() });
export type DetectedImageServer = z.infer<typeof DetectedImageServer>;
