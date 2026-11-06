import { describe, expect, it } from 'vitest';
import { imageId, type GeneratedImageMeta, type ImageProgress, type ToolResultPart } from '@atelier/protocol';
import { formatDuration, formatEta, imageFailure, imageFileName, imageFraction, imageLayout, imageStatus, missingNote, plannedCount, plannedShape, previewBlur, shownImages } from './image-view.ts';

const call = (input: unknown) => ({ input });
const progress = (p: Partial<ImageProgress>): ImageProgress => ({ phase: 'generating', ...p });
const status = (p: Partial<ImageProgress>, count = 1) => imageStatus(progress(p), { count, waiting: false });
const result = (extra: Partial<ToolResultPart>): ToolResultPart => ({ type: 'tool_result', callId: 'c', content: [], ...extra });
const meta: GeneratedImageMeta = { id: 'img_1', blob: 'abc123', mime: 'image/png', width: 832, height: 1216, prompt: 'A kite', ref: 'p/m', modelName: 'M' };

describe('imageStatus', () => {
  it('says exactly what is going on, in each phase', () => {
    expect(status({ phase: 'queued', ahead: 2 })).toBe('2 ahead of you');
    expect(status({ phase: 'queued', ahead: 0 })).toBe('Waiting for the image server');
    expect(status({ phase: 'queued' })).toBe('Waiting for the image server');
    expect(status({ phase: 'freeing' })).toBe('Freeing the GPU');
    expect(status({ phase: 'loading' })).toBe('Loading the model');
    expect(status({ phase: 'finishing' })).toBe('Saving the image');
    expect(status({ phase: 'finishing' }, 4)).toBe('Saving 4 images');
  });

  it('counts steps and time left while it generates, and never runs past the last step', () => {
    expect(status({ step: 12, steps: 28, etaMs: 20_000 })).toBe('Step 12 of 28 · about 20 s');
    expect(status({ step: 12, steps: 28 })).toBe('Step 12 of 28');
    expect(status({ step: 30, steps: 28 })).toBe('Step 28 of 28');
    expect(status({ fraction: 0.38, etaMs: 61_000 })).toBe('38% · about 60 s');
    expect(status({})).toBe('Making the image');
    expect(status({}, 3)).toBe('Making 3 images');
  });

  it('before the first word from the backend, tells waiting for the person from getting ready', () => {
    expect(imageStatus(undefined, { count: 1, waiting: false })).toBe('Getting ready');
    expect(imageStatus(undefined, { count: 1, waiting: true })).toBe('Waiting for your answer');
  });
});

describe('formatEta and formatDuration', () => {
  it('round where a second more or less says nothing', () => {
    expect(formatEta(3_400)).toBe('about 3 s');
    expect(formatEta(400)).toBe('about 1 s');
    expect(formatEta(23_000)).toBe('about 25 s');
    expect(formatEta(95_000)).toBe('about 2 min');
  });

  it('keep a tenth under ten seconds, and turn into minutes at sixty', () => {
    expect(formatDuration(3_240)).toBe('3.2 s');
    expect(formatDuration(14_400)).toBe('14 s');
    expect(formatDuration(72_000)).toBe('1 min 12 s');
    expect(formatDuration(120_000)).toBe('2 min');
  });
});

describe('imageFraction', () => {
  it('comes from the fraction or the steps, and only while generating or finishing', () => {
    expect(imageFraction(progress({ fraction: 0.4, step: 1, steps: 2 }))).toBe(0.4);
    expect(imageFraction(progress({ step: 7, steps: 28 }))).toBe(0.25);
    expect(imageFraction(progress({}))).toBeUndefined();
    expect(imageFraction(progress({ phase: 'queued', fraction: 0.4 }))).toBeUndefined();
    expect(imageFraction(progress({ phase: 'finishing' }))).toBe(1);
    expect(imageFraction(undefined)).toBeUndefined();
  });
});

describe('previewBlur', () => {
  it('clears as the steps advance, and is gone before the end', () => {
    expect(previewBlur(0)).toBe(14);
    expect(previewBlur(0.45)).toBe(7);
    expect(previewBlur(0.95)).toBe(0);
    expect(previewBlur(1)).toBe(0);
  });

  it('stays in the middle for a backend that doesn’t say how far it is', () => {
    expect(previewBlur(undefined)).toBe(6);
  });
});

describe('plannedShape and plannedCount', () => {
  it('prefer what the backend settled on, then what the call asked for, then a square', () => {
    expect(plannedShape(call({ aspect_ratio: '16:9' }), progress({ width: 1536, height: 1024 }))).toEqual({ width: 1536, height: 1024 });
    expect(plannedShape(call({ aspect_ratio: '16:9' }), undefined)).toEqual({ width: 16, height: 9 });
    expect(plannedShape(call({ aspect_ratio: ' 2 x 3 ' }), undefined)).toEqual({ width: 2, height: 3 });
    expect(plannedShape(call({ aspect_ratio: 'wide' }), undefined)).toEqual({ width: 1, height: 1 });
    expect(plannedShape(call({ aspect_ratio: '0:0' }), undefined)).toEqual({ width: 1, height: 1 });
    expect(plannedShape(call({}), undefined)).toEqual({ width: 1, height: 1 });
  });

  it('count what the backend will make, else what was asked for, at most four frames', () => {
    expect(plannedCount(call({ count: 4 }), progress({ count: 2 }))).toBe(2);
    expect(plannedCount(call({ count: 3 }), undefined)).toBe(3);
    expect(plannedCount(call({ count: 9 }), undefined)).toBe(4);
    expect(plannedCount(call({}), undefined)).toBe(1);
  });
});

