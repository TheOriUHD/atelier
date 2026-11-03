import { describe, expect, it } from 'vitest';
import { jsonResponse, type RecordedCall } from '../../providers/__fixtures__/harness.ts';
import { adapterDeps, drain, fakeSocket, finishOf, imageInstance, PNG } from '../__fixtures__/harness.ts';
import type { ImageSocket } from '../types.ts';
import { videoOf, videoRequest } from './__fixtures__/video.ts';
import { createSwarmUi } from './swarmui.ts';

const swarm = (over = {}) => imageInstance('swarmui', 'swarmui', 'http://127.0.0.1:7801', over);
const CLIP_PATH = 'View/local/raw/2026-11-03/0304-a-red-fox.mp4';
const clipResponse = () => new Response(new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom'), 0, 0, 0, 0]), { headers: { 'content-type': 'video/mp4' } });
const sessions = () => {
  let n = 0;
  return () => jsonResponse({ session_id: `session-${++n}` });
};
const posted = (calls: RecordedCall[], route: string) => calls.filter((c) => c.url.endsWith(`/API/${route}`)).map((c) => c.body as Record<string, unknown>);

// Shapes from ListT2IParams in T2IAPI.cs: `model_classes` name their compat class, which carries the flags.
const PARAMS = {
  list: [],
  model_classes: { 'wan-21-14b-t2v': { compat_class: 'wan-21-14b' }, 'wan-21-14b-i2v': { compat_class: 'wan-21-14b-i2v-c' }, 'wan-flf2v': { compat_class: 'wan-21-14b-i2v-c' }, 'stable-diffusion-xl-v1-base': { compat_class: 'stable-diffusion-xl-v1' } },
  model_compat_classes: { 'wan-21-14b': { is_text2video: true, is_image2video: false }, 'wan-21-14b-i2v-c': { is_text2video: false, is_image2video: true }, 'stable-diffusion-xl-v1': { is_text2video: false, is_image2video: false } },
};
const FILES = {
  folders: [],
  files: [
    { name: 'wan2.1_t2v_14B.safetensors', title: 'Wan 2.1 T2V', architecture: 'wan-21-14b-t2v', standard_width: 832, standard_height: 480 },
    { name: 'wan2.1_i2v_14B.safetensors', architecture: 'wan-21-14b-i2v', standard_width: 832, standard_height: 480 },
    { name: 'wan2.1_flf2v.safetensors', architecture: 'wan-flf2v' },
    { name: 'sd_xl_base_1.0.safetensors', architecture: 'stable-diffusion-xl-v1-base', standard_width: 1024, standard_height: 1024 },
  ],
};

describe('SwarmUI video models', () => {
  it('tells video models from picture models by their class, and what each can start from', async () => {
    const { deps } = adapterDeps({
      'POST /API/GetNewSession': sessions(),
      'POST /API/ListModels': (call) => jsonResponse((call.body as { subtype: string }).subtype === 'LoRA' ? { files: [] } : FILES),
      'POST /API/ListT2IParams': () => jsonResponse(PARAMS),
    });
    const models = await createSwarmUi(swarm(), deps).listModels();
    const by = Object.fromEntries(models.map((m) => [m.modelId, m]));
    expect(by['sd_xl_base_1.0.safetensors']!.capabilities.output).toBeUndefined();
    expect(by['wan2.1_t2v_14B.safetensors']).toMatchObject({ displayName: 'Wan 2.1 T2V', capabilities: { output: 'video', seed: true, negativePrompt: true, sizes: { kind: 'free', base: 632 } } });
    expect(videoOf(by['wan2.1_t2v_14B.safetensors']!.capabilities)).toMatchObject({ durations: { kind: 'range', min: 1, max: 10, step: 1 }, defaultFps: 24, firstFrame: false, audio: 'none' });
    expect(videoOf(by['wan2.1_i2v_14B.safetensors']!.capabilities)).toMatchObject({ firstFrame: true, firstFrameRequired: true, lastFrame: false });
    expect(videoOf(by['wan2.1_flf2v.safetensors']!.capabilities)).toMatchObject({ firstFrame: true, lastFrame: true });
  });

  it('lists every file as a picture model when the server gives no classes', async () => {
    const { deps } = adapterDeps({ 'POST /API/GetNewSession': sessions(), 'POST /API/ListModels': () => jsonResponse(FILES), 'POST /API/ListT2IParams': () => jsonResponse({}, 500) });
    const models = await createSwarmUi(swarm(), deps).listModels();
    expect(models.every((m) => m.capabilities.output !== 'video')).toBe(true);
  });
});

describe('SwarmUI video generation', () => {
  const messages = (path = CLIP_PATH) => [{ gen_progress: { batch_index: '0', overall_percent: 0.5, current_percent: 0.5 } }, { image: path, batch_index: '0', metadata: JSON.stringify({ sui_image_params: { seed: 77 } }) }, { socket_intention: 'close' }];
  function run(over: Parameters<typeof videoRequest>[0], routes: Parameters<typeof adapterDeps>[0] = {}, apiKey?: string) {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const open = (url: string) => {
      const socket = fakeSocket(messages(), { url });
      sockets.push(socket);
      return Promise.resolve<ImageSocket>(socket);
    };
    const { deps, calls } = adapterDeps({ 'POST /API/GetNewSession': sessions(), [`GET /${CLIP_PATH}`]: clipResponse, ...routes }, open);
    return { events: drain(createSwarmUi(swarm(apiKey ? { apiKey } : {}), deps).generate(videoRequest({ model: 'wan2.1_t2v_14B.safetensors', width: 832, height: 480, ...over })) ), sockets, calls };
  }

  it('asks a text-to-video model for frames and a video format, and hands over the clip’s bytes and seed', async () => {
    const t = run({ video: { seconds: 3 } });
    const out = await t.events;
    expect(JSON.parse(t.sockets[0]!.sent[0]!)).toEqual({ session_id: 'session-1', images: 1, prompt: 'a red lighthouse', negativeprompt: '', width: 832, height: 480, seed: -1, donotsave: true, videofps: 24, videoformat: 'h264-mp4', model: 'wan2.1_t2v_14B.safetensors', textvideoframes: 72 });
    expect(out).toContainEqual({ type: 'progress', fraction: 0.5 });
    const clip = out.find((e) => e.type === 'video');
    expect(clip).toMatchObject({ type: 'video', seed: 77 });
    expect(clip && 'bytes' in clip && clip.bytes?.byteLength).toBe(16);
    expect(t.calls.some((c) => c.url.endsWith(CLIP_PATH))).toBe(true);
    expect(finishOf(out).reason).toBe('done');
  });

  it('turns a first frame into an image-to-video job on the video model, with creativity 0 and an end image', async () => {
    const frame = { bytes: PNG, mime: 'image/png', name: 'f.png' };
    const t = run({ model: 'wan2.1_flf2v.safetensors', seed: 5, video: { seconds: 2, fps: 16, firstFrame: frame, lastFrame: frame } });
    await t.events;
    const sent = JSON.parse(t.sockets[0]!.sent[0]!) as Record<string, unknown>;
    expect(sent).toMatchObject({ videomodel: 'wan2.1_flf2v.safetensors', videoframes: 32, videofps: 16, initimagecreativity: 0, seed: 5 });
    expect(sent).not.toHaveProperty('model');
    expect(sent).not.toHaveProperty('textvideoframes');
    expect(sent.initimage).toMatch(/^data:image\/png;base64,/);
    expect(sent.videoendimage).toMatch(/^data:image\/png;base64,/);
  });

  it('goes over HTTP when the server has accounts, taking the first file as the clip', async () => {
    const t = run({}, { 'POST /API/GenerateText2Image': () => jsonResponse({ images: [CLIP_PATH, 'View/local/raw/other.png'] }) }, 'token');
    const out = await t.events;
    expect(t.sockets).toHaveLength(0);
    expect(posted(t.calls, 'GenerateText2Image')[0]).toMatchObject({ textvideoframes: 144 });
    expect(out.filter((e) => e.type === 'video')).toHaveLength(1);
    expect(out.some((e) => e.type === 'image')).toBe(false);
  });

  it('stops the job on the server when stopped', async () => {
    const controller = new AbortController();
    const { deps, calls } = adapterDeps({ 'POST /API/GetNewSession': sessions(), 'POST /API/InterruptAll': () => jsonResponse({ success: true }) }, () => {
      controller.abort();
      return Promise.resolve<ImageSocket>(fakeSocket([], { stayOpen: controller.signal }));
    });
    const out = await drain(createSwarmUi(swarm(), deps).generate(videoRequest({ model: 'm', signal: controller.signal })));
    expect(finishOf(out).reason).toBe('aborted');
    expect(posted(calls, 'InterruptAll')).toHaveLength(1);
  });
});
