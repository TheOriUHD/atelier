/**
 * Image generation (ARCHITECTURE §23): image providers are separate from text providers. A few wire dialects cover many
 * services, as presets; a model's capabilities say what it takes, so one tool call fits every backend.
 */
import { z } from 'zod';
import { PersonalProviderId, ProviderId, ProviderStatus } from './models.ts';

/** How a service is spoken to. A service that uses a known wire format is a preset, not a new type. */
export const ImageProviderType = z.enum([
  'comfyui',
  'a1111',
  'swarmui',
  'invokeai',
  'openai-images',
  'gemini',
  'chat-images',
  'responses-image',
  'bfl',
  'stability',
  'fal',
  'replicate',
  'huggingface',
  'ideogram',
  'bedrock',
  'openrouter-video',
  'xai-video',
  // Sound: speech, music and sound effects.
  'openai-speech',
  'elevenlabs',
  'gemini-audio',
  'xai-speech',
  'cartesia',
  'deepgram',
  'fish-audio',
  'minimax-audio',
  'acestep',
]);
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

/** The lengths a video model makes: a list of whole seconds, or any length in a range. */
export const VideoDurations = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), seconds: z.array(z.number().positive()).min(1) }),
  z.object({ kind: z.literal('range'), min: z.number().positive(), max: z.number().positive(), /** Lengths come in multiples of this, from `min`. */ step: z.number().positive().optional() }),
]);
export type VideoDurations = z.infer<typeof VideoDurations>;

/** What a video model takes, beside what every model takes (`ImageCapabilities`; its `sizes` say the shapes and resolutions). */
export const VideoCapabilities = z.object({
  durations: VideoDurations,
  /** The length used when the call names none. A person can change it per model. */
  defaultSeconds: z.number().positive(),
  /** The model decides how long the clip is and takes no length: `durations` and `defaultSeconds` are only a guess for sums. */
  fixedLength: z.boolean().optional(),
  /** Frame rates it takes; absent when it has one it doesn't let anyone change. */
  fps: z.array(z.number().int().positive()).optional(),
  defaultFps: z.number().int().positive().optional(),
  /** Resolutions by name (`720p`), small to large. Absent when the shapes in `sizes` are all there is. */
  resolutions: z.array(z.string()).optional(),
  /** An image to start from. */
  firstFrame: z.boolean(),
  /** An image to end on; it needs a first frame. */
  lastFrame: z.boolean(),
  /** Makes video only from an image: a call without a first frame can't be run. */
  firstFrameRequired: z.boolean().optional(),
  /** `always`: the sound can't be turned off, `optional`: it can, `none`: silent. */
  audio: z.enum(['none', 'optional', 'always']),
});
export type VideoCapabilities = z.infer<typeof VideoCapabilities>;

/** What a sound model makes: someone speaking, a piece of music, or a sound effect. */
export const AudioKind = z.enum(['speech', 'music', 'sound']);
export type AudioKind = z.infer<typeof AudioKind>;

/** One voice a speech model speaks in, as its service lists it. */
export const AudioVoice = z.object({
  /** What the request names: a voice id or a voice name, as the service takes it. */
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  /** What it sounds like, in the service's words ("warm, middle-aged, British"), so the text model can choose. */
  description: z.string().max(300).optional(),
  /** Languages it speaks, as codes or names. */
  languages: z.array(z.string().max(40)).max(100).optional(),
});
export type AudioVoice = z.infer<typeof AudioVoice>;

