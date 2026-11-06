/** The dialects (ARCHITECTURE §23): one adapter per wire format, and presets for the services that share one. */
import type { ImageProviderType } from '@atelier/protocol';
import { createA1111 } from './dialects/a1111.ts';
import { createAceStep } from './dialects/acestep.ts';
import { createBedrock } from './dialects/bedrock.ts';
import { createBfl } from './dialects/bfl.ts';
import { createChatImages } from './dialects/chat-images.ts';
import { createComfyUi } from './dialects/comfyui/index.ts';
import { createElevenLabs } from './dialects/elevenlabs.ts';
import { createFal } from './dialects/fal.ts';
import { createGemini } from './dialects/gemini.ts';
import { createGeminiAudio } from './dialects/gemini-audio.ts';
import { createHuggingFace } from './dialects/huggingface.ts';
import { createIdeogram } from './dialects/ideogram.ts';
import { createInvokeAi } from './dialects/invokeai.ts';
import { createMistralImages } from './dialects/mistral-images.ts';
import { createOpenAiImages } from './dialects/openai-images.ts';
import { createOpenAiSpeech } from './dialects/openai-speech.ts';
import { createOpenRouterVideo } from './dialects/openrouter-video.ts';
import { createReplicate } from './dialects/replicate.ts';
import { createResponsesImage } from './dialects/responses-image.ts';
import { createCartesia, createDeepgram, createFishAudio, createMiniMaxAudio } from './dialects/speech-services.ts';
import { createStability } from './dialects/stability.ts';
import { createSwarmUi } from './dialects/swarmui.ts';
import { createXaiSpeech } from './dialects/xai-speech.ts';
import { createXaiVideo } from './dialects/xai-video.ts';
import { MAX_AUDIO_BYTES } from './audio.ts';
import { guardedImageFetch, MAX_RESPONSE_BYTES } from './fetch-guard.ts';
import { MAX_VIDEO_BYTES } from './video.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageInstance } from './types.ts';

const DIALECTS: Partial<Record<ImageProviderType, (instance: ImageInstance, deps: ImageAdapterDeps) => ImageAdapter>> = {
  'openai-images': createOpenAiImages,
  gemini: createGemini,
  'chat-images': createChatImages,
  'responses-image': createResponsesImage,
  bfl: createBfl,
  stability: createStability,
  fal: createFal,
  replicate: createReplicate,
  huggingface: createHuggingFace,
  ideogram: createIdeogram,
  bedrock: createBedrock,
  'mistral-images': createMistralImages,
  a1111: createA1111,
  swarmui: createSwarmUi,
  invokeai: createInvokeAi,
  comfyui: createComfyUi,
  'openrouter-video': createOpenRouterVideo,
  'xai-video': createXaiVideo,
  'openai-speech': createOpenAiSpeech,
  elevenlabs: createElevenLabs,
  'gemini-audio': createGeminiAudio,
  'xai-speech': createXaiSpeech,
  cartesia: createCartesia,
  deepgram: createDeepgram,
  'fish-audio': createFishAudio,
  'minimax-audio': createMiniMaxAudio,
  acestep: createAceStep,
};

/** The dialects that can return a clip, which may be far larger than any picture (the service checks the clip itself against `MAX_VIDEO_BYTES`). */
const VIDEO_DIALECTS = new Set<ImageProviderType>(['fal', 'replicate', 'bfl', 'gemini', 'swarmui', 'comfyui', 'openrouter-video', 'xai-video']);
/** A little over a clip or a long sound: a service's answer can be either wrapped in base64 and JSON. */
const VIDEO_RESPONSE_BYTES = Math.max(MAX_RESPONSE_BYTES, Math.ceil(MAX_VIDEO_BYTES * 1.4), Math.ceil(MAX_AUDIO_BYTES * 1.4));

/** The most one answer from this kind of service may be. */
export const responseLimit = (type: ImageProviderType): number => (VIDEO_DIALECTS.has(type) ? VIDEO_RESPONSE_BYTES : MAX_RESPONSE_BYTES);

export function createImageAdapter(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const create = DIALECTS[instance.type];
  if (!create) throw new Error(`${instance.name}: this kind of image provider isn't available yet.`);
  return create(instance, { ...deps, fetch: guardedImageFetch(deps.fetch, responseLimit(instance.type)) });
}
