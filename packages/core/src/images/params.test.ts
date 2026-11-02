import { describe, expect, it } from 'vitest';
import type { ImageCapabilities } from '@atelier/protocol';
import { HOSTED_DEFAULTS } from './catalog.ts';
import { closestRatio, fitParams, fixedSize, freeSize, parseRatio } from './params.ts';

const SDXL = { kind: 'free', min: 512, max: 2048, multiple: 8, base: 1024 } as const;
const LOCAL: ImageCapabilities = { ...HOSTED_DEFAULTS, family: 'sdxl', promptStyle: 'tags', negativePrompt: true, sizes: SDXL, maxCount: 4, seed: true, tunable: true, defaults: { steps: 30, guidance: 6, sampler: 'dpmpp_2m_sde' }, samplers: ['euler', 'dpmpp_2m_sde'], loras: ['detail'] };

describe('sizes', () => {
  it('reads ratios in the ways people write them', () => {
    expect(parseRatio('16:9')).toBeCloseTo(16 / 9);
    expect(parseRatio('2 / 3')).toBeCloseTo(2 / 3);
    expect(parseRatio('1024x1536')).toBeCloseTo(2 / 3);
    expect(parseRatio('wide')).toBeNull();
    expect(parseRatio('0:0')).toBeNull();
  });

  it('keeps a free model near its native area, in multiples it accepts', () => {
    expect(freeSize(SDXL, 1, 'medium')).toEqual({ width: 1024, height: 1024 });
    const wide = freeSize(SDXL, 16 / 9, 'medium');
    expect(wide.width % 8).toBe(0);
    expect(wide.height % 8).toBe(0);
    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 1);
    expect(wide.width * wide.height).toBeGreaterThan(0.9 * 1024 * 1024);
    expect(wide.width * wide.height).toBeLessThan(1.1 * 1024 * 1024);
  });

  it('stays inside the limits, keeping the shape as far as it can', () => {
    const tall = freeSize(SDXL, 1 / 8, 'large');
    expect(tall.height).toBeLessThanOrEqual(2048);
    expect(tall.width).toBeGreaterThanOrEqual(512);
    const small = freeSize({ ...SDXL, min: 1024 }, 1, 'small');
    expect(small).toEqual({ width: 1024, height: 1024 });
  });

  it('picks the listed size closest in shape', () => {
    const list = [{ width: 1024, height: 1024 }, { width: 1536, height: 1024 }, { width: 1024, height: 1536 }];
    expect(fixedSize(list, 16 / 9, 'medium')).toEqual({ width: 1536, height: 1024 });
    expect(fixedSize(list, 9 / 16, 'medium')).toEqual({ width: 1024, height: 1536 });
    expect(fixedSize(list, 1, 'large')).toEqual({ width: 1024, height: 1024 });
  });

  it('picks by size among listed sizes of one shape', () => {
    const list = [{ width: 256, height: 256 }, { width: 512, height: 512 }, { width: 1024, height: 1024 }];
    expect(fixedSize(list, 1, 'small').width).toBe(256);
    expect(fixedSize(list, 1, 'medium').width).toBe(512);
    expect(fixedSize(list, 1, 'large').width).toBe(1024);
  });

  it('picks the closest of the ratios a model names', () => {
    expect(closestRatio(['1:1', '3:2', '16:9'], 1.7)).toBe('16:9');
    expect(closestRatio(['1:1', '2:3', '3:2'], 0.6)).toBe('2:3');
  });
});

describe('fitParams', () => {
  it('turns an ask into pixels for a free model', () => {
    const fit = fitParams(LOCAL, { aspectRatio: '1:1', count: 2 });
    expect(fit).toMatchObject({ width: 1024, height: 1024, count: 2, quality: 'standard' });
    expect(fit.tuning).toEqual({ steps: 30, guidance: 6, sampler: 'dpmpp_2m_sde' });
  });

  it('gives aspect models a ratio and a size name instead', () => {
    const fit = fitParams({ ...HOSTED_DEFAULTS, sizes: { kind: 'aspect', ratios: ['1:1', '16:9'], classes: ['1K', '2K', '4K'] } }, { aspectRatio: '1.8:1', size: 'large' });
    expect(fit).toMatchObject({ aspectRatio: '16:9', sizeClass: '4K' });
    expect(fit.width).toBeUndefined();
  });

  it('lets the call win over the person, and the person over the model', () => {
    expect(fitParams(LOCAL, { tuning: { steps: 12 } }, { steps: 20, guidance: 3 }).tuning).toEqual({ steps: 12, guidance: 3, sampler: 'dpmpp_2m_sde' });
  });

  it('says what the model cannot do and leaves it out', () => {
    const fit = fitParams(HOSTED_DEFAULTS, { negativePrompt: 'blurry', seed: 4, transparent: true, count: 3, references: 2, mask: true, tuning: { steps: 9 } });
    expect(fit).toMatchObject({ count: 1, references: 0, mask: false, tuning: {} });
    expect(fit.negativePrompt).toBeUndefined();
    expect(fit.seed).toBeUndefined();
    expect(fit.transparent).toBeUndefined();
    expect(fit.notes).toHaveLength(7);
  });

  it('caps input images at what the model takes', () => {
    const fit = fitParams({ ...LOCAL, edit: true, maxReferences: 1 }, { references: 3 });
    expect(fit.references).toBe(1);
    expect(fit.notes[0]).toContain('1 input image');
  });

  it('falls back from a sampler the server lacks to the default', () => {
    const fit = fitParams(LOCAL, { tuning: { sampler: 'nonsense' } });
    expect(fit.tuning.sampler).toBe('dpmpp_2m_sde');
    expect(fit.notes.join()).toContain('nonsense');
  });

  it('keeps only LoRAs the server has, at weight 1 unless told', () => {
    const fit = fitParams(LOCAL, { loras: [{ name: 'detail' }, { name: 'gone', weight: 0.5 }] });
    expect(fit.loras).toEqual([{ name: 'detail', weight: 1 }]);
    expect(fit.notes.join()).toContain('gone');
  });

  it('treats a bad ratio as square and says so', () => {
    const fit = fitParams(LOCAL, { aspectRatio: 'cinematic' });
    expect(fit).toMatchObject({ width: 1024, height: 1024 });
    expect(fit.notes[0]).toContain('cinematic');
  });
});
