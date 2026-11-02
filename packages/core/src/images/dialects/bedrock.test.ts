import { describe, expect, it } from 'vitest';
import { BEDROCK_MODELS, lookUp } from '../catalog.ts';
import { deps, events, fakeFetch, finishOf, imagesOf, INPUT, instance, jsonResponse, PNG_B64, request, stopped } from './__fixtures__/images.ts';
import { createBedrock, regionOf, signV4 } from './bedrock.ts';

const BASE = 'https://bedrock-runtime.us-west-2.amazonaws.com';
const CORE = 'stability.stable-image-core-v1:1';
const LARGE = 'stability.sd3-5-large-v1:0';
const ROUTE = 'POST /model/stability.stable-image-core-v1%3A1/invoke';
const OK = { seeds: [1234], finish_reasons: [null], images: [PNG_B64] };
const NOW = new Date('2026-11-02T12:00:00.000Z');
const API_KEY = 'ABSKQmVkcm9ja0FQSUtleS1leGFtcGxl';
const adapter = (fetch: Parameters<typeof deps>[0], apiKey = API_KEY, baseUrl = BASE) => createBedrock(instance('bedrock', baseUrl, { apiKey }), deps(fetch), { now: () => NOW });
const generate = (over = {}) => request({ model: CORE, capabilities: lookUp(BEDROCK_MODELS, CORE), aspectRatio: '16:9', ...over });

