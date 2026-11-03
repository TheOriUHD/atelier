import type { ImageCapabilities, VideoDurations } from '@atelier/protocol';
import { describe, expect, it } from 'vitest';
import { HOSTED_DEFAULTS } from './catalog.ts';
import { fitSeconds, fitVideo, NotAVideoModel, shortSide } from './video-params.ts';

const hosted = (video: Partial<NonNullable<ImageCapabilities['video']>> = {}, rest: Partial<ImageCapabilities> = {}): ImageCapabilities => ({
  ...HOSTED_DEFAULTS,
  family: 'test-video',
  output: 'video',
  sizes: { kind: 'aspect', ratios: ['16:9', '9:16', '1:1'], classes: ['480p', '720p', '1080p'] },
  seed: true,
  video: { durations: { kind: 'list', seconds: [4, 6, 8] }, defaultSeconds: 6, resolutions: ['480p', '720p', '1080p'], firstFrame: true, lastFrame: true, audio: 'optional', ...video },
  ...rest,
});

describe('fitSeconds', () => {
  it('takes the nearest length in a list, the shorter when two are as near', () => {
    const list: VideoDurations = { kind: 'list', seconds: [4, 6, 8] };
    expect(fitSeconds(list, 7)).toBe(6);
    expect(fitSeconds(list, 5)).toBe(4);
    expect(fitSeconds(list, 100)).toBe(8);
    expect(fitSeconds(list, 1)).toBe(4);
  });

  it('keeps a range and snaps to its step', () => {
    const range: VideoDurations = { kind: 'range', min: 5, max: 20, step: 5 };
    expect(fitSeconds(range, 12)).toBe(10);
    expect(fitSeconds(range, 13)).toBe(15);
    expect(fitSeconds(range, 60)).toBe(20);
    expect(fitSeconds({ kind: 'range', min: 1, max: 15 }, 7.123)).toBe(7.12);
  });
});

describe('fitVideo', () => {
  it('uses the model default length and the 720p default when the call says nothing', () => {
    const fit = fitVideo(hosted(), {});
    expect(fit).toMatchObject({ seconds: 6, resolution: '720p', sizeClass: '720p', aspectRatio: '16:9', audio: false, firstFrame: false, lastFrame: false });
  });

  it('lets a person’s defaults stand in for the model’s', () => {
    expect(fitVideo(hosted(), {}, { seconds: 8, resolution: '1080P' })).toMatchObject({ seconds: 8, resolution: '1080p' });
  });

  it('says when it changed the length, and when it could not match a resolution', () => {
    const fit = fitVideo(hosted(), { seconds: 5, resolution: '4k', aspectRatio: '16:9' });
    expect(fit).toMatchObject({ seconds: 4, resolution: '720p', aspectRatio: '16:9' });
    expect(fit.notes).toEqual(['This model makes 4, 6, 8 seconds, so the clip is 4 seconds.', 'This model has 480p, 720p, 1080p, so the clip is 720p.']);
  });

  it('turns a resolution name into pixels for a model with free sizes', () => {
    const caps = hosted({ resolutions: undefined }, { sizes: { kind: 'free', min: 256, max: 1920, multiple: 16, base: 640 } });
    expect(fitVideo(caps, { resolution: '720p', aspectRatio: '16:9' })).toMatchObject({ width: 1280, height: 720 });
    expect(fitVideo(caps, { resolution: '480p', aspectRatio: '9:16' })).toMatchObject({ width: 480, height: 848 });
    expect(fitVideo(caps, { resolution: '4320p', aspectRatio: '16:9' })).toMatchObject({ width: 1920, height: 1920 });
  });

  it('snaps the frame rate and says so', () => {
    const caps = hosted({ fps: [24, 25, 48], defaultFps: 24 });
    expect(fitVideo(caps, {}).fps).toBe(24);
    const fit = fitVideo(caps, { fps: 30 });
    expect(fit.fps).toBe(25);
    expect(fit.notes.join(' ')).toContain('24, 25, 48 frames per second');
    expect(fitVideo(hosted(), { fps: 30 }).notes).toContain("This model's frame rate is fixed, so the one asked for was left out.");
  });

  it('handles sound by what the model allows', () => {
    expect(fitVideo(hosted(), { audio: true }).audio).toBe(true);
    expect(fitVideo(hosted({ audio: 'none' }), { audio: true })).toMatchObject({ notes: ['This model makes silent video.'] });
    expect(fitVideo(hosted({ audio: 'none' }), { audio: true }).audio).toBeUndefined();
    expect(fitVideo(hosted({ audio: 'always' }), { audio: false }).notes).toEqual(["This model's sound can't be turned off."]);
  });

  it('keeps frames the model can use and drops the rest', () => {
    expect(fitVideo(hosted(), { firstFrame: true, lastFrame: true })).toMatchObject({ firstFrame: true, lastFrame: true });
    expect(fitVideo(hosted({ lastFrame: false }), { firstFrame: true, lastFrame: true })).toMatchObject({ firstFrame: true, lastFrame: false });
    expect(fitVideo(hosted({ firstFrame: false, lastFrame: false }), { firstFrame: true }).notes).toEqual(["This model can't start from an image, so the first frame was left out."]);
    expect(fitVideo(hosted(), { lastFrame: true }).notes).toEqual(['A last frame needs a first frame, so it was left out.']);
  });

  it('drops a negative prompt and seed the model cannot take', () => {
    const fit = fitVideo(hosted({}, { seed: false }), { seed: 4, negativePrompt: 'blur' });
    expect(fit.seed).toBeUndefined();
    expect(fit.negativePrompt).toBeUndefined();
    expect(fit.notes).toHaveLength(2);
  });

  it('refuses an image model', () => {
    expect(() => fitVideo(HOSTED_DEFAULTS, {})).toThrow(NotAVideoModel);
  });
});

describe('shortSide', () => {
  it('reads resolution names', () => {
    expect(shortSide('720p')).toBe(720);
    expect(shortSide(' 1080P ')).toBe(1080);
    expect(shortSide('2k')).toBe(2048);
    expect(shortSide('hd')).toBeNull();
  });
});