/** What a sound model takes, beside what every model takes (`ImageCapabilities`, where sizes and counts mean nothing for sound). */
export const AudioCapabilities = z.object({
  kinds: z.array(AudioKind).min(1),
  /** Speech: the voices it has. Absent when the service has one voice, or takes any name it knows. */
  voices: z.array(AudioVoice).max(2000).optional(),
  /** The voice used when the call names none. A person can change it per model. */
  defaultVoice: z.string().max(200).optional(),
  /** Speech: takes words about how to say it (tone, pace, accent, feeling). */
  direction: z.boolean().optional(),
  /** Speech: voices one request can have, for a conversation between speakers. */
  maxSpeakers: z.number().int().min(1).max(10).optional(),
  /** Speech: the most text one request takes, in characters. */
  maxChars: z.number().int().positive().optional(),
  /** Speech: takes a speaking rate. */
  speed: z.boolean().optional(),
  /** Music and sound: the lengths it makes. Absent where the model decides, or where it speaks for as long as the text is. */
  durations: VideoDurations.optional(),
  /** The length used when the call names none. A person can change it per model. */
  defaultSeconds: z.number().positive().optional(),
  /** Music: sings words it's given. */
  lyrics: z.boolean().optional(),
  /** Music: `none` makes only instrumentals, `optional` can sing or not, `always` always sings. */
  vocals: z.enum(['none', 'optional', 'always']).optional(),
  /** Languages it speaks or sings, as codes or names; absent when the service doesn't say. */
  languages: z.array(z.string().max(40)).max(200).optional(),
});
export type AudioCapabilities = z.infer<typeof AudioCapabilities>;

export const ImageCapabilities = z.object({
  /** What the model makes. Absent means an image, so everything saved before video and sound stays valid. */
  output: z.enum(['image', 'video', 'audio']).optional(),
  /** Set when `output` is `video`. */
  video: VideoCapabilities.optional(),
  /** Set when `output` is `audio`. */
  audio: AudioCapabilities.optional(),
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
    /** For a workflow that makes video: how many frames, how many a second, and the picture to end on. */
    frames: ImageWorkflowInput.optional(),
    fps: ImageWorkflowInput.optional(),
    endImage: ImageWorkflowInput.optional(),
    /** For a workflow that makes sound: its length in seconds, and the words to sing. */
    seconds: ImageWorkflowInput.optional(),
    lyrics: ImageWorkflowInput.optional(),
    /** The node whose images are the result. */
    output: z.string().max(40).optional(),
  }),
  capabilities: ImageCapabilities.partial().optional(),
});
export type ImageWorkflow = z.infer<typeof ImageWorkflow>;

/** A workflow saved on the server, listed so a person can pick one instead of exporting a file. */
export const SavedImageWorkflow = z.object({ path: z.string(), size: z.number().optional(), modified: z.number().optional() });
export type SavedImageWorkflow = z.infer<typeof SavedImageWorkflow>;

/** A workflow to read into a mapped one. Saved ones and page-format ones need `providerId`, to ask that server. */
export const ImageWorkflowSource = z.object({
  text: z.string().max(512 * 1024).optional(),
  pngBase64: z.string().max(32 * 1024 * 1024).optional(),
  saved: z.string().max(500).optional(),
  providerId: z.string().optional(),
});
export type ImageWorkflowSource = z.infer<typeof ImageWorkflowSource>;

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
    /** For a video model: the length, frame rate and resolution used when a call names none. */
    video: z.object({ seconds: z.number().positive().max(600), fps: z.number().int().positive().max(240), resolution: z.string().max(20) }).partial(),
    /** For a sound model: the voice and the length used when a call names none. */
    audio: z.object({ voice: z.string().max(200), seconds: z.number().positive().max(3600) }).partial(),
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
  /** A video or a sound: dollars per second made, flat or (video) by resolution name. */
  perSecond: z.number().nonnegative().optional(),
  bySecond: z.record(z.string(), z.number().nonnegative()).optional(),
  /** Speech: dollars per million characters read out. */
  perMillionChars: z.number().nonnegative().optional(),
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
  /** `video` for a clip: `mime` is then its container, and `width` and `height` its frame. `audio` for a sound, whose size is 0. Absent means an image. */
  kind: z.enum(['image', 'video', 'audio']).optional(),
  /** A clip's or a sound's length in seconds, as the file says. */
  seconds: z.number().nonnegative().optional(),
  fps: z.number().positive().optional(),
  /** The clip has a sound track. */
  audio: z.boolean().optional(),
  /** A sound: speech, music or an effect. For speech, `prompt` is the words said. */
  audioKind: AudioKind.optional(),
  /** Speech: the voice's name, and how it was asked to speak. */
  voice: z.string().optional(),
  direction: z.string().optional(),
  /** Music: the words sung. */
  lyrics: z.string().optional(),
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
  /** `video` for a clip: its frame gets a play shape, and the line says seconds. `audio` for a sound, which has no frame. */
  kind: z.enum(['image', 'video', 'audio']).optional(),
  /** A sound: what kind, for the line that says what is being made. */
  audioKind: AudioKind.optional(),
  /** The length asked for, for the line under a clip's frame. */
  seconds: z.number().positive().optional(),
  /** The size it will be, so the frame has its shape from the start. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  count: z.number().int().positive().optional(),
  /** A small picture of the work so far. */
  preview: z.object({ mime: z.string(), data: z.string().max(400_000) }).optional(),
  /** The finished images: results only arrive when every call of a step has ended, and parallel calls end one by one. */
  images: z.array(GeneratedImageMeta).optional(),
});
export type ImageProgress = z.infer<typeof ImageProgress>;

