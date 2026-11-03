import { describe, expect, it } from 'vitest';
import { IMAGE_PROVIDER_PRESETS } from '@atelier/protocol';
import { adapterDeps, imageInstance } from './__fixtures__/harness.ts';
import { createImageAdapter, responseLimit } from './index.ts';

describe('createImageAdapter', () => {
  it.each(['a1111', 'forge', 'sdnext', 'koboldcpp', 'drawthings', 'swarmui', 'invokeai', 'sd-server', 'localai'])('has an adapter for the %s preset', (id) => {
    const preset = IMAGE_PROVIDER_PRESETS.find((p) => p.id === id)!;
    const adapter = createImageAdapter(imageInstance(preset.type, preset.id, preset.baseUrl), adapterDeps({}).deps);
    expect(adapter.type).toBe(preset.type);
  });

  it('has an adapter for every video preset', () => {
    for (const id of ['openrouter-video', 'xai-video', 'fal-video', 'replicate-video', 'bfl-video', 'gemini-video']) {
      const preset = IMAGE_PROVIDER_PRESETS.find((p) => p.id === id)!;
      expect(createImageAdapter(imageInstance(preset.type, preset.id, preset.baseUrl), adapterDeps({}).deps).type).toBe(preset.type);
    }
  });

  it('lets a video service’s answer be as large as a clip, and a picture service’s stay at 256 MB', () => {
    expect(responseLimit('fal')).toBeGreaterThan(512 * 1024 * 1024);
    for (const type of ['comfyui', 'swarmui', 'openrouter-video', 'xai-video', 'gemini', 'bfl', 'replicate'] as const) expect(responseLimit(type)).toBeGreaterThan(512 * 1024 * 1024);
    for (const type of ['a1111', 'openai-images', 'stability', 'ideogram', 'chat-images'] as const) expect(responseLimit(type)).toBe(256 * 1024 * 1024);
  });
});
