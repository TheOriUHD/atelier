/** The dialects (ARCHITECTURE §23): one adapter per wire format, and presets for the services that share one. */
import type { ImageProviderType } from '@atelier/protocol';
import { createA1111 } from './dialects/a1111.ts';
import { createBedrock } from './dialects/bedrock.ts';
import { createBfl } from './dialects/bfl.ts';
import { createChatImages } from './dialects/chat-images.ts';
import { createComfyUi } from './dialects/comfyui/index.ts';
import { createFal } from './dialects/fal.ts';
import { createGemini } from './dialects/gemini.ts';
import { createHuggingFace } from './dialects/huggingface.ts';
import { createIdeogram } from './dialects/ideogram.ts';
import { createInvokeAi } from './dialects/invokeai.ts';
import { createOpenAiImages } from './dialects/openai-images.ts';
import { createReplicate } from './dialects/replicate.ts';
import { createResponsesImage } from './dialects/responses-image.ts';
import { createStability } from './dialects/stability.ts';
import { createSwarmUi } from './dialects/swarmui.ts';
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
  a1111: createA1111,
  swarmui: createSwarmUi,
  invokeai: createInvokeAi,
  comfyui: createComfyUi,
};

export function createImageAdapter(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const create = DIALECTS[instance.type];
  if (!create) throw new Error(`${instance.name}: this kind of image provider isn't available yet.`);
  return create(instance, deps);
}