/** A generated image in the person's library. */
export const GeneratedImage = GeneratedImageMeta.extend({
  sessionId: z.string().nullable(),
  sessionTitle: z.string().nullable(),
  /** Which page its conversation opens on. */
  sessionMode: z.enum(['chat', 'work', 'code']).nullable(),
  createdAt: z.number(),
});
export type GeneratedImage = z.infer<typeof GeneratedImage>;

export const IMAGE_ID_PREFIX = 'img_';
/** What the model calls an image: short enough to repeat, and only looked up among the images of its own session. */
export const imageId = (sha256: string): string => `${IMAGE_ID_PREFIX}${sha256.slice(0, 8)}`;
export const VIDEO_ID_PREFIX = 'vid_';
/** What the model calls a clip, as `imageId` does an image: `SaveVideo` takes it. */
export const videoId = (sha256: string): string => `${VIDEO_ID_PREFIX}${sha256.slice(0, 8)}`;
/** Whether a stored file is a clip, by its type. */
export const isVideoMime = (mime: string): boolean => mime === 'video/mp4' || mime === 'video/webm';
export const AUDIO_ID_PREFIX = 'aud_';
/** What the model calls a sound, as `imageId` does an image: `SaveAudio` takes it. */
export const audioId = (sha256: string): string => `${AUDIO_ID_PREFIX}${sha256.slice(0, 8)}`;
/** The sound files Atelier keeps and plays: the formats `checkAudio` lets in. */
export const AUDIO_MIMES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/aac', 'audio/webm'] as const;
export type AudioMime = (typeof AUDIO_MIMES)[number];
/** Whether a stored file is a sound, by its type. */
export const isAudioMime = (mime: string): mime is AudioMime => (AUDIO_MIMES as readonly string[]).includes(mime);

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
  { id: 'sd-server', label: 'stable-diffusion.cpp', type: 'a1111', group: 'local', baseUrl: 'http://127.0.0.1:1234', key: 'none', help: 'Use its sd-server program.' },
  { id: 'localai', label: 'LocalAI', type: 'openai-images', group: 'local', baseUrl: 'http://127.0.0.1:8080', key: 'optional' },
  { id: 'openai', label: 'OpenAI', type: 'openai-images', group: 'cloud', baseUrl: 'https://api.openai.com', key: 'required', keyUrl: 'https://platform.openai.com/api-keys', sharesKeyWith: 'openai' },
  { id: 'chatgpt', label: 'ChatGPT Plan', type: 'responses-image', group: 'cloud', baseUrl: 'https://chatgpt.com/backend-api/codex', key: 'none', help: 'Uses your ChatGPT Plan sign-in, and your plan’s limits.' },
  { id: 'gemini', label: 'Google Gemini', type: 'gemini', group: 'cloud', baseUrl: 'https://generativelanguage.googleapis.com', key: 'required', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'vertex', label: 'Google Vertex AI', type: 'gemini', group: 'cloud', baseUrl: 'https://aiplatform.googleapis.com', key: 'required', help: 'Express mode: use an API key from Google Cloud. Add each image model by name.', suggestedModels: ['gemini-2.5-flash-image'] },
  { id: 'bfl', label: 'Black Forest Labs', type: 'bfl', group: 'cloud', baseUrl: 'https://api.bfl.ai', key: 'required', keyUrl: 'https://dashboard.bfl.ai' },
  { id: 'stability', label: 'Stability AI', type: 'stability', group: 'cloud', baseUrl: 'https://api.stability.ai', key: 'required', keyUrl: 'https://platform.stability.ai/dashboard/api-keys' },
  { id: 'xai', label: 'xAI', type: 'openai-images', group: 'cloud', baseUrl: 'https://api.x.ai', key: 'required', keyUrl: 'https://console.x.ai' },
  { id: 'ideogram', label: 'Ideogram', type: 'ideogram', group: 'cloud', baseUrl: 'https://api.ideogram.ai', key: 'required', keyUrl: 'https://ideogram.ai/manage-api' },
  { id: 'recraft', label: 'Recraft', type: 'openai-images', group: 'cloud', baseUrl: 'https://external.api.recraft.ai', key: 'required', keyUrl: 'https://www.recraft.ai/profile/api' },
  { id: 'azure', label: 'Azure OpenAI', type: 'openai-images', group: 'cloud', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com', key: 'required', help: 'Add each image deployment by name as a model.' },
  { id: 'bedrock', label: 'Amazon Bedrock', type: 'bedrock', group: 'cloud', baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com', key: 'required', help: 'Paste a Bedrock API key, or an access key and secret as ACCESS_KEY:SECRET. Its Stability image models run in us-west-2.' },
  { id: 'openrouter', label: 'OpenRouter', type: 'chat-images', group: 'aggregator', baseUrl: 'https://openrouter.ai/api', key: 'required', keyUrl: 'https://openrouter.ai/keys', sharesKeyWith: 'openai-compatible' },
  { id: 'fal', label: 'fal.ai', type: 'fal', group: 'aggregator', baseUrl: 'https://queue.fal.run', key: 'required', keyUrl: 'https://fal.ai/dashboard/keys', suggestedModels: ['fal-ai/flux/schnell', 'fal-ai/flux-2-pro'] },
  { id: 'replicate', label: 'Replicate', type: 'replicate', group: 'aggregator', baseUrl: 'https://api.replicate.com', key: 'required', keyUrl: 'https://replicate.com/account/api-tokens', suggestedModels: ['black-forest-labs/flux-schnell', 'black-forest-labs/flux-1.1-pro'] },
  { id: 'together', label: 'Together AI', type: 'openai-images', group: 'aggregator', baseUrl: 'https://api.together.xyz', key: 'required', keyUrl: 'https://api.together.ai/settings/api-keys', suggestedModels: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.2-dev'] },
  { id: 'huggingface', label: 'Hugging Face', type: 'huggingface', group: 'aggregator', baseUrl: 'https://router.huggingface.co', key: 'required', keyUrl: 'https://huggingface.co/settings/tokens', suggestedModels: ['black-forest-labs/FLUX.1-dev'] },
  // Video: the same wire formats where a service has one, so these are presets with a model list of their own.
  { id: 'openrouter-video', label: 'OpenRouter video', type: 'openrouter-video', group: 'aggregator', baseUrl: 'https://openrouter.ai/api', key: 'required', keyUrl: 'https://openrouter.ai/keys', sharesKeyWith: 'openai-compatible', help: 'Veo, Kling, Wan, Seedance and others through one key. Its models are listed for you.' },
  { id: 'xai-video', label: 'xAI video', type: 'xai-video', group: 'cloud', baseUrl: 'https://api.x.ai', key: 'required', keyUrl: 'https://console.x.ai' },
  { id: 'fal-video', label: 'fal.ai video', type: 'fal', group: 'aggregator', baseUrl: 'https://queue.fal.run', key: 'required', keyUrl: 'https://fal.ai/dashboard/keys', help: 'Lists fal’s text-to-video and image-to-video models; type in any other video endpoint by its id.', suggestedModels: ['kling/v4/text-to-video', 'alibaba/wan-3.0/text-to-video'] },
  { id: 'replicate-video', label: 'Replicate video', type: 'replicate', group: 'aggregator', baseUrl: 'https://api.replicate.com', key: 'required', keyUrl: 'https://replicate.com/account/api-tokens', help: 'Type in a video model as owner/name.', suggestedModels: ['google/veo-3.1', 'alibaba/wan-3'] },
  { id: 'bfl-video', label: 'Black Forest Labs video', type: 'bfl', group: 'cloud', baseUrl: 'https://api.bfl.ai', key: 'required', keyUrl: 'https://dashboard.bfl.ai', suggestedModels: ['flux-3-video'] },
  { id: 'gemini-video', label: 'Google Gemini video', type: 'gemini', group: 'cloud', baseUrl: 'https://generativelanguage.googleapis.com', key: 'required', keyUrl: 'https://aistudio.google.com/apikey', help: 'Gemini Omni makes the video in one request, so it can take a few minutes and has no length setting.', suggestedModels: ['gemini-omni-1.1-flash'] },
  { id: 'openai-compatible', label: 'OpenAI-compatible images', type: 'openai-images', group: 'custom', baseUrl: 'http://127.0.0.1:8000', key: 'optional', help: 'Any server with /v1/images/generations, such as LiteLLM.' },
  // Sound: speech, music and sound effects. Most speech servers copy OpenAI's /v1/audio/speech, so they are presets of it.
  { id: 'kokoro', label: 'Kokoro-FastAPI', type: 'openai-speech', group: 'local', baseUrl: 'http://127.0.0.1:8880', key: 'none', help: 'Its voices are listed for you, and voices can be mixed, like af_bella+af_sky.' },
  { id: 'speaches', label: 'Speaches', type: 'openai-speech', group: 'local', baseUrl: 'http://127.0.0.1:8000', key: 'optional', help: 'Speaks with the Kokoro and Piper models it has downloaded.' },
  { id: 'localai-speech', label: 'LocalAI audio', type: 'openai-speech', group: 'local', baseUrl: 'http://127.0.0.1:8080', key: 'optional', help: 'Speech, and music and sound effects from models such as ACE-Step, MusicGen or Stable Audio.' },
  { id: 'koboldcpp-speech', label: 'KoboldCpp speech', type: 'openai-speech', group: 'local', baseUrl: 'http://127.0.0.1:5001', key: 'none', help: 'Start it with a speech model loaded (--ttsmodel).' },
  { id: 'chatterbox', label: 'Chatterbox TTS Server', type: 'openai-speech', group: 'local', baseUrl: 'http://127.0.0.1:8004', key: 'none', help: 'Its predefined voices and the reference voices you added are listed.' },
  { id: 'ollama-speech', label: 'Ollama speech', type: 'openai-speech', group: 'local', baseUrl: 'http://127.0.0.1:11434', key: 'none', help: 'Pull a speech model first, such as phonon.' },
  { id: 'vllm-omni', label: 'vLLM-Omni', type: 'openai-speech', group: 'local', baseUrl: 'http://127.0.0.1:8091', key: 'optional', help: 'Serves Qwen3-TTS, CosyVoice, Fish and others in OpenAI’s speech format.' },
  { id: 'fish-speech', label: 'Fish Speech', type: 'fish-audio', group: 'local', baseUrl: 'http://127.0.0.1:8080', key: 'optional', help: 'Fish Speech’s own API server. A voice is the id of a reference you added to it.' },
  { id: 'acestep', label: 'ACE-Step 1.5', type: 'acestep', group: 'local', baseUrl: 'http://127.0.0.1:8001', key: 'optional', help: 'Songs with vocals and instrumentals. Start acestep-api.' },
  { id: 'openai-speech', label: 'OpenAI speech', type: 'openai-speech', group: 'cloud', baseUrl: 'https://api.openai.com', key: 'required', keyUrl: 'https://platform.openai.com/api-keys', sharesKeyWith: 'openai', help: 'GPT-4o mini TTS with directions, TTS-1 and TTS-1 HD. OpenAI retires them on 6 January 2027.' },
  { id: 'elevenlabs', label: 'ElevenLabs', type: 'elevenlabs', group: 'cloud', baseUrl: 'https://api.elevenlabs.io', key: 'required', keyUrl: 'https://elevenlabs.io/app/settings/api-keys', help: 'Speech in your account’s voices, music and sound effects. Music needs a paid plan.' },
  { id: 'gemini-audio', label: 'Google Gemini audio', type: 'gemini-audio', group: 'cloud', baseUrl: 'https://generativelanguage.googleapis.com', key: 'required', keyUrl: 'https://aistudio.google.com/apikey', help: 'Gemini’s speech models, with 30 voices and up to two speakers, and Lyria music.' },
  { id: 'xai-speech', label: 'xAI speech', type: 'xai-speech', group: 'cloud', baseUrl: 'https://api.x.ai', key: 'required', keyUrl: 'https://console.x.ai' },
  { id: 'stability-audio', label: 'Stability AI audio', type: 'stability', group: 'cloud', baseUrl: 'https://api.stability.ai', key: 'required', keyUrl: 'https://platform.stability.ai/dashboard/api-keys', help: 'Stable Audio: music and sound effects, without vocals.' },
  { id: 'azure-speech', label: 'Azure OpenAI speech', type: 'openai-speech', group: 'cloud', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com', key: 'required', help: 'Add each speech deployment by name as a model.' },
  { id: 'mistral-speech', label: 'Mistral Voxtral', type: 'openai-speech', group: 'cloud', baseUrl: 'https://api.mistral.ai', key: 'required', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'groq-speech', label: 'Groq speech', type: 'openai-speech', group: 'cloud', baseUrl: 'https://api.groq.com/openai', key: 'required', keyUrl: 'https://console.groq.com/keys', help: 'Orpheus. It reads up to 200 characters a call.' },
  { id: 'cartesia', label: 'Cartesia', type: 'cartesia', group: 'cloud', baseUrl: 'https://api.cartesia.ai', key: 'required', keyUrl: 'https://play.cartesia.ai/keys' },
  { id: 'deepgram', label: 'Deepgram Aura', type: 'deepgram', group: 'cloud', baseUrl: 'https://api.deepgram.com', key: 'required', keyUrl: 'https://console.deepgram.com' },
  { id: 'fish-audio', label: 'Fish Audio', type: 'fish-audio', group: 'cloud', baseUrl: 'https://api.fish.audio', key: 'required', keyUrl: 'https://fish.audio/app/api-keys', help: 'Your account’s voices are listed for you.' },
  { id: 'minimax-audio', label: 'MiniMax speech', type: 'minimax-audio', group: 'cloud', baseUrl: 'https://api.minimax.io', key: 'required', keyUrl: 'https://platform.minimax.io' },
  { id: 'openrouter-speech', label: 'OpenRouter speech', type: 'openai-speech', group: 'aggregator', baseUrl: 'https://openrouter.ai/api', key: 'required', keyUrl: 'https://openrouter.ai/keys', sharesKeyWith: 'openai-compatible', help: 'Speech models from OpenAI, Google, Mistral, Fish, xAI and others through one key. Its models are listed for you.' },
  { id: 'together-speech', label: 'Together AI speech', type: 'openai-speech', group: 'aggregator', baseUrl: 'https://api.together.xyz', key: 'required', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fal-audio', label: 'fal.ai audio', type: 'fal', group: 'aggregator', baseUrl: 'https://queue.fal.run', key: 'required', keyUrl: 'https://fal.ai/dashboard/keys', help: 'Lists fal’s speech, music and sound models; type in any other audio endpoint by its id.', suggestedModels: ['fal-ai/elevenlabs/tts/eleven-v4', 'fal-ai/stable-audio-25/text-to-audio'] },
  { id: 'replicate-audio', label: 'Replicate audio', type: 'replicate', group: 'aggregator', baseUrl: 'https://api.replicate.com', key: 'required', keyUrl: 'https://replicate.com/account/api-tokens', help: 'Type in a speech or music model as owner/name.', suggestedModels: ['minimax/speech-02-hd', 'meta/musicgen'] },
  { id: 'openai-compatible-speech', label: 'OpenAI-compatible speech', type: 'openai-speech', group: 'custom', baseUrl: 'http://127.0.0.1:8000', key: 'optional', help: 'Any server with /v1/audio/speech, such as LiteLLM.' },
];

export const imagePreset = (id: string | undefined): ImagePreset | undefined => IMAGE_PROVIDER_PRESETS.find((p) => p.id === id);

/** The dialects a server on someone's own computer speaks. Cloud services are the admin's to add. */
export const PersonalImageProviderType = ImageProviderType.extract(['comfyui', 'a1111', 'swarmui', 'invokeai', 'openai-images', 'openai-speech', 'fish-audio', 'acestep']);
export type PersonalImageProviderType = z.infer<typeof PersonalImageProviderType>;

const PersonalImageOptions = ImageProviderConfig.pick({ parallelRequests: true, freeAfterRun: true, models: true, workflows: true });

/**
 * A person's own image server on one of their computers, reached through the desktop app there (device services,
 * ARCHITECTURE §21). Only they see and use its models, and only while that computer is connected.
 */
export const PersonalImageProvider = PersonalImageOptions.extend({
  id: z.string(),
  type: PersonalImageProviderType,
  preset: z.string().optional(),
  name: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
  /** The computer it runs on, and that computer's name. */
  deviceId: z.string(),
  deviceName: z.string(),
  /** That computer is connected and lends it right now. */
  online: z.boolean(),
  /** An API key is stored for it (the person's own secret). */
  hasKey: z.boolean(),
  /** The last check, while it was online. */
  status: ProviderStatus.optional(),
  createdAt: z.number(),
});
export type PersonalImageProvider = z.infer<typeof PersonalImageProvider>;

/** How much workflow one graph may hold: any signed-in person can store these on the server. */
const MAX_PERSONAL_WORKFLOW = 256 * 1024;

/** A personal image server as entered: the key is passed raw and kept as the person's own secret. */
export const PersonalImageProviderDraft = PersonalImageOptions.extend({
  id: PersonalProviderId,
  type: PersonalImageProviderType,
  preset: z.string().max(40).optional(),
  name: z.string().trim().min(1).max(80),
  baseUrl: z.url().max(2048),
  apiKey: z.string().max(10_000).optional(),
  enabled: z.boolean().optional(),
  workflows: PersonalImageOptions.shape.workflows.refine((list) => !list?.some((w) => JSON.stringify(w.graph).length > MAX_PERSONAL_WORKFLOW), 'A workflow can be at most 256 KB.'),
});
export type PersonalImageProviderDraft = z.infer<typeof PersonalImageProviderDraft>;

/** One image provider's health; the same shape as a text provider's. */
export type ImageProviderStatus = ProviderStatus;

/** A local image server found on a default port. */
export const DetectedImageServer = z.object({ preset: z.string(), type: ImageProviderType, baseUrl: z.string(), label: z.string() });
export type DetectedImageServer = z.infer<typeof DetectedImageServer>;
