import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ImageWorkflow } from '@atelier/protocol';
import { audioOf } from '../../audio-params.ts';
import { audioGraph, discoverAudioModels } from './audio-templates.ts';
import { collectEvents, fakeServer, fixture, instance, message as m, nodesOf, sentGraph } from './__fixtures__/comfy.ts';
import { outputImages } from './client.ts';
import { detectFamily, discoverModels, type ObjectInfo } from './discovery.ts';
import { createComfyUi } from './index.ts';
import type { JobTiming } from './job.ts';
import type { Graph } from './templates.ts';
import { applyWorkflow, mapWorkflow, readWorkflow, workflowCapabilities } from './workflow.ts';

const FAST: JobTiming = { silenceMs: 5, pollMs: 2, lostMs: 60, stallMs: 30, connectMs: 40, requestMs: 100 };
/** The audio nodes as a ComfyUI 0.43 server lists them, with neutral file names. */
const INFO = fixture<ObjectInfo>('object-info-audio.json');
const MP3 = new Uint8Array(readFileSync(new URL('../../__fixtures__/audio/tone-cbr.mp3', import.meta.url)));
const FLAC_FILE = { filename: 'ComfyUI_temp_abcd_00001.flac', subfolder: '', type: 'temp' };

/** An ACE-Step 1.5 workflow in API format, as its template saves it. */
const ACE15: Graph = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'acestep_v1.5_turbo.safetensors', weight_dtype: 'default' } },
  2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'qwen_0.6b_ace15.safetensors', clip_name2: 'qwen_1.7b_ace15.safetensors', type: 'ace', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'ace_1.5_vae.safetensors' } },
  4: { class_type: 'TextEncodeAceStepAudio1.5', inputs: { clip: ['2', 0], tags: 'pop, piano', lyrics: '[verse]\nhello', seed: 1, bpm: 120, duration: 120, timesignature: '4', language: 'en', keyscale: 'C major', generate_audio_codes: true, cfg_scale: 2, temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0 } },
  5: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
  6: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: 120, batch_size: 1 } },
  7: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: 42, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  8: { class_type: 'VAEDecodeAudio', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  9: { class_type: 'SaveAudioMP3', inputs: { audio: ['8', 0], filename_prefix: 'audio/ComfyUI', quality: 'V0' } },
};

