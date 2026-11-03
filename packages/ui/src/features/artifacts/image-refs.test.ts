import { imageId } from '@atelier/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageIndex, SessionImage } from '../images/session-images.tsx';
import { BLANK, MAX_IMAGE_CHARS, MAX_REFERENCED, MAX_TOTAL_CHARS, PLACEHOLDERS, inlineImages, loadDataUrl, loadImages, pendingImages, referencedImages } from './image-refs.ts';

/** Unique blobs per test: the loaded table is shared by the module, as it is in the app. */
let counter = 0;
const make = (): SessionImage => {
  const blob = `${(counter++).toString(16).padStart(8, '0')}${'ab'.repeat(28)}`;
  return { id: imageId(blob), blob, mime: 'image/png' };
};
const indexOf = (...images: SessionImage[]): ImageIndex => new Map(images.map((i) => [i.id, i]));

afterEach(() => vi.unstubAllGlobals());

describe('referencedImages', () => {
  it('finds each id once, in order, wherever the model put it', () => {
    const text = '<img src="atelier-image:img_00000001"> <div style="background:url(atelier-image:img_00000002)"></div> ![x](atelier-image:img_00000001) `atelier-image:img_ABCDEF12` atelier-image:img_123';
    expect(referencedImages(text)).toEqual(['img_00000001', 'img_00000002']);
  });

  it('doesn\'t take part of a longer word for an id', () => {
    expect(referencedImages('atelier-image:img_000000012')).toEqual([]);
    expect(referencedImages('src="atelier-image:img_00000001"')).toEqual(['img_00000001']);
  });
});

describe('inlineImages', () => {
  it('swaps a reference for the data URL of that image once it has loaded, and not before', async () => {
    const image = make();
    const html = `<img src="atelier-image:${image.id}" alt="">`;
    const before = inlineImages(html, indexOf(image));
    expect(before).toEqual({ content: `<img src="${BLANK}" alt="">`, pending: true });
    expect(pendingImages(html, indexOf(image))).toEqual([image]);
    await loadImages([image], async () => 'data:image/png;base64,AAAA');
    expect(inlineImages(html, indexOf(image))).toEqual({ content: '<img src="data:image/png;base64,AAAA" alt="">', pending: false });
    expect(pendingImages(html, indexOf(image))).toEqual([]);
  });

  it('never resolves an id that is not in this conversation: the table it is given is the only way in', async () => {
    const ours = make();
    const theirs = make();
    const load = vi.fn(async () => 'data:image/png;base64,SECRET');
    const html = `<img src="atelier-image:${theirs.id}">`;
    expect(pendingImages(html, indexOf(ours))).toEqual([]);
    expect(inlineImages(html, indexOf(ours))).toEqual({ content: `<img src="${PLACEHOLDERS.unknown}">`, pending: false });
    await loadImages(pendingImages(html, indexOf(ours)), load);
    expect(load).not.toHaveBeenCalled();
    expect(inlineImages(html, indexOf(ours)).content).not.toContain('SECRET');
  });

  it('leaves content that names no image exactly as it is', () => {
    const html = '<p>Hi</p><a href="https://example.com/atelier-image">x</a>';
    expect(inlineImages(html, indexOf())).toEqual({ content: html, pending: false });
  });

  it('shows a placeholder for an image that could not be loaded, and does not try again', async () => {
    const image = make();
    const load = vi.fn(async () => { throw new Error('gone'); });
    await loadImages([image], load);
    await loadImages([image], load);
    expect(load).toHaveBeenCalledOnce();
    expect(inlineImages(`atelier-image:${image.id}`, indexOf(image)).content).toBe(PLACEHOLDERS.unknown);
  });

  it('puts in one image every time it is named, and counts it once against the total', async () => {
    const image = make();
    await loadImages([image], async () => 'data:image/png;base64,AAAA');
    const out = inlineImages(`atelier-image:${image.id} atelier-image:${image.id}`, indexOf(image));
    expect(out.content).toBe('data:image/png;base64,AAAA data:image/png;base64,AAAA');
  });

  it('stops at the total it will put in a page, and at the twelfth image', async () => {
    const big = Array.from({ length: 5 }, make);
    // Each under the single-image cap, five of them over the total: the fifth no longer fits.
    const each = 1_900_000;
    expect(each * 5).toBeGreaterThan(MAX_TOTAL_CHARS);
    await loadImages(big, async () => `data:image/png;base64,${'A'.repeat(each)}`);
    const out = inlineImages(big.map((i) => `[atelier-image:${i.id}]`).join(''), indexOf(...big)).content;
    expect(out.split(PLACEHOLDERS.tooLarge)).toHaveLength(2);
    const many = Array.from({ length: MAX_REFERENCED + 1 }, make);
    await loadImages(many, async () => 'data:image/png;base64,AA');
    const text = inlineImages(many.map((i) => `[atelier-image:${i.id}]`).join(''), indexOf(...many)).content;
    expect(text.endsWith(`[${PLACEHOLDERS.tooLarge}]`)).toBe(true);
    expect(text.split(PLACEHOLDERS.tooLarge)).toHaveLength(2);
  });

  it('refuses a data URL over the single-image cap, whatever loaded it', async () => {
    const image = make();
    await loadImages([image], async () => `data:image/png;base64,${'A'.repeat(MAX_IMAGE_CHARS)}`);
    expect(inlineImages(`atelier-image:${image.id}`, indexOf(image)).content).toBe(PLACEHOLDERS.tooLarge);
  });
});

describe('loadDataUrl', () => {
  const respond = (blob: Blob, ok = true) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok, blob: async () => blob })));

  it('reads a small image as it is, from the app\'s own address only', async () => {
    const image = make();
    respond(new Blob(['png-bytes'], { type: 'image/png' }));
    const url = await loadDataUrl(image, (blob) => `https://app.test/api/blobs/${blob}`);
    expect(url).toBe(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);
    expect(fetch).toHaveBeenCalledWith(`https://app.test/api/blobs/${image.blob}`);
  });

  it('gives nothing for a blob the app doesn\'t have', async () => {
    respond(new Blob([]), false);
    expect(await loadDataUrl(make(), (blob) => blob)).toBeNull();
  });
});
