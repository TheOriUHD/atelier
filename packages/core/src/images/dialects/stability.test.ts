import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { lookUp, STABILITY_MODELS } from '../catalog.ts';
import { deps, events, fakeFetch, finishOf, formFields, formFile, imagesOf, INPUT, instance, jsonResponse, keepingBodies, KEY, MASK, PNG_B64, request, stopped } from './__fixtures__/images.ts';
import { createStability } from './stability.ts';

const BASE = 'https://api.stability.ai';
const OK = { image: PNG_B64, finish_reason: 'SUCCESS', seed: 343940597 };
const caps = lookUp(STABILITY_MODELS, 'sd3.5-large');
const adapter = (fetch: Parameters<typeof deps>[0]) => createStability(instance('stability', BASE), deps(fetch));

function setup(route: string, answer: () => Response = () => jsonResponse(OK)) {
  const fake = fakeFetch({ [route]: answer });
  const { fetch, bodies } = keepingBodies(fake.fetch);
  return { service: adapter(fetch), calls: fake.calls, bodies };
}

describe('Stability AI', () => {
  it('sends multipart to Ultra, asks for JSON and keeps the seed', async () => {
    const t = setup('POST /v2beta/stable-image/generate/ultra');
    const out = await events(t.service.generate(request({ model: 'stable-image-ultra', capabilities: caps, aspectRatio: '16:9', negativePrompt: 'fog', seed: 7 })));
    expect(t.calls[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, accept: 'application/json', 'content-type': expect.stringMatching(/^multipart\/form-data; boundary=/) });
    expect(formFields(t.bodies[0]!)).toEqual({ prompt: 'a red lighthouse', negative_prompt: 'fog', seed: '7', output_format: 'png', aspect_ratio: '16:9' });
    expect(imagesOf(out)[0]?.seed).toBe(343940597);
    expect(finishOf(out).reason).toBe('done');
  });

  it('routes Core and SD 3.5 to their own paths', async () => {
    const core = setup('POST /v2beta/stable-image/generate/core');
    await events(core.service.generate(request({ model: 'stable-image-core', capabilities: caps })));
    expect(formFields(core.bodies[0]!)).not.toHaveProperty('model');
    const sd3 = setup('POST /v2beta/stable-image/generate/sd3');
    await events(sd3.service.generate(request({ model: 'sd3.5-large-turbo', capabilities: caps, aspectRatio: '1:1' })));
    expect(formFields(sd3.bodies[0]!)).toMatchObject({ model: 'sd3.5-large-turbo', aspect_ratio: '1:1' });
  });

  it('sends SD 3.5 image to image without a ratio, which that mode refuses', async () => {
    const t = setup('POST /v2beta/stable-image/generate/sd3');
    await events(t.service.generate(request({ model: 'sd3.5-large', capabilities: caps, aspectRatio: '16:9', references: [INPUT] })));
    const fields = formFields(t.bodies[0]!);
    expect(fields).toMatchObject({ mode: 'image-to-image', strength: '0.7', image: 'file:input.png' });
    expect(fields).not.toHaveProperty('aspect_ratio');
  });

  it('sends a mask to the inpaint route', async () => {
    const t = setup('POST /v2beta/stable-image/edit/inpaint');
    await events(t.service.generate(request({ model: 'sd3.5-large', capabilities: caps, aspectRatio: '1:1', references: [INPUT], mask: MASK })));
    const fields = formFields(t.bodies[0]!);
    expect(fields).toMatchObject({ image: 'file:input.png', mask: 'file:mask.png', prompt: 'a red lighthouse' });
    expect(fields).not.toHaveProperty('aspect_ratio');
    expect(fields).not.toHaveProperty('strength');
    // White changes in Stability's own words, so the internal mask goes as it is.
    const sent = PNG.sync.read(Buffer.from(formFile(t.bodies[0]!, 'mask')));
    expect([sent.data[0], sent.data[4]]).toEqual([255, 0]);
  });

  it('counts a blurred result as a refusal and never keeps it', async () => {
    const t = setup('POST /v2beta/stable-image/generate/core', () => jsonResponse({ image: PNG_B64, finish_reason: 'CONTENT_FILTERED', seed: 1 }));
    const out = await events(t.service.generate(request({ model: 'stable-image-core', capabilities: caps })));
    expect(imagesOf(out)).toHaveLength(0);
    expect(finishOf(out)).toMatchObject({ reason: 'refused', error: { code: 'provider_refused' } });
  });

  it('turns its 403 into a refusal, with the reason it gave', async () => {
    const body = { id: 'ed14db44362126aab3cbd25cca51ffe3', name: 'content_moderation', errors: ['Your request was flagged by our content moderation system, as a result your request was denied and you were not charged.'] };
    const t = setup('POST /v2beta/stable-image/generate/core', () => jsonResponse(body, 403));
    const finish = finishOf(await events(t.service.generate(request({ model: 'stable-image-core', capabilities: caps }))));
    expect(finish).toMatchObject({ reason: 'refused', error: { retryable: false } });
    expect(finish.error?.message).toContain('flagged by our content moderation system');
  });

  it('reads a detected public figure as a refusal too', async () => {
    const body = { id: 'ff54', name: 'public_figure', errors: ['Our system detected the likeness of a public figure in your image.'] };
    const t = setup('POST /v2beta/stable-image/generate/core', () => jsonResponse(body, 422));
    expect(finishOf(await events(t.service.generate(request({ model: 'stable-image-core', capabilities: caps })))).reason).toBe('refused');
  });

  it('keeps 429 and 500 retryable, and leaves other 4xx as faults', async () => {
    const limited = setup('POST /v2beta/stable-image/generate/core', () => jsonResponse({ id: 'x', name: 'rate_limit_exceeded', errors: ['You have exceeded the rate limit.'] }, 429));
    expect(finishOf(await events(limited.service.generate(request({ model: 'stable-image-core' }))))).toMatchObject({ error: { retryable: true } });
    const down = setup('POST /v2beta/stable-image/generate/core', () => jsonResponse({ id: 'x', name: 'internal_error', errors: ['An unexpected server error occurred.'] }, 500));
    expect(finishOf(await events(down.service.generate(request({ model: 'stable-image-core' }))))).toMatchObject({ error: { retryable: true } });
    const bad = setup('POST /v2beta/stable-image/generate/core', () => jsonResponse({ id: 'x', name: 'bad_request', errors: ['prompt: is required'] }, 400));
    expect(finishOf(await events(bad.service.generate(request({ model: 'stable-image-core' }))))).toMatchObject({ reason: 'error' });
  });

  it('stops when told to, and reports what it cannot read', async () => {
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(request({ signal: stopped() })))).reason).toBe('aborted');
    const empty = setup('POST /v2beta/stable-image/generate/core', () => jsonResponse({ finish_reason: 'SUCCESS' }));
    expect(finishOf(await events(empty.service.generate(request({ model: 'stable-image-core' })))).reason).toBe('error');
    const broken = setup('POST /v2beta/stable-image/generate/core', () => new Response('<html>'));
    expect(finishOf(await events(broken.service.generate(request({ model: 'stable-image-core' })))).reason).toBe('error');
  });

  it('knows Core takes no input image, and checks the key at its account route', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /v1/user/account': () => jsonResponse({ id: 'me' }) });
    const service = adapter(fetch);
    const models = await service.listModels();
    expect(models.find((m) => m.modelId === 'stable-image-core')?.capabilities.edit).toBe(false);
    expect(models.find((m) => m.modelId === 'sd3.5-large')?.capabilities).toMatchObject({ edit: true, mask: true, negativePrompt: true });
    expect((await service.health()).ok).toBe(true);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});