describe('shownImages', () => {
  it('uses the facts stored with the result', () => {
    expect(shownImages(call({ prompt: 'x' }), result({ generated: [meta], content: [{ type: 'image', mime: 'image/png', blob: 'abc123' }] }))).toEqual([meta]);
  });

  it('falls back to the image parts when the result has no `generated`', () => {
    expect(shownImages(call({ prompt: 'A kite' }), result({ content: [{ type: 'text', text: 'Generated' }, { type: 'image', mime: 'image/webp', blob: 'def456' }] }))).toEqual([{ id: imageId('def456'), blob: 'def456', mime: 'image/webp', prompt: 'A kite' }]);
  });

  it('has what progress says is done while the calls beside it still run', () => {
    expect(shownImages(call({}), undefined, progress({ phase: 'finishing', images: [meta] }))).toEqual([meta]);
  });

  it('has none for an error or before there is a result', () => {
    expect(shownImages(call({}), result({ isError: true, content: [{ type: 'image', mime: 'image/png', blob: 'x' }] }))).toEqual([]);
    expect(shownImages(call({}), undefined)).toEqual([]);
  });
});

describe('imageFailure', () => {
  it('knows a stop, whichever way the run ended', () => {
    expect(imageFailure('GenerateImage failed: This operation was aborted')).toEqual({ kind: 'stopped', text: 'Stopped before it finished.' });
    expect(imageFailure('Stopped.').kind).toBe('stopped');
  });

  it('leaves out what was written for the model', () => {
    expect(imageFailure("OpenAI refused this: the content policy. That is final: tell the person, and don't reword the prompt to get past it.")).toEqual({ kind: 'refused', text: 'OpenAI refused this: the content policy.' });
    expect(imageFailure("That's the limit of 8 images in one turn. Stop here and tell the person; they can ask for more in their next message.")).toEqual({ kind: 'failed', text: "That's the limit of 8 images in one turn." });
    expect(imageFailure('This account has reached its limit of 5 images a day. Tell the person; an admin can change it.').text).toBe('This account has reached its limit of 5 images a day. An admin can change it.');
  });

  it('tells a setup problem an admin can fix from one that isn’t', () => {
    for (const text of ['No image model is available. An admin adds one in Settings › Media.', 'Cannot reach ComfyUI at 127.0.0.1:8188', 'OpenAI rejected the credentials (401)', 'ComfyUI is turned off.', 'ComfyUI has no model "x". Refresh it in Settings if it was just added.', 'Model not found: gpt-image']) expect(imageFailure(text).kind).toBe('setup');
    expect(imageFailure('Fake Images request failed (500): The server fell over.').kind).toBe('failed');
    expect(imageFailure("There's no image img_1 in this conversation.").kind).toBe('failed');
  });
});

describe('missingNote', () => {
  it('finds why the rest didn’t come back', () => {
    expect(missingNote(result({ content: [{ type: 'text', text: 'Generated 2 images.\nOnly these came back: The server fell over.' }] }))).toBe('The server fell over.');
    expect(missingNote(result({ content: [{ type: 'text', text: 'Generated an image.' }] }))).toBeNull();
    expect(missingNote(undefined)).toBeNull();
  });
});

describe('imageFileName', () => {
  it('comes from the prompt, kept short, and keeps a call’s images apart by hash', () => {
    expect(imageFileName({ prompt: 'A poster: for the Summer Party!', blob: 'abcdef123456', mime: 'image/png' })).toBe('a-poster-for-the-summer-party-abcdef.png');
    expect(imageFileName({ prompt: 'x'.repeat(90), blob: 'abcdef', mime: 'image/jpeg' })).toBe(`${'x'.repeat(40)}-abcdef.jpg`);
    expect(imageFileName({ prompt: '日本語', blob: 'abcdef', mime: 'image/webp' })).toBe('image-abcdef.webp');
  });
});

describe('imageLayout', () => {
  const shapes = (n: number, width: number, height: number) => Array.from({ length: n }, () => ({ width, height }));

  it('keeps images in the arrangement that shows each biggest', () => {
    expect(imageLayout(shapes(1, 1, 1))).toBe('one');
    expect(imageLayout(shapes(2, 1, 1))).toBe('row');
    expect(imageLayout(shapes(3, 1, 1))).toBe('hero-side');
    expect(imageLayout(shapes(3, 3, 2))).toBe('hero-top');
    expect(imageLayout(shapes(3, 2, 3))).toBe('hero-side');
    expect(imageLayout(shapes(4, 1, 1))).toBe('grid');
    expect(imageLayout(shapes(4, 3, 2))).toBe('grid');
    expect(imageLayout(shapes(4, 2, 3))).toBe('strip');
  });
});
