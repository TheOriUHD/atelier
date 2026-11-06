/** The image adapter contract (ARCHITECTURE §23): each dialect turns one normalised request into a stream of events. */
import type { AudioKind, ImageCapabilities, ImageModelInfo, ImageProviderType, ImageTuning, ImageWorkflow, MessageError, SavedImageWorkflow } from '@atelier/protocol';
import type { ChatGptPort, HealthResult, ProviderFetch } from '../providers/types.ts';

/** A configured image provider with its secrets resolved. */
export interface ImageInstance {
  id: string;
  type: ImageProviderType;
  /** The service it was added as (`IMAGE_PROVIDER_PRESETS`). */
  preset?: string;
  name: string;
  baseUrl: string;
  /** Resolved secret; never logged. */
  apiKey?: string;
  headers: Record<string, string>;
  /** Model ids typed in, for services with no list of models. */
  models: string[];
  workflows: ImageWorkflow[];
}

export interface ImageInput {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

export type ImageQuality = 'draft' | 'standard' | 'high';

/** A request `params.ts` has already fitted to the model: the adapter sends what's here and needs no second guessing. */
export interface ImageRequest {
  model: string;
  prompt: string;
  negativePrompt?: string;
  /** Set for models with free or fixed sizes. */
  width?: number;
  height?: number;
  /** Set for models that take ratios and size names. */
  aspectRatio?: string;
  sizeClass?: string;
  count: number;
  quality: ImageQuality;
  /** Input images, for edits and references. */
  references: ImageInput[];
  mask?: ImageInput;
  seed?: number;
  transparent?: boolean;
  tuning: ImageTuning;
  loras: { name: string; weight: number }[];
  capabilities: ImageCapabilities;
  /** Set when the model makes video; `count` is then 1 and the adapter reads what it needs from here. */
  video?: VideoRequest;
  /** Set when the model makes sound; `count` is then 1, and `prompt` is the words to say for speech, the description otherwise. */
  audio?: AudioRequest;
  signal: AbortSignal;
}

/** One speaker in a conversation: the name the text uses for their lines, and the voice they speak in. */
export interface AudioSpeaker {
  name: string;
  voice: string;
}

/** What a sound is asked to be, already fitted to the model by `audio-params.ts`: only values the model takes. */
export interface AudioRequest {
  kind: AudioKind;
  /** Speech: the voice's id as the service takes it. */
  voice?: string;
  /** Speech with several voices: who says which lines (`Name: line` in the text). */
  speakers?: AudioSpeaker[];
  /** Speech: how to say it. */
  direction?: string;
  /** Speech: speaking rate, 1 is normal. */
  speed?: number;
  language?: string;
  /** Music and sound: how long. */
  seconds?: number;
  /** Music: words to sing; `instrumental` asks for none. */
  lyrics?: string;
  instrumental?: boolean;
}

/** What a clip is asked to be, already fitted to the model by `video-params.ts`: only values the model takes. */
export interface VideoRequest {
  seconds: number;
  fps?: number;
  /** The resolution's name (`720p`) for models that take names; the frame size is `width` and `height` or `aspectRatio` on the request. */
  resolution?: string;
  /** Sound wanted. Set only for models that can switch it. */
  audio?: boolean;
  firstFrame?: ImageInput;
  lastFrame?: ImageInput;
}

export type ImageStopReason = 'done' | 'aborted' | 'refused' | 'error';

export type ImageEvent =
  /** The server took the job, and others are ahead of it there. */
  | { type: 'queued'; ahead: number }
  /** The server is loading something before it can start. */
  | { type: 'loading'; what?: string }
  | { type: 'progress'; step?: number; steps?: number; fraction?: number; etaMs?: number }
  /** A picture of the work so far, base64. */
  | { type: 'preview'; mime: string; data: string }
  /** One finished image: its bytes, or a URL on another host for `download.ts` to fetch. */
  | { type: 'image'; bytes?: Uint8Array; url?: string; mime?: string; seed?: number; revisedPrompt?: string }
  /** One finished clip: its bytes, or a URL on another host for `download.ts` to fetch. */
  | { type: 'video'; bytes?: Uint8Array; url?: string; mime?: string; seed?: number }
  /** One finished sound: its bytes, or a URL on another host for `download.ts` to fetch. Raw samples (`audio/L16;rate=…`) are wrapped as WAV. */
  | { type: 'audio'; bytes?: Uint8Array; url?: string; mime?: string; seed?: number }
  /** What the service said this cost or used. */
  | { type: 'usage'; costUsd?: number; input?: number; output?: number }
  | { type: 'finish'; reason: ImageStopReason; error?: MessageError };

export type ListedImageModel = Omit<ImageModelInfo, 'hidden' | 'favorite' | 'order'>;

/** A workflow to read: pasted, in a PNG, or by its path among those saved on the server. */
export interface ImageWorkflowSource {
  text?: string | undefined;
  pngBase64?: string | undefined;
  saved?: string | undefined;
}

export interface ImageAdapter {
  readonly type: ImageProviderType;
  listModels(signal?: AbortSignal): Promise<ListedImageModel[]>;
  health(signal?: AbortSignal): Promise<HealthResult>;
  generate(request: ImageRequest): AsyncIterable<ImageEvent>;
  /** Unloads the model from the GPU. */
  free?(signal?: AbortSignal): Promise<void>;
  /** Reads a workflow into a mapped one, for servers that run them. Throws what the person should read. */
  parseWorkflow?(source: ImageWorkflowSource, signal?: AbortSignal): Promise<ImageWorkflow>;
  /** The workflows saved on the server. */
  savedWorkflows?(signal?: AbortSignal): Promise<SavedImageWorkflow[]>;
}

/** A WebSocket as a stream of its messages. It ends when the socket closes, and throws if it fails. */
export interface ImageSocket extends AsyncIterable<string | Uint8Array> {
  send(text: string): void;
  close(): void;
}

export interface ImageAdapterDeps {
  fetch: ProviderFetch;
  socket(url: string, signal: AbortSignal): Promise<ImageSocket>;
  chatgpt?: ChatGptPort;
}

export type ImageAdapterFactory = (instance: ImageInstance, deps: ImageAdapterDeps) => ImageAdapter;