describe('Signature Version 4', () => {
  it('matches AWS’s published example', () => {
    const { authorization } = signV4({
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'iam',
      method: 'GET',
      path: '/',
      query: 'Action=ListUsers&Version=2010-05-08',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Host: 'iam.amazonaws.com' },
      body: '',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('signs a Bedrock path encoded twice, as non-S3 services require', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: () => jsonResponse(OK) });
    await events(adapter(fetch, 'AKIDEXAMPLE:wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY').generate(generate({ aspectRatio: undefined, prompt: 'a red lighthouse' })));
    const body = JSON.stringify({ prompt: 'a red lighthouse', output_format: 'png' });
    const { authorization } = signV4({ accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-west-2', service: 'bedrock', method: 'POST', path: '/model/stability.stable-image-core-v1%3A1/invoke', headers: { host: 'bedrock-runtime.us-west-2.amazonaws.com', 'content-type': 'application/json' }, body, now: NOW });
    expect(calls[0]?.headers.authorization).toBe(authorization);
    expect(calls[0]?.headers['x-amz-date']).toBe('20261102T120000Z');
    expect(calls[0]?.headers['x-amz-security-token']).toBeUndefined();
  });

  it('agrees with a signature worked out separately', () => {
    const { authorization } = signV4({ accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-west-2', service: 'bedrock', method: 'POST', path: '/model/stability.stable-image-core-v1%3A1/invoke', headers: { host: 'bedrock-runtime.us-west-2.amazonaws.com', 'content-type': 'application/json' }, body: '{"prompt":"a red lighthouse"}', now: NOW });
    expect(authorization).toContain('Signature=79442e13f0cc381517f153d4daeba54e18d71770f180a198c895b201c6d66248');
  });

  it('signs a session token as well, when the key has one', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: () => jsonResponse(OK) });
    await events(adapter(fetch, 'AKID:secret:session-token').generate(generate()));
    expect(calls[0]?.headers['x-amz-security-token']).toBe('session-token');
    expect(calls[0]?.headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token');
  });
});

describe('Amazon Bedrock', () => {
  it('uses a Bedrock API key as a bearer token, and reads images and seeds', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: () => jsonResponse(OK) });
    const out = await events(adapter(fetch).generate(generate({ negativePrompt: 'fog', seed: 9 })));
    expect(calls[0]?.url).toBe(`${BASE}/model/stability.stable-image-core-v1%3A1/invoke`);
    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'application/json' });
    expect(calls[0]?.body).toEqual({ prompt: 'a red lighthouse', output_format: 'png', negative_prompt: 'fog', seed: 9, aspect_ratio: '16:9' });
    expect(imagesOf(out)[0]?.seed).toBe(1234);
    expect(finishOf(out).reason).toBe('done');
  });

  it('sends SD 3.5 an input image with its mode, and no ratio', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /model/stability.sd3-5-large-v1%3A0/invoke': () => jsonResponse(OK) });
    await events(adapter(fetch).generate(generate({ model: LARGE, references: [INPUT] })));
    expect(calls[0]?.body).toEqual({ prompt: 'a red lighthouse', output_format: 'png', mode: 'image-to-image', image: PNG_B64, strength: 0.7 });
  });

  it('sends a mask to the inpaint service, whichever model was chosen', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /model/us.stability.stable-image-inpaint-v1%3A0/invoke': () => jsonResponse(OK) });
    await events(adapter(fetch).generate(generate({ model: LARGE, references: [INPUT], mask: INPUT })));
    expect(calls[0]?.body).toEqual({ prompt: 'a red lighthouse', output_format: 'png', image: PNG_B64, mask: PNG_B64 });
  });

  it('reads a filtered result as a refusal, and drops a filtered image', async () => {
    const blocked = fakeFetch({ [ROUTE]: () => jsonResponse({ seeds: [1], finish_reasons: ['Filter reason: prompt'], images: [] }) });
    expect(finishOf(await events(adapter(blocked.fetch).generate(generate())))).toMatchObject({ reason: 'refused', error: { retryable: false } });
    const output = fakeFetch({ [ROUTE]: () => jsonResponse({ seeds: [1], finish_reasons: ['Filter reason: output image'], images: [PNG_B64] }) });
    const out = await events(adapter(output.fetch).generate(generate()));
    expect(imagesOf(out)).toHaveLength(0);
    expect(finishOf(out).reason).toBe('refused');
  });

  it('reads a validation error about content as a refusal', async () => {
    const { fetch } = fakeFetch({ [ROUTE]: () => jsonResponse({ message: 'This request has been blocked by our content filters.' }, 400) });
    expect(finishOf(await events(adapter(fetch).generate(generate()))).reason).toBe('refused');
  });

  it('keeps throttling and server errors retryable, and lets an inference error be tried again', async () => {
    const limited = fakeFetch({ [ROUTE]: () => jsonResponse({ message: 'Too many requests, please wait before trying again.' }, 429) });
    expect(finishOf(await events(adapter(limited.fetch).generate(generate())))).toMatchObject({ error: { code: 'provider_busy', retryable: true } });
    const down = fakeFetch({ [ROUTE]: () => jsonResponse({ message: 'Service unavailable' }, 503) });
    expect(finishOf(await events(adapter(down.fetch).generate(generate())))).toMatchObject({ error: { retryable: true } });
    const inference = fakeFetch({ [ROUTE]: () => jsonResponse({ seeds: [1], finish_reasons: ['Inference error'], images: [] }) });
    expect(finishOf(await events(adapter(inference.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { retryable: true } });
  });

  it('says what’s wrong with a retired model and a missing permission', async () => {
    const gone = fakeFetch({ 'POST /model/amazon.nova-canvas-v1%3A0/invoke': () => jsonResponse({ message: 'This model version has reached the end of its life.' }, 404) });
    expect(finishOf(await events(adapter(gone.fetch).generate(generate({ model: 'amazon.nova-canvas-v1:0' }))))).toMatchObject({ reason: 'error', error: { code: 'model_not_found' } });
    const denied = fakeFetch({ [ROUTE]: () => jsonResponse({ message: 'You don’t have access to the model with the specified model ID.' }, 403) });
    expect(finishOf(await events(adapter(denied.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { code: 'provider_auth' } });
  });

  it('stops when told to, and reports what it cannot read', async () => {
    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(generate({ signal: stopped() })))).reason).toBe('aborted');
    const garbled = fakeFetch({ [ROUTE]: () => new Response('<html>') });
    expect(finishOf(await events(adapter(garbled.fetch).generate(generate()))).reason).toBe('error');
    const empty = fakeFetch({ [ROUTE]: () => jsonResponse({ images: [] }) });
    expect(finishOf(await events(adapter(empty.fetch).generate(generate()))).reason).toBe('error');
  });

  it('takes the region from the address, and says so when it can’t', async () => {
    expect(regionOf('https://bedrock-runtime.eu-central-1.amazonaws.com')).toBe('eu-central-1');
    expect(regionOf('https://bedrock-runtime-fips.us-east-1.amazonaws.com')).toBe('us-east-1');
    expect(regionOf('https://example.com')).toBeNull();
    const { fetch, calls } = fakeFetch({});
    const lost = adapter(fetch, API_KEY, 'https://example.com');
    expect(finishOf(await events(lost.generate(generate())))).toMatchObject({ reason: 'error', error: { message: expect.stringContaining('region') } });
    expect(calls).toHaveLength(0);
    expect((await lost.health()).ok).toBe(false);
  });

  it('lists Stability’s models and leaves out the ones past end of life', async () => {
    const service = adapter(fakeFetch({}).fetch);
    const ids = (await service.listModels()).map((m) => m.modelId);
    expect(ids).toEqual(['stability.stable-image-ultra-v1:1', CORE, LARGE]);
    expect(ids.some((id) => /nova|titan/.test(id))).toBe(false);
    expect((await service.health()).ok).toBe(true);
    expect((await createBedrock(instance('bedrock', BASE, { apiKey: undefined }), deps(fakeFetch({}).fetch)).health()).ok).toBe(false);
  });
});
