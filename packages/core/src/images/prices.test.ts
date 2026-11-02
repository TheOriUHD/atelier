import { describe, expect, it } from 'vitest';
import { imagePreset, IMAGE_PROVIDER_PRESETS } from '@atelier/protocol';
import { ImageProviderConfig } from '@atelier/protocol';
import { createImageAdapter } from './index.ts';
import { imageCost, listImagePrice } from './prices.ts';

describe('list prices', () => {
  it('has no price for models that are gone', () => {
    expect(listImagePrice('dall-e-3')).toBeNull();
    expect(listImagePrice('dall-e-2')).toBeNull();
    expect(listImagePrice('imagen-4.0-generate-001')).toBeNull();
  });

  it('tells GPT Image 2.5 from 2, which have the same token rates but a per-image table only for 2', () => {
    expect(listImagePrice('gpt-image-2.5-flare')).toEqual({ input: 5, output: 30 });
    expect(imageCost(listImagePrice('gpt-image-2.5-sunburst')!, 1024, 1024)).toBeNull();
    expect(imageCost(listImagePrice('gpt-image-2')!, 1024, 1024)).toBe(0.053);
    expect(listImagePrice('gpt-image-1.5')).toMatchObject({ output: 32 });
    expect(listImagePrice('gpt-image-1-mini')).toMatchObject({ input: 2, output: 8 });
  });

  it('prices Gemini by size name and leaves sizes Atelier doesn’t ask for out', () => {
    expect(imageCost(listImagePrice('gemini-nano-banana-2.1')!, undefined, undefined, '1K')).toBe(0.0336);
    expect(imageCost(listImagePrice('gemini-3.1-flash-image')!, undefined, undefined, '512')).toBe(0.045);
    expect(imageCost(listImagePrice('gemini-3.1-flash-lite-image')!, undefined, undefined, '1K')).toBe(0.0336);
    expect(imageCost(listImagePrice('gemini-3-pro-image')!, undefined, undefined, '2K')).toBe(0.134);
    expect(imageCost(listImagePrice('gemini-2.5-flash-image')!, undefined, undefined)).toBe(0.039);
  });

  it('prices the flat services per image', () => {
    expect(listImagePrice('grok-imagine-image-2.0')?.perImage).toBe(0.04);
    expect(listImagePrice('grok-imagine-image')?.perImage).toBe(0.02);
    expect(listImagePrice('grok-imagine-image-quality')?.perImage).toBe(0.05);
    expect(listImagePrice('recraftv4_1_flash')?.perImage).toBe(0.007);
    expect(listImagePrice('recraftv4_1')?.perImage).toBe(0.035);
    expect(listImagePrice('stable-image-ultra')?.perImage).toBe(0.08);
    expect(listImagePrice('sd3.5-large-turbo')?.perImage).toBe(0.04);
    expect(listImagePrice('sd3.5-large')?.perImage).toBe(0.065);
  });

  it('prices Together by the megapixel, where it gives a rate', () => {
    expect(imageCost(listImagePrice('black-forest-labs/FLUX.1.1-pro')!, 1024, 1024)).toBeCloseTo(0.042, 3);
  });

  it('never prices a plan’s images, or a service whose page shows none', () => {
    for (const id of ['chatgpt-plan-image', 'flux-2-pro', 'ideogram-4-5', 'fal-ai/flux/schnell', 'black-forest-labs/flux-schnell', 'stability.stable-image-core-v1:1']) expect(listImagePrice(id)).toBeNull();
  });
});

describe('presets', () => {
  it('have a dialect behind every cloud service', () => {
    for (const preset of IMAGE_PROVIDER_PRESETS.filter((p) => p.group !== 'local')) {
      const config = ImageProviderConfig.parse({ id: 'x', type: preset.type, name: preset.label, baseUrl: preset.baseUrl });
      expect(() => createImageAdapter({ ...config, models: [], workflows: [], headers: {} }, { fetch: () => Promise.reject(new Error('no')), socket: () => Promise.reject(new Error('no')) }), preset.id).not.toThrow();
    }
  });

  it('point Bedrock at the region its image models run in, and fal at a model that exists', () => {
    expect(imagePreset('bedrock')?.baseUrl).toContain('us-west-2');
    expect(imagePreset('fal')?.suggestedModels).toContain('fal-ai/flux-2-pro');
    expect(imagePreset('vertex')?.type).toBe('gemini');
  });
});
