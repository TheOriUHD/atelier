/**
 * ComfyUI's sound recipes (ARCHITECTURE §23): the graphs its own examples use for Stable Audio Open (music and effects,
 * no vocals) and ACE-Step 1.0 (songs with lyrics). A checkpoint becomes a sound model only when every node and file its
 * recipe needs is on the server; anything else, such as ACE-Step 1.5 with its separate encoders, needs an imported
 * workflow that saves with SaveAudio, SaveAudioMP3, SaveAudioOpus or PreviewAudio.
 *
 * Read on 2026-11-06: ComfyUI's comfy_extras/nodes_audio.py and nodes_ace.py, and the /object_info of a 0.43 server.
 */
import { modelRef, type ImageCapabilities } from '@atelier/protocol';
import type { ImageInstance, ImageRequest, ListedImageModel } from '../../types.ts';
import { soundModel } from '../audio-common.ts';
import { choices, type ObjectInfo } from './discovery.ts';
import type { Graph, GraphPlan, Link } from './templates.ts';

export type AudioFamily = 'stable-audio' | 'ace-step';

const NEEDS: Record<AudioFamily, readonly string[]> = {
  'stable-audio': ['EmptyLatentAudio', 'ConditioningStableAudio', 'VAEDecodeAudio', 'PreviewAudio', 'CLIPTextEncode', 'CLIPLoader'],
  'ace-step': ['TextEncodeAceStepAudio', 'EmptyAceStepLatentAudio', 'VAEDecodeAudio', 'PreviewAudio', 'ConditioningZeroOut', 'ModelSamplingSD3'],
};

export function audioFamily(file: string): AudioFamily | null {
  if (/stable[-_ ]?audio/i.test(file)) return 'stable-audio';
  // ACE-Step 1.5 ships as a separate model, encoders and VAE: its graph is another, so it comes in as a workflow.
  if (/ace[-_ ]?step/i.test(file) && !/1[._-]?5|v15/i.test(file)) return 'ace-step';
  return null;
}

/** Stable Audio's text encoder: T5 base, loaded as the `stable_audio` type. */
const t5Base = (info: ObjectInfo) => (choices(info.CLIPLoader, 'type').includes('stable_audio') ? choices(info.CLIPLoader, 'clip_name').find((c) => /t5[-_ ]?base/i.test(c)) : undefined);

/** Settings from ComfyUI's examples, with what this server's sampler list has. */
function defaults(family: AudioFamily, info: ObjectInfo) {
  const samplers = choices(info.KSampler, 'sampler_name');
  const has = (name: string) => samplers.length === 0 || samplers.includes(name);
  if (family === 'stable-audio') return { steps: 50, guidance: 5, sampler: has('dpmpp_3m_sde_gpu') ? 'dpmpp_3m_sde_gpu' : has('dpmpp_3m_sde') ? 'dpmpp_3m_sde' : 'euler', scheduler: has('exponential') ? 'exponential' : 'simple' };
  return { steps: 50, guidance: 5, sampler: 'euler', scheduler: 'simple' };
}

function capabilities(family: AudioFamily, info: ObjectInfo): ImageCapabilities {
  const tuning = defaults(family, info);
  const samplers = choices(info.KSampler, 'sampler_name');
  const schedulers = choices(info.KSampler, 'scheduler');
  const extra = { family, seed: true, previews: false, tunable: true, defaults: tuning, ...(samplers.length ? { samplers } : {}), ...(schedulers.length ? { schedulers } : {}) };
  if (family === 'stable-audio') return soundModel({ kinds: ['music', 'sound'], durations: { kind: 'range', min: 1, max: 47, step: 1 }, defaultSeconds: 30, lyrics: false, vocals: 'none' }, { ...extra, negativePrompt: true });
  return soundModel({ kinds: ['music'], durations: { kind: 'range', min: 5, max: 240, step: 1 }, defaultSeconds: 60, lyrics: true, vocals: 'optional', languages: ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'it'] }, { ...extra, promptStyle: 'tags' });
}

/** The sound checkpoints this server can run, as models. */
export function discoverAudioModels(instance: ImageInstance, info: ObjectInfo): ListedImageModel[] {
  return choices(info.CheckpointLoaderSimple, 'ckpt_name').flatMap((file): ListedImageModel[] => {
    const family = audioFamily(file);
    if (!family || NEEDS[family].some((node) => !info[node]) || (family === 'stable-audio' && !t5Base(info))) return [];
    const base = (file.split(/[/\\]/).pop() ?? file).replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '');
    return [{ ref: modelRef(instance.id, file), providerId: instance.id, modelId: file, displayName: family === 'stable-audio' ? 'Stable Audio Open' : base.replace(/ace[-_ ]?step[-_ ]?v?1[-_ ]?(?:3\.5b)?/i, 'ACE-Step 1.0').trim() || 'ACE-Step 1.0', capabilities: capabilities(family, info), source: 'detected', description: family === 'stable-audio' ? 'Music and sound effects, without vocals' : 'Songs with lyrics, and instrumentals' }];
  });
}

/** The graph for one sound from a sound checkpoint, ending in a preview so nothing is left in the person's output folder. */
export function audioGraph(file: string, family: AudioFamily, request: ImageRequest, seed: number, info: ObjectInfo): GraphPlan {
  const audio = request.audio!;
  const tuning = { ...defaults(family, info), ...request.tuning };
  const seconds = audio.seconds ?? (family === 'stable-audio' ? 30 : 60);
  const graph: Graph = {};
  let next = 1;
  const add = (class_type: string, inputs: Record<string, unknown>): string => {
    const id = String(next++);
    graph[id] = { class_type, inputs };
    return id;
  };
  const loader = add('CheckpointLoaderSimple', { ckpt_name: file });
  const sample = (model: Link, positive: Link, negative: Link, latent: Link) =>
    add('KSampler', { model, positive, negative, latent_image: latent, seed, steps: tuning.steps, cfg: tuning.guidance, sampler_name: tuning.sampler, scheduler: tuning.scheduler, denoise: 1 });
  let sampler: string;
  if (family === 'stable-audio') {
    const clip = add('CLIPLoader', { clip_name: t5Base(info)!, type: 'stable_audio', device: 'default' });
    const positive = add('CLIPTextEncode', { text: request.prompt, clip: [clip, 0] });
    const negative = add('CLIPTextEncode', { text: request.negativePrompt ?? '', clip: [clip, 0] });
    const timed = add('ConditioningStableAudio', { positive: [positive, 0], negative: [negative, 0], seconds_start: 0, seconds_total: seconds });
    const latent = add('EmptyLatentAudio', { seconds, batch_size: 1 });
    sampler = sample([loader, 0], [timed, 0], [timed, 1], [latent, 0]);
  } else {
    const shifted = add('ModelSamplingSD3', { model: [loader, 0], shift: 5 });
    const lyrics = audio.instrumental ? '[instrumental]' : (audio.lyrics ?? '');
    const positive = add('TextEncodeAceStepAudio', { clip: [loader, 1], tags: request.prompt, lyrics, lyrics_strength: 0.99 });
    const negative = add('ConditioningZeroOut', { conditioning: [positive, 0] });
    const latent = add('EmptyAceStepLatentAudio', { seconds, batch_size: 1 });
    sampler = sample([shifted, 0], [positive, 0], [negative, 0], [latent, 0]);
  }
  const decoded = add('VAEDecodeAudio', { samples: [sampler, 0], vae: [loader, 2] });
  const output = add('PreviewAudio', { audio: [decoded, 0] });
  return { graph, output, samplers: [sampler] };
}
