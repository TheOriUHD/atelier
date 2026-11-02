/** The image adapter contract (ARCHITECTURE §23): each dialect turns one normalised request into a stream of events. */
import type { ImageCapabilities, ImageModelInfo, ImageProviderType, ImageTuning, ImageWorkflow, MessageError } from '@atelier/protocol';
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
  signal: AbortSignal;
}

export type ImageStopReason = 'done' | 'aborted' | 'refused' | 'error';

export type ImageEvent =
  /** The server is loading something before it can start. */
  | { type: 'loading'; what?: string }
  | { type: 'progress'; step?: number; steps?: number; fraction?: number; etaMs?: number }
  /** A picture of the work so far, base64. */
  | { type: 'preview'; mime: string; data: string }
  /** One finished image: its bytes, or a URL on another host for `download.ts` to fetch. */
  | { type: 'image'; bytes?: Uint8Array; url?: string; mime?: string; seed?: number; revisedPrompt?: string }
  /** What the service said this cost or used. */
  | { type: 'usage'; costUsd?: number; input?: number; output?: number }
  | { type: 'finish'; reason: ImageStopReason; error?: MessageError };

export type ListedImageModel = Omit<ImageModelInfo, 'hidden' | 'favorite' | 'order'>;

export interface ImageAdapter {
  readonly type: ImageProviderType;
  listModels(signal?: AbortSignal): Promise<ListedImageModel[]>;
  health(signal?: AbortSignal): Promise<HealthResult>;
  generate(request: ImageRequest): AsyncIterable<ImageEvent>;
  /** Unloads the model from the GPU. */
  free?(signal?: AbortSignal): Promise<void>;
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
