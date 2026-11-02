import { describe, expect, it } from 'vitest';
import { GEMINI_MODELS, lookUp } from '../catalog.ts';
import { fitParams } from '../params.ts';
import { deps, events, fakeFetch, finishOf, imagesOf, INPUT, instance, jsonResponse, KEY, PNG_B64, request, stopped } from './__fixtures__/images.ts';
import { createGemini } from './gemini.ts';

const GEMINI = 'https://generativelanguage.googleapis.com';
const MODEL = 'gemini-nano-banana-2.1';
const ROUTE = `POST /v1/models/${MODEL}:generateContent`;
const caps = lookUp(GEMINI_MODELS, MODEL);
const answer = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 }, thoughtSignature: 'abc' }] }, finishReason: 'STOP' }] };
const adapter = (fetch: Parameters<typeof deps>[0], baseUrl = GEMINI, models: string[] = []) => createGemini(instance('gemini', baseUrl, { models }), deps(fetch));
const generate = (over = {}) => request({ model: MODEL, capabilities: caps, aspectRatio: '16:9', sizeClass: '1K', ...over });

describe('Gemini', () => {
  it('asks for images only, with the size in imageConfig and the key in a header', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: () => jsonResponse(answer) });
    const out = await events(adapter(fetch).generate(generate()));
    expect(calls[0]?.url).toBe(`${GEMINI}/v1/models/${MODEL}:generateContent`);
    expect(calls[0]?.headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0]?.body).toEqual({ contents: [{ parts: [{ text: 'a red lighthouse' }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '1K' } } });
    expect(imagesOf(out)).toHaveLength(1);
    expect(finishOf(out).reason).toBe('done');
  });

  it('leaves imageSize out for a model with one size per ratio', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/models/gemini-2.5-flash-image:generateContent': () => jsonResponse(answer) });
    await events(adapter(fetch).generate(generate({ model: 'gemini-2.5-flash-image', sizeClass: undefined })));
    expect(calls[0]?.body).toMatchObject({ generationConfig: { imageConfig: { aspectRatio: '16:9' } } });
  });

  it('keeps medium at Google’s default 1K, and 512 only where it exists', () => {
    expect(fitParams(caps, { size: 'medium' }).sizeClass).toBe('1K');
    expect(fitParams(caps, { size: 'large' }).sizeClass).toBe('2K');
    const flash = lookUp(GEMINI_MODELS, 'gemini-3.1-flash-image');
    expect(['small', 'medium', 'large'].map((size) => fitParams(flash, { size: size as 'small' }).sizeClass)).toEqual(['512', '1K', '2K']);
  });

  it('sends input images after the prompt, as inline data', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: () => jsonResponse(answer) });
    await events(adapter(fetch).generate(generate({ references: [INPUT] })));
    expect(calls[0]?.body).toMatchObject({ contents: [{ parts: [{ text: 'a red lighthouse' }, { inline_data: { mime_type: 'image/png', data: PNG_B64 } }] }] });
  });

  it('skips the interim images thinking makes', async () => {
    const parts = [{ thought: true, inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }];
    const { fetch } = fakeFetch({ [ROUTE]: () => jsonResponse({ candidates: [{ content: { parts } }] }) });
    const images = imagesOf(await events(adapter(fetch).generate(generate())));
    expect(images).toHaveLength(1);
    expect(images[0]?.bytes?.length).toBeGreaterThan(10);
  });

  it('treats a blocked prompt as a refusal', async () => {
    const { fetch } = fakeFetch({ [ROUTE]: () => jsonResponse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }) });
    expect(finishOf(await events(adapter(fetch).generate(generate())))).toMatchObject({ reason: 'refused', error: { retryable: false } });
  });

  it.each(['IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'SAFETY', 'BLOCKLIST', 'SPII', 'IMAGE_RECITATION'])('treats finish reason %s as a refusal', async (finishReason) => {
    const { fetch } = fakeFetch({ [ROUTE]: () => jsonResponse({ candidates: [{ finishReason, content: { parts: [] } }] }) });
    expect(finishOf(await events(adapter(fetch).generate(generate()))).reason).toBe('refused');
  });

  it('lets a model that simply made nothing be tried again', async () => {
    const { fetch } = fakeFetch({ [ROUTE]: () => jsonResponse({ candidates: [{ finishReason: 'NO_IMAGE' }] }) });
    expect(finishOf(await events(adapter(fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { retryable: true } });
  });

  it('keeps 429 and 503 retryable', async () => {
    const limited = fakeFetch({ [ROUTE]: () => jsonResponse({ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }, 429) });
    expect(finishOf(await events(adapter(limited.fetch).generate(generate())))).toMatchObject({ error: { retryable: true } });
    const down = fakeFetch({ [ROUTE]: () => jsonResponse({ error: { code: 503, message: 'The model is overloaded.' } }, 503) });
    expect(finishOf(await events(adapter(down.fetch).generate(generate())))).toMatchObject({ error: { code: 'provider_busy', retryable: true } });
  });

  it('stops when told to, and reports what it cannot read', async () => {
    const { fetch } = fakeFetch({});
    expect(finishOf(await events(adapter(fetch).generate(generate({ signal: stopped() })))).reason).toBe('aborted');
    const broken = fakeFetch({ [ROUTE]: () => new Response('not json') });
    expect(finishOf(await events(adapter(broken.fetch).generate(generate()))).reason).toBe('error');
    const empty = fakeFetch({ [ROUTE]: () => jsonResponse({}) });
    expect(finishOf(await events(adapter(empty.fetch).generate(generate()))).reason).toBe('error');
  });

  it('lists only image models that generate, across pages', async () => {
    const first = { models: [{ name: 'models/gemini-nano-banana-2.1', displayName: 'Nano Banana 2.1', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next' };
    const second = { models: [{ name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4', supportedGenerationMethods: ['predict'] }, { name: 'models/gemini-3-pro-image', displayName: 'Gemini 3 Pro Image', supportedGenerationMethods: ['generateContent'] }] };
    const { fetch, calls } = fakeFetch({ 'GET /v1beta/models?pageSize=1000': () => jsonResponse(first), 'GET /v1beta/models?pageSize=1000&pageToken=next': () => jsonResponse(second) });
    const models = await adapter(fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['gemini-nano-banana-2.1', 'gemini-3-pro-image']);
    expect(models[0]).toMatchObject({ displayName: 'Nano Banana 2.1', capabilities: { edit: true, maxReferences: 14 } });
    expect(calls).toHaveLength(2);
  });
});

describe('Vertex AI, express mode', () => {
  const VERTEX = 'https://aiplatform.googleapis.com';
  it('uses the global publisher route and typed-in models', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/publishers/google/models/gemini-2.5-flash-image:generateContent': () => jsonResponse(answer) });
    const service = adapter(fetch, VERTEX, ['gemini-2.5-flash-image']);
    expect((await service.listModels()).map((m) => m.modelId)).toEqual(['gemini-2.5-flash-image']);
    expect((await service.health()).ok).toBe(true);
    await events(service.generate(generate({ model: 'gemini-2.5-flash-image' })));
    expect(calls[0]?.headers['x-goog-api-key']).toBe(KEY);
  });
});
