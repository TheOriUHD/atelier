import { describe, expect, it } from 'vitest';
import { deps, events, fakeFetch, finishOf, formFields, instance, jsonResponse, keepingBodies } from './__fixtures__/images.ts';
import { audioRequest, MP3, soundResponse } from './__fixtures__/audio.ts';
import { createStability } from './stability.ts';

const adapter = (fetch: Parameters<typeof deps>[0]) => createStability(instance('stability', 'https://api.stability.ai', { preset: 'stability-audio' }), deps(fetch));

describe('Stable Audio', () => {
  it('lists Stable Audio 3 and 2.5 as music and effects without vocals', async () => {
    const models = await adapter(fakeFetch({}).fetch).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['stable-audio-3', 'stable-audio-2.5']);
    expect(models[0]!.capabilities.audio).toMatchObject({ kinds: ['music', 'sound'], durations: { kind: 'range', min: 1, max: 380 }, vocals: 'none' });
  });

  it('answers 2.5 at once, and marks an effect with its track type', async () => {
    const { fetch } = fakeFetch({ 'POST /v2beta/audio/stable-audio-2/text-to-audio': () => soundResponse() });
    const kept = keepingBodies(fetch);
    const out = await events(adapter(kept.fetch).generate(audioRequest({ model: 'stable-audio-2.5', prompt: 'rain on a tin roof', audio: { kind: 'sound', seconds: 8.4 }, seed: 2 })));
    expect(formFields(kept.bodies[0]!)).toEqual({ prompt: 'rain on a tin roof\nTrackType: SFX', model: 'stable-audio-2.5', duration: '8', seed: '2', output_format: 'mp3' });
    expect(out.find((e) => e.type === 'audio')).toMatchObject({ bytes: MP3 });
  });

  it('polls Stable Audio 3 until the sound is ready', async () => {
    let polls = 0;
    const { fetch } = fakeFetch({
      'POST /v2beta/audio/stable-audio/text-to-audio': () => jsonResponse({ id: 'job1' }, 202),
      'GET /v2beta/audio/results/job1': () => (++polls < 2 ? new Response(null, { status: 202 }) : soundResponse()),
    });
    const out = await events(adapter(fetch).generate(audioRequest({ model: 'stable-audio-3', prompt: 'synthwave', audio: { kind: 'music', seconds: 30 } })));
    expect(out).toContainEqual({ type: 'queued', ahead: 0 });
    expect(finishOf(out).reason).toBe('done');
  }, 10_000);

  it('takes moderation for a refusal', async () => {
    const { fetch } = fakeFetch({ 'POST /v2beta/audio/stable-audio-2/text-to-audio': () => jsonResponse({ errors: ['Your request was flagged'] }, 403) });
    expect(finishOf(await events(adapter(fetch).generate(audioRequest({ model: 'stable-audio-2.5', audio: { kind: 'music' } })))).reason).toBe('refused');
  });
});
