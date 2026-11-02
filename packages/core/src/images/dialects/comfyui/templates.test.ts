import { describe, expect, it } from 'vitest';
import type { ImageCapabilities } from '@atelier/protocol';
import type { ImageRequest } from '../../types.ts';
import { imageRequest, instance, nodesOf, OBJECT_INFO, validateGraph } from './__fixtures__/comfy.ts';
import { choices, detectFamily, discoverModels, FAMILIES, sourceOf, stackFor, type FamilyId, type ObjectInfo } from './discovery.ts';
import { buildGraph, editSize, type GraphPlan } from './templates.ts';

const SDXL = 'sd_xl_base_1.0.safetensors';
const DISTILLED = 'sd_xl_dmd2_fast.safetensors';
const Z_IMAGE = 'z_image_turbo_bf16.safetensors';
const KLEIN = 'flux-2-klein-4b.safetensors';
const SD15 = 'v1-5-pruned-emaonly.safetensors';
const SD3 = 'sd3.5_large.safetensors';
const FLUX_CHECKPOINT = 'flux1-dev-fp8.safetensors';
const FLUX_UNET = 'flux1-schnell.safetensors';

const models = (info: ObjectInfo = OBJECT_INFO) => discoverModels(instance, info);
const model = (file: string, info?: ObjectInfo) => models(info).find((m) => m.modelId === file)!;

function plan(file: string, over: Partial<ImageRequest> = {}, extra: { images?: string[]; mask?: string; inputSize?: { width: number; height: number }; info?: ObjectInfo } = {}): GraphPlan {
  const info = extra.info ?? OBJECT_INFO;
  const source = sourceOf(file, info)!;
  const family = detectFamily(file, source)!;
  const capabilities = model(file, info).capabilities;
  const request = imageRequest({ model: file, capabilities, tuning: capabilities.defaults ?? {}, ...over });
  return buildGraph({ file, source, family, stack: stackFor(family, file, source, info)!, request, seed: 7, images: extra.images ?? [], info, ...(extra.mask ? { mask: extra.mask } : {}), ...(extra.inputSize ? { inputSize: extra.inputSize } : {}) });
}

const kSampler = (p: GraphPlan, index = 0) => nodesOf(p.graph, 'KSampler')[index]!.inputs;

describe('choices', () => {
  it('reads both ways a server writes a list of options', () => {
    expect(choices(OBJECT_INFO.KSampler, 'sampler_name')).toContain('euler');
    expect(choices(OBJECT_INFO.KSamplerSelect, 'sampler_name')).toContain('euler');
    expect(OBJECT_INFO.KSamplerSelect?.input).toMatchObject({ required: { sampler_name: ['COMBO', expect.anything()] } });
  });

  it('has nothing for a node or input that is not there', () => {
    expect(choices(undefined, 'x')).toEqual([]);
    expect(choices(OBJECT_INFO.KSampler, 'steps')).toEqual([]);
  });
});

describe('detectFamily', () => {
  it.each<[string, 'checkpoint' | 'unet', FamilyId | null]>([
    [SDXL, 'checkpoint', 'sdxl'],
    ['some_photo_model_v9.safetensors', 'checkpoint', 'sdxl'],
    ['MyModel_DMD2.safetensors', 'checkpoint', 'sdxl-distilled'],
    ['sdxl_lightning_8step.safetensors', 'checkpoint', 'sdxl-distilled'],
    ['sd_turbo_hyper.safetensors', 'checkpoint', 'sdxl-distilled'],
    [SD15, 'checkpoint', 'sd15'],
    ['models/sd15/anything.safetensors', 'checkpoint', 'sd15'],
    [SD3, 'checkpoint', 'sd3'],
    [FLUX_CHECKPOINT, 'checkpoint', 'flux'],
    [FLUX_UNET, 'unet', 'flux'],
    [KLEIN, 'unet', 'flux2'],
    ['flux2_dev_fp8.safetensors', 'unet', null],
    [Z_IMAGE, 'unet', 'z-image'],
    ['wan2.2_t2v_high_noise.safetensors', 'unet', null],
  ])('%s from %s is %s', (file, source, family) => {
    expect(detectFamily(file, source)).toBe(family);
  });
});

