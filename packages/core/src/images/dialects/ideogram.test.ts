import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { IDEOGRAM_MODELS, lookUp } from '../catalog.ts';
import { fitParams } from '../params.ts';
import { deps, events, fakeFetch, finishOf, formFields, formFile, imagesOf, INPUT, instance, jsonResponse, keepingBodies, KEY, MASK as INTERNAL_MASK, request, stopped } from './__fixtures__/images.ts';
import { createIdeogram } from './ideogram.ts';

const BASE = 'https://api.ideogram.ai';
const OK = { generation_kind: 'sampling', generation_id: 'g1', seed: 12345, data: [{ prompt: 'a red lighthouse', resolution: '1024x1024', is_image_safe: true, seed: 12345, url: 'https://ideogram.ai/api/images/ephemeral/a.png?exp=1' }] };
const caps = (model: string) => lookUp(IDEOGRAM_MODELS, model);
const MASK = INTERNAL_MASK;

function setup(route: string, answer: () => Response = () => jsonResponse(OK)) {
  const fake = fakeFetch({ [route]: answer });
  const { fetch, bodies } = keepingBodies(fake.fetch);
  return { service: createIdeogram(instance('ideogram', BASE), deps(fetch)), calls: fake.calls, bodies };
}

describe('Ideogram', () => {
  it('sends 4.5 multipart to the v2 route, with its key header, and keeps the link', async () => {
    const t = setup('POST /v2/image/generate/ideogram-4-5');
    const out = await events(t.service.generate(request({ model: 'ideogram-4-5', capabilities: caps('ideogram-4-5'), width: 1024, height: 1024, seed: 5, count: 2, quality: 'high', transparent: true })));
    expect(t.calls[0]?.headers['api-key']).toBe(KEY);
    expect(formFields(t.bodies[0]!)).toEqual({ prompt: 'a red lighthouse', seed: '5', num_images: '2', quality: 'high', size: '1024x1024', background: 'transparent' });
    expect(imagesOf(out)).toEqual([{ type: 'image', url: OK.data[0]!.url, seed: 12345 }]);
    expect(finishOf(out).reason).toBe('done');
  });

  it('edits with 4.5 through precise-edit', async () => {
    const t = setup('POST /v2/image/precise-edit/ideogram-4-5');
    await events(t.service.generate(request({ model: 'ideogram-4-5', capabilities: caps('ideogram-4-5'), references: [INPUT, { ...INPUT, name: 'guide.png' }], mask: MASK })));
    expect(formFields(t.bodies[0]!)).toMatchObject({ prompt: 'a red lighthouse', image: 'file:input.png', reference_images: 'file:guide.png', mask: 'file:mask.png' });
  });

  it('sends black where it changes, as Ideogram reads a mask: the opposite of the internal one', async () => {
    const t = setup('POST /v2/image/inpaint/ideogram-3');
    await events(t.service.generate(request({ model: 'ideogram-3', capabilities: caps('ideogram-3'), references: [INPUT], mask: MASK })));
    const sent = PNG.sync.read(Buffer.from(formFile(t.bodies[0]!, 'mask')));
    const red = (x: number, y: number) => sent.data[(y * sent.width + x) * 4];
    expect([red(0, 0), red(1, 0)]).toEqual([0, 255]);
  });

  it('generates with 4 from JSON, and picks its speed from the quality', async () => {
    const t = setup('POST /v2/image/generate/ideogram-4');
    await events(t.service.generate(request({ model: 'ideogram-4', capabilities: caps('ideogram-4'), width: 1280, height: 720, quality: 'draft' })));
    expect(t.calls[0]?.body).toEqual({ prompt: 'a red lighthouse', rendering_speed: 'turbo', resolution: '1280x720' });
  });

  it('remixes with 4, as a file', async () => {
    const t = setup('POST /v2/image/remix/ideogram-4');
    await events(t.service.generate(request({ model: 'ideogram-4', capabilities: caps('ideogram-4'), references: [INPUT], quality: 'high' })));
    expect(formFields(t.bodies[0]!)).toMatchObject({ prompt: 'a red lighthouse', image: 'file:input.png', rendering_speed: 'quality' });
  });

  it('routes 3 by what it’s given', async () => {
    const plain = setup('POST /v2/image/generate/ideogram-3');
    await events(plain.service.generate(request({ model: 'ideogram-3', capabilities: caps('ideogram-3'), aspectRatio: '16x9', negativePrompt: 'fog' })));
    expect(formFields(plain.bodies[0]!)).toEqual({ prompt: 'a red lighthouse', aspect_ratio: '16x9', negative_prompt: 'fog' });
    const remix = setup('POST /v2/image/remix/ideogram-3');
    await events(remix.service.generate(request({ model: 'ideogram-3', capabilities: caps('ideogram-3'), references: [INPUT] })));
    expect(formFields(remix.bodies[0]!)).toMatchObject({ image: 'file:input.png' });
    const inpaint = setup('POST /v2/image/inpaint/ideogram-3');
    await events(inpaint.service.generate(request({ model: 'ideogram-3', capabilities: caps('ideogram-3'), references: [INPUT], mask: MASK })));
    expect(formFields(inpaint.bodies[0]!)).toMatchObject({ image: 'file:input.png', mask: 'file:mask.png' });
  });

  it('only asks for sizes Ideogram lists, 1K first', () => {
    expect(fitParams(caps('ideogram-4'), { aspectRatio: '16:9' })).toMatchObject({ width: 1280, height: 720 });
    expect(fitParams(caps('ideogram-4'), { aspectRatio: '16:9', size: 'large' })).toMatchObject({ width: 2560, height: 1440 });
    expect(fitParams(caps('ideogram-3'), { aspectRatio: '16:9' }).aspectRatio).toBe('16x9');
  });

  it('keeps the prompt its magic prompt rewrote', async () => {
    const t = setup('POST /v2/image/generate/ideogram-4-5', () => jsonResponse({ data: [{ ...OK.data[0], prompt: 'A red lighthouse at sunrise, painted' }] }));
    expect(imagesOf(await events(t.service.generate(request({ model: 'ideogram-4-5' }))))[0]?.revisedPrompt).toBe('A red lighthouse at sunrise, painted');
  });

  it('treats any 422 as its safety check, even with an empty body', async () => {
    const t = setup('POST /v2/image/generate/ideogram-4-5', () => new Response('', { status: 422 }));
    expect(finishOf(await events(t.service.generate(request({ model: 'ideogram-4-5' }))))).toMatchObject({ reason: 'refused', error: { code: 'provider_refused' } });
  });

  it('treats images all marked unsafe as refused, and keeps the safe ones otherwise', async () => {
    const all = setup('POST /v2/image/generate/ideogram-4-5', () => jsonResponse({ data: [{ ...OK.data[0], is_image_safe: false, url: null }] }));
    expect(finishOf(await events(all.service.generate(request({ model: 'ideogram-4-5' })))).reason).toBe('refused');
    const some = setup('POST /v2/image/generate/ideogram-4-5', () => jsonResponse({ data: [{ ...OK.data[0], is_image_safe: false, url: null }, OK.data[0]] }));
    const out = await events(some.service.generate(request({ model: 'ideogram-4-5', count: 2 })));
    expect(imagesOf(out)).toHaveLength(1);
    expect(finishOf(out).reason).toBe('done');
  });

  it('keeps 429 and 503 retryable, and a 402 final', async () => {
    const limited = setup('POST /v2/image/generate/ideogram-4-5', () => jsonResponse({ error: 'Too many in flight', reject_reason: 'inflight_limit' }, 429));
    expect(finishOf(await events(limited.service.generate(request({ model: 'ideogram-4-5' }))))).toMatchObject({ error: { retryable: true } });
    const down = setup('POST /v2/image/generate/ideogram-4-5', () => new Response('', { status: 503 }));
    expect(finishOf(await events(down.service.generate(request({ model: 'ideogram-4-5' }))))).toMatchObject({ error: { retryable: true } });
    const broke = setup('POST /v2/image/generate/ideogram-4-5', () => jsonResponse({ error: 'Not enough funds', reject_reason: 'insufficient_funds' }, 402));
    expect(finishOf(await events(broke.service.generate(request({ model: 'ideogram-4-5' }))))).toMatchObject({ error: { code: 'provider_quota', retryable: false } });
  });

  it('stops when told to, and reports what it cannot read', async () => {
    const t = setup('POST /v2/image/generate/ideogram-4-5');
    expect(finishOf(await events(t.service.generate(request({ model: 'ideogram-4-5', signal: stopped() })))).reason).toBe('aborted');
    const empty = setup('POST /v2/image/generate/ideogram-4-5', () => jsonResponse({ data: [] }));
    expect(finishOf(await events(empty.service.generate(request({ model: 'ideogram-4-5' })))).reason).toBe('error');
    const garbled = setup('POST /v2/image/generate/ideogram-4-5', () => new Response('<html>'));
    expect(finishOf(await events(garbled.service.generate(request({ model: 'ideogram-4-5' })))).reason).toBe('error');
  });

  it('lists its catalog', async () => {
    const service = createIdeogram(instance('ideogram', BASE), deps(fakeFetch({}).fetch));
    expect((await service.listModels()).map((m) => m.modelId)).toEqual(['ideogram-4-5', 'ideogram-4', 'ideogram-3']);
    expect((await service.health()).ok).toBe(true);
  });
});
