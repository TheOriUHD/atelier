import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, instance, jsonResponse } from './__fixtures__/images.ts';
import { audioRequest, soundResponse } from './__fixtures__/audio.ts';
import { aceStepBody, createAceStep } from './acestep.ts';

const BASE = 'http://127.0.0.1:8001';
const adapter = (fetch: Parameters<typeof deps>[0]) => createAceStep({ ...instance('acestep', BASE), apiKey: undefined }, deps(fetch));

describe('ACE-Step 1.5', () => {
  it('asks for an instrumental with its tag, and lyrics as they are', () => {
    expect(aceStepBody(audioRequest({ prompt: 'funk, bass', audio: { kind: 'music', seconds: 61.6, instrumental: true }, seed: 5 }))).toMatchObject({ task_type: 'text2music', prompt: 'funk, bass', lyrics: '[instrumental]', audio_duration: 62, seed: 5, audio_format: 'mp3' });
    expect(aceStepBody(audioRequest({ audio: { kind: 'music', lyrics: '[verse]\nhey' } })).lyrics).toBe('[verse]\nhey');
  });

  it('submits, polls and reads the file from the server', async () => {
    let polls = 0;
    const { fetch, calls } = fakeFetch({
      'POST /release_task': () => jsonResponse({ data: { task_id: 't1' }, code: 200, error: null }),
      'POST /query_result': () => jsonResponse({ data: [{ task_id: 't1', status: ++polls < 2 ? 0 : 1, result: JSON.stringify([{ file: '/v1/audio?path=out%2Fa.mp3' }]) }], code: 200 }),
      'GET /v1/audio': () => soundResponse(),
    });
    const out = await events(adapter(fetch).generate(audioRequest({ model: 'ace-step-1.5', prompt: 'lofi', audio: { kind: 'music', seconds: 30 } })));
    expect(finishOf(out).reason).toBe('done');
    expect(calls.at(-1)!.url).toBe(`${BASE}/v1/audio?path=out%2Fa.mp3`);
  }, 10_000);

  it('reports a failed job', async () => {
    const { fetch } = fakeFetch({ 'POST /release_task': () => jsonResponse({ data: { task_id: 't' }, code: 200 }), 'POST /query_result': () => jsonResponse({ data: [{ task_id: 't', status: 2, error: 'out of memory' }], code: 200 }) });
    expect(finishOf(await events(adapter(fetch).generate(audioRequest({ audio: { kind: 'music' } }))))).toMatchObject({ reason: 'error', error: { message: expect.stringContaining('out of memory') } });
  }, 10_000);

  it('lists the models the server reports, as music with lyrics', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/models': () => jsonResponse({ data: { models: ['acestep-v15-turbo'] }, code: 200 }) });
    const models = await adapter(fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['acestep-v15-turbo']);
    expect(models[0]!.capabilities.audio).toMatchObject({ kinds: ['music'], lyrics: true, vocals: 'optional' });
  });
});
