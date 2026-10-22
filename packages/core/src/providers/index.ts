import { createChatGptChatAdapter } from './chatgpt-chat.ts';
import { createChatGptAdapter } from './chatgpt.ts';
import { createCopilotAdapter } from './copilot.ts';
import { createAnthropicAdapter } from './anthropic.ts';
import { createLlamaCppAdapter } from './llamacpp.ts';
import { createOllamaAdapter } from './ollama.ts';
import { createOpenAICompatibleAdapter } from './openai-compatible.ts';
import { createOpenAIAdapter } from './openai.ts';
import { withImageLimits } from './image-limits.ts';
import { BlobOverlay, IMAGE_POLICIES } from './images.ts';
import type { AdapterDeps, ProviderAdapter, ProviderInstance } from './types.ts';

function createBare(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  switch (instance.type) {
    case 'ollama':
      return createOllamaAdapter(instance, deps);
    case 'llamacpp':
      return createLlamaCppAdapter(instance, deps);
    case 'anthropic':
      return createAnthropicAdapter(instance, deps);
    case 'openai':
      return createOpenAIAdapter(instance, deps);
    case 'openai-compatible':
      return createOpenAICompatibleAdapter(instance, deps);
    case 'chatgpt-chat':
      return createChatGptChatAdapter(instance, deps);
    case 'chatgpt':
      return createChatGptAdapter(instance, deps);
    case 'copilot':
      return createCopilotAdapter(instance, deps);
  }
}

/** An adapter whose requests carry only the images its provider takes (providers/images.ts, image-limits.ts). */
export function createAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const overlay = new BlobOverlay(deps.readBlob);
  const inner = createBare(instance, { ...deps, readBlob: overlay.read });
  return withImageLimits(inner, overlay, IMAGE_POLICIES[instance.type], deps.readBlob);
}

export type * from './types.ts';
