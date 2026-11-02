import { describe, expect, it } from 'vitest';
import { pngOf } from './__fixtures__/harness.ts';
import { checkpointFamily, checkpointLabel, editSize, pickName } from './families.ts';

describe('checkpointFamily', () => {
  it.each([
    ['v1-5-pruned-emaonly.safetensors [6ce0161689]', 'sd15', 512],
    ['dreamshaper_8.safetensors', 'sd15', 512],
    // "hyper" alone is hyperrealism, and it isn't distilled.
    ['hyperRealism_v30.safetensors', 'sd15', 512],
    ['v2-1_768-ema-pruned.safetensors', 'sd2', 768],
    ['sd_xl_base_1.0.safetensors', 'sdxl', 1024],
    ['juggernautXL_v9.safetensors', 'sdxl', 1024],
    ['ponyDiffusionV6.safetensors', 'sdxl', 1024],
    ['illustriousXL_v01.safetensors', 'sdxl', 1024],
    ['hyperrealisticXL_v2.safetensors', 'sdxl', 1024],
    ['sdxl_lightning_8step.safetensors', 'sdxl-distilled', 1024],
    ['bigasp_dmd2_xl.safetensors', 'sdxl-distilled', 1024],
    ['Hyper-SDXL-8step.safetensors', 'sdxl-distilled', 1024],
    ['sdxl_turbo_1.0.safetensors', 'sdxl-distilled', 512],
    ['sd_turbo.safetensors', 'sd-turbo', 512],
    ['sd-turbo-Q8_0.gguf', 'sd-turbo', 512],
    ['sd_turbo-f16-q8_0', 'sd-turbo', 512],
    ['lcm_dreamshaper_v7.safetensors', 'sd15-distilled', 512],
    ['flux1-dev-fp8.safetensors', 'flux', 1024],
    ['flux1-schnell.safetensors', 'flux', 1024],
    ['flux2-dev.safetensors', 'flux2', 1024],
    ['FLUX.2-klein-4B.safetensors', 'flux2', 1024],
    ['z_image_turbo_bf16.safetensors', 'z-image', 1024],
    ['sd3.5_medium.safetensors', 'sd3', 1024],
    ['stable-diffusion-v3-medium x.safetensors', 'sd3', 1024],
    ['stable-diffusion-xl-v1-base y.safetensors', 'sdxl', 1024],
    ['stable-diffusion-v1 z.safetensors', 'sd15', 512],
  ])('reads %s as %s', (name, family, base) => {
    expect(checkpointFamily(name)).toMatchObject({ family, sizes: { base } });
  });

  it('gives each family what it was made for', () => {
    expect(checkpointFamily('sd15')).toMatchObject({ promptStyle: 'tags', negativePrompt: true, sizes: { multiple: 8 }, defaults: { steps: 25, guidance: 7 } });
    expect(checkpointFamily('sdxl')).toMatchObject({ promptStyle: 'tags', negativePrompt: true, defaults: { steps: 30, guidance: 6 } });
    expect(checkpointFamily('sdxl_dmd2')).toMatchObject({ promptStyle: 'tags', negativePrompt: false, defaults: { steps: 8, guidance: 1 } });
    expect(checkpointFamily('flux1-dev')).toMatchObject({ promptStyle: 'natural', negativePrompt: false, sizes: { multiple: 16 }, defaults: { steps: 20, guidance: 1 } });
    expect(checkpointFamily('flux1-schnell').defaults.steps).toBe(4);
    expect(checkpointFamily('z-image-turbo').defaults).toMatchObject({ steps: 8, guidance: 1 });
    expect(checkpointFamily('flux2-klein').defaults).toMatchObject({ steps: 4, guidance: 1 });
  });
});

describe('checkpointLabel', () => {
  it.each([
    ['dreamshaper_8.safetensors [879db523c3]', 'dreamshaper_8'],
    ['sdxl/juggernautXL_v9.safetensors [c9e3e68f89]', 'juggernautXL_v9'],
    ['C:\\models\\flux1-dev.sft', 'flux1-dev'],
    ['plain-name', 'plain-name'],
    ['sd_turbo.gguf', 'sd_turbo'],
  ])('shows %s as %s', (name, label) => {
    expect(checkpointLabel(name)).toBe(label);
  });
});

describe('pickName', () => {
  it('finds a name in the spelling the server uses', () => {
    expect(pickName(['karras', 'simple'], 'Karras')).toBe('karras');
    expect(pickName(['euler', 'euler_a'], 'Euler a')).toBe('euler_a');
    expect(pickName(['dpm++2m', 'dpm++2s_a'], 'DPM++ 2M')).toBe('dpm++2m');
  });

  it('has nothing for a missing name or list', () => {
    expect(pickName(['karras'], 'Beta')).toBeUndefined();
    expect(pickName(undefined, 'Karras')).toBeUndefined();
    expect(pickName(['karras'], undefined)).toBeUndefined();
  });
});

describe('editSize', () => {
  const sizes = { kind: 'free', min: 256, max: 2048, multiple: 8, base: 512 } as const;
  const capabilities = { sizes } as never;

  it('keeps the shape of the picture being edited, not the square a call without a ratio asked for', () => {
    const size = editSize({ references: [{ bytes: pngOf(1600, 900), mime: 'image/png', name: 'a.png' }], width: 512, height: 512, capabilities });
    expect(size).toEqual({ width: 680, height: 384 });
  });

  it('leaves a picture the size it is when the model can work at that, so an edit does not resize it', () => {
    expect(editSize({ references: [{ bytes: pngOf(384, 384), mime: 'image/png', name: 'a.png' }], width: 512, height: 512, capabilities })).toEqual({ width: 384, height: 384 });
    expect(editSize({ references: [{ bytes: pngOf(768, 512), mime: 'image/png', name: 'a.png' }], width: 512, height: 512, capabilities })).toEqual({ width: 768, height: 512 });
  });

  it('rounds a picture\'s own size to what the model takes', () => {
    expect(editSize({ references: [{ bytes: pngOf(641, 483), mime: 'image/png', name: 'a.png' }], width: 512, height: 512, capabilities })).toEqual({ width: 640, height: 480 });
  });

  it('brings a picture too small for the model up to its size, in its shape', () => {
    expect(editSize({ references: [{ bytes: pngOf(128, 128), mime: 'image/png', name: 'a.png' }], width: 512, height: 512, capabilities })).toEqual({ width: 512, height: 512 });
  });

  it('keeps the size asked for when the picture can\'t be read', () => {
    expect(editSize({ references: [{ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', name: 'a.png' }], width: 512, height: 768, capabilities })).toEqual({ width: 512, height: 768 });
  });

  it('keeps the size asked for on a model with fixed sizes', () => {
    const fixed = { sizes: { kind: 'fixed', list: [{ width: 1024, height: 1024 }] } } as never;
    expect(editSize({ references: [{ bytes: pngOf(1600, 900), mime: 'image/png', name: 'a.png' }], width: 1024, height: 1024, capabilities: fixed })).toEqual({ width: 1024, height: 1024 });
  });
});