describe('ComfyUI sound models', () => {
  it('never takes a sound checkpoint for a picture model', () => {
    expect(detectFamily('stable-audio-open-1.0.safetensors', 'checkpoint')).toBeNull();
    expect(detectFamily('ace_step_v1_3.5b.safetensors', 'checkpoint')).toBeNull();
    // A picture model whose name only has a sound model's letters in it stays a picture model.
    expect(detectFamily('xiaoyue_anime_xl.safetensors', 'checkpoint')).toBe('sdxl');
    expect(discoverModels(instance, INFO).map((m) => m.modelId)).toEqual(['sd_xl_base_1.0.safetensors']);
  });

  it('offers Stable Audio Open and ACE-Step 1.0 when every part they need is there, and not ACE-Step 1.5', () => {
    const models = discoverAudioModels(instance, INFO);
    expect(models.map((m) => [m.modelId, m.displayName])).toEqual([
      ['stable-audio-open-1.0.safetensors', 'Stable Audio Open'],
      ['ace_step_v1_3.5b.safetensors', 'ACE-Step 1.0'],
    ]);
    expect(audioOf(models[0]!.capabilities)).toMatchObject({ kinds: ['music', 'sound'], durations: { kind: 'range', min: 1, max: 47 }, vocals: 'none' });
    expect(models[0]!.capabilities.defaults).toMatchObject({ sampler: 'dpmpp_3m_sde_gpu', scheduler: 'exponential' });
    expect(audioOf(models[1]!.capabilities)).toMatchObject({ kinds: ['music'], lyrics: true, vocals: 'optional' });
    // Without its text encoder, Stable Audio can't run.
    const noT5 = structuredClone(INFO);
    ((noT5.CLIPLoader as { input: { required: { clip_name: string[][] } } }).input.required.clip_name[0] = ['other.safetensors']);
    expect(discoverAudioModels(instance, noT5).map((m) => m.modelId)).toEqual(['ace_step_v1_3.5b.safetensors']);
  });

  it("builds Stable Audio's graph with the length in both places, ending in a preview", () => {
    const request = { model: 'stable-audio-open-1.0.safetensors', prompt: 'rain on leaves', negativePrompt: 'music', count: 1, quality: 'standard' as const, references: [], tuning: {}, loras: [], capabilities: discoverAudioModels(instance, INFO)[0]!.capabilities, signal: new AbortController().signal, audio: { kind: 'sound' as const, seconds: 12 } };
    const plan = audioGraph(request.model, 'stable-audio', request, 7, INFO);
    expect(nodesOf(plan.graph, 'CLIPLoader')[0]!.inputs).toMatchObject({ clip_name: 't5_base.safetensors', type: 'stable_audio' });
    expect(nodesOf(plan.graph, 'ConditioningStableAudio')[0]!.inputs).toMatchObject({ seconds_start: 0, seconds_total: 12 });
    expect(nodesOf(plan.graph, 'EmptyLatentAudio')[0]!.inputs).toMatchObject({ seconds: 12 });
    expect(nodesOf(plan.graph, 'KSampler')[0]!.inputs).toMatchObject({ seed: 7, steps: 50, sampler_name: 'dpmpp_3m_sde_gpu' });
    expect(plan.graph[plan.output]!.class_type).toBe('PreviewAudio');
  });

  it('runs a job and hands over the sound file it wrote', async () => {
    const server = fakeServer({
      info: INFO,
      routes: { 'GET /view': () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }) },
      onPrompt: (id, s) => s.socket.push(m.progress(id, 10, 50, '7'), { type: 'executed', data: { node: '9', display_node: '9', output: { audio: [FLAC_FILE] }, prompt_id: id } }, m.success(id)),
    });
    const adapter = createComfyUi(instance, { fetch: server.fetch, socket: () => Promise.resolve(server.socket) }, FAST);
    const ace = (await adapter.listModels()).find((m) => m.modelId.startsWith('ace_step'));
    const events = await collectEvents(adapter.generate({ model: ace!.modelId, prompt: 'funk, bass', count: 1, quality: 'standard', references: [], tuning: {}, loras: [], capabilities: ace!.capabilities, signal: new AbortController().signal, seed: 3, audio: { kind: 'music', seconds: 30, instrumental: true } }));
    const graph = sentGraph(server);
    expect(nodesOf(graph, 'TextEncodeAceStepAudio')[0]!.inputs).toMatchObject({ tags: 'funk, bass', lyrics: '[instrumental]' });
    expect(nodesOf(graph, 'EmptyAceStepLatentAudio')[0]!.inputs).toMatchObject({ seconds: 30 });
    expect(events.find((e) => e.type === 'audio')).toMatchObject({ seed: 3 });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'done' });
  });

  it('reads the sound files a node lists under audio', () => {
    expect(outputImages({ audio: [FLAC_FILE] })).toEqual([FLAC_FILE]);
  });
});

describe('a workflow that makes sound', () => {
  it('maps the tags, the lyrics, the length and the seed of ACE-Step 1.5', () => {
    expect(mapWorkflow(ACE15)).toEqual({
      prompt: { node: '4', input: 'tags' },
      seed: { node: '7', input: 'seed' },
      steps: { node: '7', input: 'steps' },
      guidance: { node: '7', input: 'cfg' },
      sampler: { node: '7', input: 'sampler_name' },
      scheduler: { node: '7', input: 'scheduler' },
      seconds: { node: '6', input: 'seconds' },
      lyrics: { node: '4', input: 'lyrics' },
      output: '9',
    });
  });

  it('is a music model that sings, as long as its latent says', async () => {
    const workflow = await readWorkflow({ text: JSON.stringify(ACE15) });
    const caps = workflowCapabilities(workflow);
    expect(caps).toMatchObject({ output: 'audio', family: 'workflow-audio', promptStyle: 'tags', seed: true });
    expect(audioOf(caps)).toMatchObject({ kinds: ['music'], durations: { kind: 'range', min: 1, max: 600 }, defaultSeconds: 120, lyrics: true, vocals: 'optional' });
  });

  it('fills the request in, keeps the encoder’s length in step, and previews instead of saving', async () => {
    const workflow: ImageWorkflow = { ...(await readWorkflow({ text: JSON.stringify(ACE15) })), id: 'ace', name: 'ACE 1.5' };
    const plan = applyWorkflow(workflow, { model: 'workflow:ace', prompt: 'jazz', count: 1, quality: 'standard', references: [], tuning: {}, loras: [], capabilities: workflowCapabilities(workflow), signal: new AbortController().signal, audio: { kind: 'music', seconds: 45, lyrics: 'la la' } }, 5, [], undefined);
    expect(plan.graph['4']!.inputs).toMatchObject({ tags: 'jazz', lyrics: 'la la', duration: 45 });
    expect(plan.graph['6']!.inputs.seconds).toBe(45);
    expect(plan.graph['7']!.inputs.seed).toBe(5);
    expect(plan.graph['9']).toEqual({ class_type: 'PreviewAudio', inputs: { audio: ['8', 0] } });
  });
});
