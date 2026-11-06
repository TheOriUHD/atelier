import { describe, expect, it } from 'vitest';
import { IMAGE_PROVIDER_PRESETS } from '@atelier/protocol';
import { fitParams } from '../params.ts';
import { deps, events, fakeFetch, finishOf, imagesOf, instance, jsonResponse, KEY, PNG, request, stopped } from './__fixtures__/images.ts';
import { createMistralImages, MISTRAL_IMAGE_CAPABILITIES } from './mistral-images.ts';

const BASE = 'https://api.mistral.ai';
const START = 'POST /v1/conversations';
const FILE_A = '933c5b5a-1c47-4cdd-84f6-f32526bd161b';
const FILE_B = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const fileRoute = (id: string) => `GET /v1/files/${id}/content`;
const png = () => new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } });

const toolFile = (fileId: string) => ({ tool: 'image_generation', file_id: fileId, type: 'tool_file', file_name: 'image_generated_0', file_type: 'png' });
const execution = { name: 'image_generation', object: 'entry', type: 'tool.execution', id: 'tool_exec_1', arguments: '{}' };
const answer = (content: unknown, outputs: unknown[] = [execution]) => ({
  conversation_id: 'conv_1',
  outputs: [...outputs, { content, object: 'entry', type: 'message.output', id: 'msg_1', model: 'mistral-medium-latest', role: 'assistant' }],
  usage: { prompt_tokens: 129, total_tokens: 292, completion_tokens: 94, connector_tokens: 69, connectors: { image_generation: 1 } },
  object: 'conversation.response',
});
const OK = answer([{ type: 'text', text: 'Here is your image.\n\n' }, toolFile(FILE_A)]);

const adapter = (fetch: Parameters<typeof deps>[0]) => createMistralImages(instance('mistral-images', BASE), deps(fetch), { retryMs: 0 });
const generate = (over = {}) => request({ model: 'image_generation', capabilities: MISTRAL_IMAGE_CAPABILITIES, ...over });

