/** The dialects (ARCHITECTURE §23): one adapter per wire format, and presets for the services that share one. */
import type { ImageProviderType } from '@atelier/protocol';
import { createOpenAiImages } from './dialects/openai-images.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageInstance } from './types.ts';

const DIALECTS: Partial<Record<ImageProviderType, (instance: ImageInstance, deps: ImageAdapterDeps) => ImageAdapter>> = {
  'openai-images': createOpenAiImages,
};

export function createImageAdapter(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const create = DIALECTS[instance.type];
  if (!create) throw new Error(`${instance.name}: this kind of image provider isn't available yet.`);
  return create(instance, deps);
}