describe('discovery', () => {
  it('makes a model of each file with a recipe, reading names at runtime', () => {
    expect(models().map((m) => [m.modelId, m.capabilities.family])).toEqual([
      [Z_IMAGE, 'z-image'],
      [KLEIN, 'flux2'],
      [FLUX_CHECKPOINT, 'flux'],
      [FLUX_UNET, 'flux'],
      [SD3, 'sd3'],
      [DISTILLED, 'sdxl-distilled'],
      [SDXL, 'sdxl'],
      [SD15, 'sd15'],
    ]);
  });

  it('lists a general-purpose model first, for whatever takes the first one', () => {
    const info = { ...OBJECT_INFO, CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a_checkpoint.safetensors'], {}] } } } };
    expect(models(info)[0]?.capabilities.family).toBe('z-image');
  });

  it('leaves out what it has no recipe for, so a text model cannot pick something that only fails', () => {
    expect(models().some((m) => m.modelId.startsWith('wan'))).toBe(false);
  });

  it('gives each model its ref under the provider', () => {
    expect(model(Z_IMAGE)).toMatchObject({ ref: `comfy/${Z_IMAGE}`, providerId: 'comfy', source: 'detected' });
  });

  it('names the two awkward files and leaves the rest as they are on disk', () => {
    expect(model(Z_IMAGE).displayName).toBe('Z-Image Turbo');
    expect(model(KLEIN).displayName).toBe('FLUX.2 Klein 4B');
    expect(model(SDXL).displayName).toBe('sd_xl_base_1.0');
  });

  it('fills the capabilities from what the server has', () => {
    const capabilities = model(SDXL).capabilities;
    expect(capabilities).toMatchObject({ family: 'sdxl', promptStyle: 'tags', negativePrompt: true, tunable: true, previews: true, seed: true, edit: true, mask: true, maxReferences: 1, maxCount: 4, transparent: false });
    expect(capabilities.samplers).toEqual(choices(OBJECT_INFO.KSampler, 'sampler_name'));
    expect(capabilities.schedulers).toEqual(choices(OBJECT_INFO.KSampler, 'scheduler'));
    expect(capabilities.loras).toEqual(['dmd2_sdxl_4step_lora_fp16.safetensors']);
  });

  it.each<[string, Partial<ImageCapabilities>]>([
    [SDXL, { defaults: { steps: 30, guidance: 6, sampler: 'dpmpp_2m_sde', scheduler: 'karras' } }],
    [DISTILLED, { defaults: { steps: 8, guidance: 1, sampler: 'dpmpp_sde', scheduler: 'karras' }, negativePrompt: false }],
    [Z_IMAGE, { defaults: { steps: 8, guidance: 1, sampler: 'res_multistep', scheduler: 'simple' }, negativePrompt: false, promptStyle: 'natural' }],
    [KLEIN, { defaults: { steps: 4, guidance: 1, sampler: 'euler', scheduler: 'simple' }, negativePrompt: false, mask: false, maxReferences: 4 }],
    [FLUX_UNET, { defaults: { steps: 4, guidance: 3.5, sampler: 'euler', scheduler: 'simple' } }],
    [FLUX_CHECKPOINT, { defaults: { steps: 20, guidance: 3.5, sampler: 'euler', scheduler: 'simple' } }],
  ])('%s starts from its own recipe', (file, expected) => {
    expect(model(file).capabilities).toMatchObject(expected);
  });

  it('uses the slow settings for the undistilled Klein', () => {
    const info = { ...OBJECT_INFO, UNETLoader: { input: { required: { unet_name: [['flux-2-klein-base-4b.safetensors'], {}] } } } };
    expect(model('flux-2-klein-base-4b.safetensors', info).capabilities.defaults).toMatchObject({ steps: 20, guidance: 5 });
  });

  it('falls back to euler and simple on a server older than the recipe', () => {
    const info = { ...OBJECT_INFO, KSampler: { input: { required: { sampler_name: [['euler'], {}], scheduler: [['normal', 'simple'], {}] } } } };
    expect(model(Z_IMAGE, info).capabilities.defaults).toMatchObject({ sampler: 'euler', scheduler: 'simple' });
  });

  it('does not offer a model whose text encoder or VAE is missing', () => {
    const noVae = { ...OBJECT_INFO, VAELoader: { input: { required: { vae_name: [['pixel_space'], {}] } } } };
    expect(model(Z_IMAGE, noVae)).toBeUndefined();
    expect(model(KLEIN, noVae)).toBeUndefined();
    const noEncoder = { ...OBJECT_INFO, CLIPLoader: { input: { required: { clip_name: [['clip_l.safetensors'], {}], type: [['lumina2', 'flux2'], {}] } } } };
    expect(model(Z_IMAGE, noEncoder)).toBeUndefined();
  });

  it('does not offer a model when its text encoder type is too new for the server', () => {
    const old = { ...OBJECT_INFO, CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b.safetensors'], {}], type: [['stable_diffusion'], {}] } } } };
    expect(model(Z_IMAGE, old)).toBeUndefined();
  });

  it('does not offer a family whose nodes the server lacks', () => {
    const { Flux2Scheduler: _a, ModelSamplingAuraFlow: _b, ...rest } = OBJECT_INFO;
    expect(model(KLEIN, rest)).toBeUndefined();
    expect(model(Z_IMAGE, rest)).toBeUndefined();
  });

  it('takes no input image for FLUX.2 on a server without ReferenceLatent', () => {
    const { ReferenceLatent: _a, ...rest } = OBJECT_INFO;
    expect(model(KLEIN, rest).capabilities).toMatchObject({ edit: false, maxReferences: 0 });
  });

  it('treats a FLUX.1 file as whole when it is a checkpoint, and needs the parts when it is not', () => {
    expect(stackFor('flux', FLUX_CHECKPOINT, 'checkpoint', OBJECT_INFO)).toEqual({});
    expect(stackFor('flux', FLUX_UNET, 'unet', OBJECT_INFO)).toMatchObject({ clip: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp16.safetensors', type: 'flux' } }, vae: 'ae.safetensors' });
  });

  it('adds each imported workflow as a model', () => {
    const workflows = [{ id: 'wf-1', name: 'My poster', graph: { 1: { class_type: 'CLIPTextEncode', inputs: { text: '' } } }, map: { prompt: { node: '1', input: 'text' } } }];
    const listed = discoverModels({ ...instance, workflows }, OBJECT_INFO);
    expect(listed.at(-1)).toMatchObject({ modelId: 'workflow:wf-1', ref: 'comfy/workflow:wf-1', displayName: 'My poster', capabilities: { family: 'workflow' } });
  });
});

describe('templates', () => {
  const FILES = [SDXL, DISTILLED, SD15, SD3, FLUX_CHECKPOINT, FLUX_UNET, KLEIN, Z_IMAGE];

  it.each(FILES)('%s makes a graph the server would accept', (file) => {
    expect(validateGraph(plan(file).graph)).toEqual([]);
  });

  it.each(FILES)('%s still does with an input image and a batch', (file) => {
    expect(validateGraph(plan(file, { count: 3 }, { images: ['atelier/in.png [temp]'] }).graph)).toEqual([]);
  });

  it.each(FILES.filter((f) => f !== KLEIN))('%s still does with a mask', (file) => {
    expect(validateGraph(plan(file, {}, { images: ['atelier/in.png [temp]'], mask: 'atelier/mask.png [temp]' }).graph)).toEqual([]);
  });

  it.each([SDXL, DISTILLED])('%s still does at high quality', (file) => {
    expect(validateGraph(plan(file, { quality: 'high' }).graph)).toEqual([]);
  });

  it('always ends in PreviewImage, so nothing lands in the person\'s output folder', () => {
    for (const file of FILES) {
      const p = plan(file);
      expect(p.graph[p.output]?.class_type).toBe('PreviewImage');
      expect(nodesOf(p.graph, 'SaveImage')).toEqual([]);
    }
  });

  it('builds Z-Image Turbo as the recipe says', () => {
    const { graph } = plan(Z_IMAGE, { width: 1024, height: 1024 });
    expect(nodesOf(graph, 'UNETLoader')[0]?.inputs).toEqual({ unet_name: Z_IMAGE, weight_dtype: 'default' });
    expect(nodesOf(graph, 'CLIPLoader')[0]?.inputs).toEqual({ clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' });
    expect(nodesOf(graph, 'VAELoader')[0]?.inputs).toEqual({ vae_name: 'ae.safetensors' });
    expect(nodesOf(graph, 'ModelSamplingAuraFlow')[0]?.inputs.shift).toBe(3);
    expect(nodesOf(graph, 'EmptySD3LatentImage')[0]?.inputs).toEqual({ width: 1024, height: 1024, batch_size: 1 });
    expect(nodesOf(graph, 'ConditioningZeroOut')).toHaveLength(1);
    expect(kSampler({ graph, output: '', samplers: [] })).toMatchObject({ steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1, seed: 7 });
  });

  it('builds FLUX.2 Klein as the recipe says', () => {
    const { graph, samplers } = plan(KLEIN, { width: 768, height: 1024 });
    expect(nodesOf(graph, 'CLIPLoader')[0]?.inputs).toMatchObject({ type: 'flux2', clip_name: 'qwen_3_4b.safetensors' });
    expect(nodesOf(graph, 'VAELoader')[0]?.inputs).toEqual({ vae_name: 'flux2-vae.safetensors' });
    expect(nodesOf(graph, 'CFGGuider')[0]?.inputs.cfg).toBe(1);
    expect(nodesOf(graph, 'Flux2Scheduler')[0]?.inputs).toEqual({ steps: 4, width: 768, height: 1024 });
    expect(nodesOf(graph, 'KSamplerSelect')[0]?.inputs).toEqual({ sampler_name: 'euler' });
    expect(nodesOf(graph, 'RandomNoise')[0]?.inputs).toEqual({ noise_seed: 7 });
    expect(nodesOf(graph, 'EmptyFlux2LatentImage')[0]?.inputs).toEqual({ width: 768, height: 1024, batch_size: 1 });
    expect(graph[samplers[0]!]?.class_type).toBe('SamplerCustomAdvanced');
  });

  it('builds SDXL as the recipe says', () => {
    const p = plan(SDXL, { negativePrompt: 'blurry', width: 832, height: 1216 });
    expect(kSampler(p)).toMatchObject({ steps: 30, cfg: 6, sampler_name: 'dpmpp_2m_sde', scheduler: 'karras', denoise: 1 });
    expect(nodesOf(p.graph, 'EmptyLatentImage')[0]?.inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    expect(nodesOf(p.graph, 'CLIPTextEncode').map((n) => n.inputs.text)).toEqual(['a lighthouse', 'blurry']);
  });

  it('builds distilled SDXL as the recipe says', () => {
    expect(kSampler(plan(DISTILLED))).toMatchObject({ steps: 8, cfg: 1, sampler_name: 'dpmpp_sde' });
  });

  it('reads FLUX.1 guidance from the conditioning and keeps the sampler at 1', () => {
    const p = plan(FLUX_CHECKPOINT);
    expect(nodesOf(p.graph, 'FluxGuidance')[0]?.inputs.guidance).toBe(3.5);
    expect(kSampler(p).cfg).toBe(1);
  });

  it('shifts SD3 and gives it a separate set of encoders when the server has them', () => {
    const { graph } = plan(SD3);
    expect(nodesOf(graph, 'ModelSamplingSD3')[0]?.inputs.shift).toBe(3);
    expect(nodesOf(graph, 'TripleCLIPLoader')[0]?.inputs).toEqual({ clip_name1: 'clip_l.safetensors', clip_name2: 'clip_g.safetensors', clip_name3: 't5xxl_fp16.safetensors' });
  });

  it('uses the encoders inside an SD3 checkpoint when no separate set exists', () => {
    const info = { ...OBJECT_INFO, TripleCLIPLoader: { input: { required: { clip_name1: [['clip_l.safetensors'], {}] } } } };
    expect(stackFor('sd3', SD3, 'checkpoint', info)).toEqual({});
    expect(stackFor('sd3', 'sd3_unet.safetensors', 'unet', info)).toBeNull();
  });

  it('turns count into batch_size', () => {
    expect(nodesOf(plan(Z_IMAGE, { count: 4 }).graph, 'EmptySD3LatentImage')[0]?.inputs.batch_size).toBe(4);
    expect(nodesOf(plan(KLEIN, { count: 2 }).graph, 'EmptyFlux2LatentImage')[0]?.inputs.batch_size).toBe(2);
  });

  it('uses the settings it was given', () => {
    const p = plan(SDXL, { tuning: { steps: 12, guidance: 3, sampler: 'euler', scheduler: 'normal' } });
    expect(kSampler(p)).toMatchObject({ steps: 12, cfg: 3, sampler_name: 'euler', scheduler: 'normal' });
  });

  it('chains LoRAs, each taking the last one\'s model and text encoder', () => {
    const p = plan(SDXL, { loras: [{ name: 'a.safetensors', weight: 0.8 }, { name: 'b.safetensors', weight: 1 }] });
    const entries = Object.entries(p.graph).filter(([, n]) => n.class_type === 'LoraLoader');
    expect(entries[0]?.[1].inputs).toMatchObject({ lora_name: 'a.safetensors', strength_model: 0.8, strength_clip: 0.8, model: ['1', 0], clip: ['1', 1] });
    expect(entries[1]?.[1].inputs).toMatchObject({ lora_name: 'b.safetensors', model: [entries[0]?.[0], 0], clip: [entries[0]?.[0], 1] });
    expect(kSampler(p).model).toEqual([entries[1]?.[0], 0]);
    expect(nodesOf(p.graph, 'CLIPTextEncode')[0]?.inputs.clip).toEqual([entries[1]?.[0], 1]);
  });

  it('starts from the input image for an edit, keeping some of it', () => {
    const p = plan(SDXL, { width: 1024, height: 1024 }, { images: ['atelier/in.png [temp]'], inputSize: { width: 1024, height: 512 } });
    expect(nodesOf(p.graph, 'LoadImage')[0]?.inputs).toEqual({ image: 'atelier/in.png [temp]' });
    expect(nodesOf(p.graph, 'EmptyLatentImage')).toEqual([]);
    expect(nodesOf(p.graph, 'ImageScale')[0]?.inputs).toMatchObject({ width: 1448, height: 728, crop: 'disabled' });
    expect(kSampler(p).denoise).toBe(0.6);
  });

  it('repeats the latent for a batch of edits', () => {
    expect(nodesOf(plan(SDXL, { count: 3 }, { images: ['x [temp]'] }).graph, 'RepeatLatentBatch')[0]?.inputs.amount).toBe(3);
  });

  it('paints only where the mask is white, and freely there', () => {
    const p = plan(SDXL, {}, { images: ['x [temp]'], mask: 'm [temp]' });
    expect(nodesOf(p.graph, 'LoadImageMask')[0]?.inputs).toEqual({ image: 'm [temp]', channel: 'red' });
    expect(nodesOf(p.graph, 'SetLatentNoiseMask')).toHaveLength(1);
    expect(kSampler(p).denoise).toBe(0.9);
  });

  it('gives FLUX.2 its input images as references, in a chain', () => {
    const p = plan(KLEIN, {}, { images: ['a [temp]', 'b [temp]'], inputSize: { width: 1024, height: 1024 } });
    expect(nodesOf(p.graph, 'ReferenceLatent')).toHaveLength(2);
    expect(nodesOf(p.graph, 'LoadImage').map((n) => n.inputs.image)).toEqual(['a [temp]', 'b [temp]']);
  });

  it('adds a second pass at 1.5× and 0.45 on SDXL at high quality', () => {
    const p = plan(SDXL, { quality: 'high' });
    expect(nodesOf(p.graph, 'LatentUpscaleBy')[0]?.inputs).toMatchObject({ upscale_method: 'bislerp', scale_by: 1.5 });
    expect(kSampler(p, 1)).toMatchObject({ denoise: 0.45, steps: 18 });
    expect(kSampler(p, 1).latent_image).toEqual([Object.entries(p.graph).find(([, n]) => n.class_type === 'LatentUpscaleBy')?.[0], 0]);
  });

  it('keeps a second pass useful on a distilled model', () => {
    expect(kSampler(plan(DISTILLED, { quality: 'high' }), 1).steps).toBe(6);
  });

  it('adds FaceDetailer with the inputs this server wants, at its own defaults', () => {
    const p = plan(SDXL, { quality: 'high' });
    const detailer = nodesOf(p.graph, 'FaceDetailer')[0]!.inputs;
    expect(detailer).toMatchObject({ guide_size: 512, guide_size_for: true, max_size: 1024, seed: 7, steps: 20, cfg: 6, sampler_name: 'dpmpp_2m_sde', scheduler: 'karras', denoise: 0.5, feather: 5, noise_mask: true, force_inpaint: true, bbox_threshold: 0.5, bbox_dilation: 10, bbox_crop_factor: 3, sam_detection_hint: 'center-1', sam_mask_hint_use_negative: 'False', drop_size: 10, wildcard: '', cycle: 1 });
    expect(nodesOf(p.graph, 'UltralyticsDetectorProvider')[0]?.inputs.model_name).toBe('bbox/face_yolov8m.pt');
    expect(p.samplers).toHaveLength(3);
  });

  it('runs without FaceDetailer where it is not installed', () => {
    const { FaceDetailer: _a, ...info } = OBJECT_INFO;
    const p = plan(SDXL, { quality: 'high' }, { info });
    expect(nodesOf(p.graph, 'FaceDetailer')).toEqual([]);
    expect(nodesOf(p.graph, 'KSampler')).toHaveLength(2);
    expect(validateGraph(p.graph)).toEqual([]);
  });

  it('skips FaceDetailer when a version of it needs something unknown, instead of failing the image', () => {
    const entry = OBJECT_INFO.FaceDetailer as { input: { required: Record<string, unknown> } };
    const info = { ...OBJECT_INFO, FaceDetailer: { ...entry, input: { ...entry.input, required: { ...entry.input.required, brand_new: ['SOME_TYPE'] } } } };
    expect(nodesOf(plan(SDXL, { quality: 'high' }, { info }).graph, 'FaceDetailer')).toEqual([]);
  });

  it('does not polish other families, or edits, where the recipe has no second pass', () => {
    expect(nodesOf(plan(Z_IMAGE, { quality: 'high' }).graph, 'KSampler')).toHaveLength(1);
    expect(nodesOf(plan(SDXL, { quality: 'high' }, { images: ['x [temp]'] }).graph, 'KSampler')).toHaveLength(1);
  });

  it('lowers steps for a draft, but not below what makes a picture', () => {
    expect(kSampler(plan(SDXL, { quality: 'draft' })).steps).toBe(18);
    expect(kSampler(plan(Z_IMAGE, { quality: 'draft' })).steps).toBe(6);
    expect(nodesOf(plan(KLEIN, { quality: 'draft' }).graph, 'Flux2Scheduler')[0]?.inputs.steps).toBe(4);
    expect(FAMILIES.flux2.minSteps).toBe(4);
  });

  it('refuses a file with no encoder rather than sending a graph that cannot run', () => {
    const request = imageRequest({ model: KLEIN, capabilities: model(KLEIN).capabilities });
    expect(() => buildGraph({ file: KLEIN, source: 'unet', family: 'flux2', stack: {}, request, seed: 1, images: [], info: OBJECT_INFO })).toThrow(/text encoder/);
  });
});

describe('editSize', () => {
  it('keeps the input\'s shape at about the area asked for', () => {
    expect(editSize({ width: 1024, height: 1024 }, { width: 2000, height: 1000 }, 8)).toEqual({ width: 1448, height: 728 });
    expect(editSize({ width: 1024, height: 1024 }, { width: 1000, height: 2000 }, 16)).toEqual({ width: 720, height: 1456 });
  });

  it('keeps what was asked for when the input\'s size is unknown', () => {
    expect(editSize({ width: 512, height: 768 }, undefined, 8)).toEqual({ width: 512, height: 768 });
    expect(editSize({ width: 512, height: 768 }, { width: 0, height: 0 }, 8)).toEqual({ width: 512, height: 768 });
  });
});