describe('Mistral images', () => {
  it('asks a chat model to call its image tool once, forced and not stored, with the shape in the text', async () => {
    const { fetch, calls } = fakeFetch({ [START]: () => jsonResponse(OK), [fileRoute(FILE_A)]: png });
    const out = await events(adapter(fetch).generate(generate({ aspectRatio: '16:9' })));
    expect(calls[0]?.url).toBe(`${BASE}/v1/conversations`);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'mistral-medium-latest', tools: [{ type: 'image_generation' }], completion_args: { tool_choice: 'any' }, store: false, stream: false });
    expect(Object.keys(body).sort()).toEqual(['completion_args', 'inputs', 'instructions', 'model', 'store', 'stream', 'tools']);
    expect(body.inputs).toBe('a red lighthouse\n\nAspect ratio: 16:9 (landscape)');
    expect(body.instructions).toMatch(/exactly once/);
    expect(body.instructions).toMatch(/word for word/);
    expect(body.instructions).toMatch(/do not ask questions/);
    expect(imagesOf(out)).toEqual([{ type: 'image', bytes: PNG, mime: 'image/png' }]);
    expect(out).toContainEqual({ type: 'usage', input: 129, output: 94 });
    expect(finishOf(out).reason).toBe('done');
  });

  it('downloads each image from the Files API with the same key, and reads its bytes, not its file_type', async () => {
    const { fetch, calls } = fakeFetch({ [START]: () => jsonResponse(answer([{ ...toolFile(FILE_A), file_type: 'jpeg' }])), [fileRoute(FILE_A)]: png });
    const out = await events(adapter(fetch).generate(generate()));
    expect(calls[1]).toMatchObject({ url: `${BASE}/v1/files/${FILE_A}/content`, method: 'GET', headers: { authorization: `Bearer ${KEY}`, accept: 'application/octet-stream' } });
    expect(imagesOf(out)[0]?.mime).toBe('image/png');
  });

  it('keeps every image the tool made, across messages', async () => {
    const twice = answer([toolFile(FILE_A)], [execution, execution, { type: 'message.output', content: [toolFile(FILE_B)] }]);
    const { fetch, calls } = fakeFetch({ [START]: () => jsonResponse(twice), [fileRoute(FILE_A)]: png, [fileRoute(FILE_B)]: png });
    const out = await events(adapter(fetch).generate(generate()));
    expect(imagesOf(out)).toHaveLength(2);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/conversations', `/v1/files/${FILE_B}/content`, `/v1/files/${FILE_A}/content`]);
    expect(finishOf(out).reason).toBe('done');
  });

  it('sends a plain description without a shape line, and words each shape', async () => {
    const { fetch, calls } = fakeFetch({ [START]: () => jsonResponse(OK), [fileRoute(FILE_A)]: png });
    const service = adapter(fetch);
    await events(service.generate(generate()));
    expect((calls[0]?.body as { inputs: string }).inputs).toBe('a red lighthouse');
    await events(service.generate(generate({ aspectRatio: '9:16' })));
    await events(service.generate(generate({ aspectRatio: '1:1' })));
    expect(calls.filter((c) => c.method === 'POST').map((c) => (c.body as { inputs: string }).inputs.split('\n').at(-1))).toEqual(['a red lighthouse', 'Aspect ratio: 9:16 (portrait)', 'Aspect ratio: 1:1 (square)']);
  });

  it('declares only what the tool takes: a shape, one image, nothing else', () => {
    expect(MISTRAL_IMAGE_CAPABILITIES).toMatchObject({ maxCount: 1, negativePrompt: false, seed: false, edit: false, mask: false, maxReferences: 0, transparent: false, tunable: false, sizes: { kind: 'aspect', classes: [] } });
    const fit = fitParams(MISTRAL_IMAGE_CAPABILITIES, { aspectRatio: '1.85:1', count: 3, seed: 4, negativePrompt: 'fog', references: 1 });
    expect(fit).toMatchObject({ aspectRatio: '16:9', count: 1, references: 0 });
    expect(fit.width).toBeUndefined();
    expect(fit.notes.join(' ')).toMatch(/1 at a time/);
  });

  it('turns an answer in words into a refusal when it says no, and an error that quotes it otherwise', async () => {
    const declined = fakeFetch({ [START]: () => jsonResponse(answer("I'm sorry, but I can't create images of real people.", [])) });
    const no = finishOf(await events(adapter(declined.fetch).generate(generate())));
    expect(no).toMatchObject({ reason: 'refused', error: { code: 'provider_refused', retryable: false } });
    expect(no.error?.message).toContain("can't create images of real people");

    const filtered = fakeFetch({ [START]: () => jsonResponse(answer([{ type: 'text', text: 'The image was blocked by the content filter.' }])) });
    expect(finishOf(await events(adapter(filtered.fetch).generate(generate()))).reason).toBe('refused');

    const chatted = fakeFetch({ [START]: () => jsonResponse(answer([{ type: 'text', text: 'What colour should the lighthouse be?' }], [])) });
    const asked = finishOf(await events(adapter(chatted.fetch).generate(generate())));
    expect(asked).toMatchObject({ reason: 'error', error: { code: 'provider_error' } });
    expect(asked.error?.message).toContain('What colour should the lighthouse be?');
    expect(chatted.calls).toHaveLength(1);

    const silent = fakeFetch({ [START]: () => jsonResponse(answer([], [])) });
    expect(finishOf(await events(adapter(silent.fetch).generate(generate()))).error?.message).toContain('without calling the image tool');
  });

  it('sends the request again without the forced tool if Mistral turns that down', async () => {
    const rejected = { object: 'error', message: { detail: [{ type: 'literal_error', loc: ['body', 'completion_args', 'tool_choice'], msg: "Input should be 'auto' or 'none'", input: 'any' }] }, type: 'invalid_request_message_error', param: null, code: '3051' };
    const { fetch, calls } = fakeFetch({ [START]: (call) => ((call.body as Record<string, unknown>).completion_args ? jsonResponse(rejected, 422) : jsonResponse(OK)), [fileRoute(FILE_A)]: png });
    const out = await events(adapter(fetch).generate(generate()));
    expect(calls.filter((c) => c.method === 'POST').map((c) => 'completion_args' in (c.body as object))).toEqual([true, false]);
    expect(finishOf(out).reason).toBe('done');
  });

  it('reads the field list out of a 422, and other Mistral errors by status', async () => {
    const invalid = { object: 'error', message: { detail: [{ type: 'missing', loc: ['body', 'inputs'], msg: 'Field required', input: null }] }, type: 'invalid_request_message_error', param: null, code: null };
    const bad = fakeFetch({ [START]: () => jsonResponse(invalid, 422) });
    const finish = finishOf(await events(adapter(bad.fetch).generate(generate())));
    expect(finish).toMatchObject({ reason: 'error', error: { code: 'provider_error', retryable: false } });
    expect(finish.error?.message).toContain('body.inputs: Field required');
    expect(bad.calls).toHaveLength(1);

    const stringified = fakeFetch({ [START]: () => jsonResponse({ object: 'error', message: JSON.stringify({ detail: [{ loc: ['body', 'model'], msg: 'Invalid model' }] }), type: 'invalid_request_error' }, 400) });
    expect(finishOf(await events(adapter(stringified.fetch).generate(generate()))).error?.message).toContain('body.model: Invalid model');

    const unauthorized = fakeFetch({ [START]: () => jsonResponse({ object: 'error', message: 'Unauthorized', type: 'authentication_error', param: null, code: null }, 401) });
    expect(finishOf(await events(adapter(unauthorized.fetch).generate(generate())))).toMatchObject({ reason: 'error', error: { code: 'provider_auth', retryable: false, fix: 'settings/providers' } });

    const broke = fakeFetch({ [START]: () => jsonResponse({ object: 'error', message: 'Your credit balance is too low', type: 'invalid_request_error' }, 402) });
    expect(finishOf(await events(adapter(broke.fetch).generate(generate())))).toMatchObject({ error: { code: 'provider_quota', retryable: false } });

    const limited = fakeFetch({ [START]: () => jsonResponse({ object: 'error', message: 'Requests rate limit exceeded', type: 'rate_limit_error' }, 429) });
    expect(finishOf(await events(adapter(limited.fetch).generate(generate())))).toMatchObject({ error: { code: 'provider_busy', retryable: true } });

    const moderated = fakeFetch({ [START]: () => jsonResponse({ object: 'error', message: 'This request was blocked by moderation', type: 'invalid_request_error' }, 400) });
    expect(finishOf(await events(adapter(moderated.fetch).generate(generate()))).reason).toBe('refused');
  });

  it('rides out a moment of trouble downloading, then gives up without asking for another paid image', async () => {
    let tries = 0;
    const flaky = fakeFetch({ [START]: () => jsonResponse(OK), [fileRoute(FILE_A)]: () => (++tries < 3 ? new Response('busy', { status: 503 }) : png()) });
    expect(finishOf(await events(adapter(flaky.fetch).generate(generate()))).reason).toBe('done');

    const gone = fakeFetch({ [START]: () => jsonResponse(OK), [fileRoute(FILE_A)]: () => new Response('busy', { status: 503 }) });
    const finish = finishOf(await events(adapter(gone.fetch).generate(generate())));
    expect(finish).toMatchObject({ reason: 'error', error: { retryable: false } });
    expect(finish.error?.message).toContain('downloading it failed');
    expect(gone.calls).toHaveLength(4);
  });

  it('keeps the images it could get when another one fails, and refuses bytes that are no image', async () => {
    const some = fakeFetch({ [START]: () => jsonResponse(answer([toolFile(FILE_A), toolFile(FILE_B)])), [fileRoute(FILE_A)]: png, [fileRoute(FILE_B)]: () => jsonResponse({ object: 'error', message: 'File not found' }, 404) });
    const out = await events(adapter(some.fetch).generate(generate()));
    expect(imagesOf(out)).toHaveLength(1);
    expect(finishOf(out).reason).toBe('error');

    const garbage = fakeFetch({ [START]: () => jsonResponse(OK), [fileRoute(FILE_A)]: () => new Response('<html>not an image</html>') });
    const bad = await events(adapter(garbage.fetch).generate(generate()));
    expect(imagesOf(bad)).toHaveLength(0);
    expect(finishOf(bad).error?.message).toContain("isn't an image");
  });

  it('passes the request’s signal to every fetch, and stops when told to', async () => {
    const signals: (AbortSignal | null)[] = [];
    const { fetch } = fakeFetch({
      [START]: (_call, signal) => (signals.push(signal), jsonResponse(OK)),
      [fileRoute(FILE_A)]: (_call, signal) => (signals.push(signal), png()),
    });
    const controller = new AbortController();
    await events(adapter(fetch).generate(generate({ signal: controller.signal })));
    expect(signals).toEqual([controller.signal, controller.signal]);

    expect(finishOf(await events(adapter(fakeFetch({}).fetch).generate(generate({ signal: stopped() })))).reason).toBe('aborted');

    const midway = new AbortController();
    const late = fakeFetch({
      [START]: () => jsonResponse(OK),
      [fileRoute(FILE_A)]: () => {
        midway.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });
    expect(finishOf(await events(adapter(late.fetch).generate(generate({ signal: midway.signal })))).reason).toBe('aborted');
  });

  it('lists its one model, and checks the key by listing Mistral’s models', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /v1/models': () => jsonResponse({ object: 'list', data: [] }) });
    const service = adapter(fetch);
    const models = await service.listModels();
    expect(models.map((m) => [m.modelId, m.displayName])).toEqual([['image_generation', 'Mistral image generation (FLUX)']]);
    expect((await service.health()).ok).toBe(true);
    expect(calls[0]).toMatchObject({ url: `${BASE}/v1/models`, headers: { authorization: `Bearer ${KEY}` } });
    const refused = fakeFetch({ 'GET /v1/models': () => jsonResponse({ object: 'error', message: 'Unauthorized', type: 'authentication_error' }, 401) });
    expect((await adapter(refused.fetch).health()).ok).toBe(false);
  });

  it('takes a base URL with /v1 on it, as a Mistral text provider has', async () => {
    const { fetch, calls } = fakeFetch({ [START]: () => jsonResponse(OK), [fileRoute(FILE_A)]: png });
    await events(createMistralImages(instance('mistral-images', `${BASE}/v1`), deps(fetch), { retryMs: 0 }).generate(generate()));
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/conversations`, `${BASE}/v1/files/${FILE_A}/content`]);
  });

  it('is a cloud preset that can reuse a Mistral text provider’s key', () => {
    expect(IMAGE_PROVIDER_PRESETS.find((p) => p.id === 'mistral-images')).toMatchObject({ type: 'mistral-images', group: 'cloud', baseUrl: BASE, key: 'required', keyUrl: 'https://console.mistral.ai/api-keys', sharesKeyWith: 'mistral' });
  });
});
