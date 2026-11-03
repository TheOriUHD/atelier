import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ImageWorkflow } from '@atelier/protocol';
import { videoOf } from '../__fixtures__/video.ts';
import { collectEvents, fakeServer, fixture, IMAGE, instance, message as m, PNG, sentGraph, type Server } from './__fixtures__/comfy.ts';
import { outputImages } from './client.ts';
import { createComfyUi } from './index.ts';
import { frameCount, mapWorkflow, readWorkflow, workflowCapabilities } from './workflow.ts';
import type { Graph } from './templates.ts';
import type { JobTiming } from './job.ts';

const FAST: JobTiming = { silenceMs: 5, pollMs: 2, lostMs: 60, stallMs: 30, connectMs: 40, requestMs: 100 };
const MP4 = new Uint8Array(readFileSync(new URL('../../__fixtures__/tiny.mp4', import.meta.url)));
const graph = () => fixture<Graph>('api-wan-flf-video.json');
// Node names and inputs as the owner's ComfyUI lists them for WanFirstLastFrameToVideo, CreateVideo and SaveVideo.
const VIDEO = { filename: 'ComfyUI_00001_.mp4', subfolder: 'video', type: 'output' };

describe('a workflow that makes video', () => {
  it('maps what Atelier can set: the frames, the frame rate, the first and the last picture', () => {
    expect(mapWorkflow(graph())).toEqual({
      prompt: { node: '4', input: 'text' },
      negative: { node: '5', input: 'text' },
      seed: { node: '10', input: 'seed' },
      steps: { node: '10', input: 'steps' },
      guidance: { node: '10', input: 'cfg' },
      sampler: { node: '10', input: 'sampler_name' },
      scheduler: { node: '10', input: 'scheduler' },
      width: { node: '9', input: 'width' },
      height: { node: '9', input: 'height' },
      frames: { node: '9', input: 'length' },
      fps: { node: '12', input: 'fps' },
      image: { node: '6', input: 'image' },
      endImage: { node: '8', input: 'image' },
      output: '13',
    });
  });

  it('is a video model that needs its picture, with the length and rate the graph holds', async () => {
    const workflow = await readWorkflow({ text: JSON.stringify(graph()) });
    const caps = workflowCapabilities(workflow);
    expect(caps).toMatchObject({ output: 'video', family: 'workflow-video', seed: true, sizes: { kind: 'free', base: 832 } });
    expect(videoOf(caps)).toMatchObject({ durations: { kind: 'range', min: 1, max: 10, step: 1 }, defaultSeconds: 5, defaultFps: 16, firstFrame: true, lastFrame: true, firstFrameRequired: true, audio: 'none' });
  });

  it('is a text-to-video model when it has no picture loader, and a picture workflow stays a picture workflow', async () => {
    const t2v: Graph = { ...graph(), 9: { class_type: 'WanImageToVideo', inputs: { ...graph()[9]!.inputs, start_image: undefined, end_image: undefined } } };
    delete t2v['6'];
    delete t2v['7'];
    delete t2v['8'];
    delete t2v[9]!.inputs.start_image;
    delete t2v[9]!.inputs.end_image;
    const caps = workflowCapabilities(await readWorkflow({ text: JSON.stringify(t2v) }));
    expect(videoOf(caps)).toMatchObject({ firstFrame: false, lastFrame: false });
    expect(videoOf(caps).firstFrameRequired).toBeUndefined();
    const picture = workflowCapabilities({ id: 'wf-1', name: 'p', graph: { 1: { class_type: 'SaveImage', inputs: {} } }, map: { prompt: { node: '1', input: 'text' }, output: '1' } } as ImageWorkflow);
    expect(picture.output).toBeUndefined();
  });

  it('reads a node that lists its file under gifs, as Video Helper Suite does', () => {
    expect(outputImages({ gifs: [{ filename: 'AnimateDiff_00001.mp4', subfolder: '', type: 'output', format: 'video/h264-mp4' }] })).toEqual([{ filename: 'AnimateDiff_00001.mp4', subfolder: '', type: 'output' }]);
    expect(outputImages({ images: [VIDEO], animated: [true] })).toEqual([VIDEO]);
  });

  it('counts frames in the numbers each family makes', () => {
    expect(frameCount('WanImageToVideo', 3, 16)).toBe(49);
    expect(frameCount('WanFirstLastFrameToVideo', 5, 16)).toBe(81);
    expect(frameCount('LTXVImgToVideo', 4, 24)).toBe(97);
    expect(frameCount('EmptyMochiLatentVideo', 2, 30)).toBe(61);
    expect(frameCount('EmptyLatentImage', 2, 24)).toBe(48);
    expect(frameCount('WanImageToVideo', 0.01, 16)).toBe(5);
  });
});

describe('generating a clip with a workflow', () => {
  const workflow = async (): Promise<ImageWorkflow> => ({ ...(await readWorkflow({ text: JSON.stringify(graph()) })), id: 'wf-1', name: 'Wan first-last' });
  const frame = { bytes: PNG, mime: 'image/png', name: 'f.png' };

  async function run(over: { files?: unknown[]; view?: () => Response } = {}) {
    const wf = await workflow();
    const server: Server = fakeServer({
      routes: { 'GET /view': () => over.view?.() ?? new Response(MP4, { headers: { 'content-type': 'video/mp4' } }), 'POST /upload/image': (() => { let n = 0; return () => new Response(JSON.stringify({ name: `up-${++n}.png`, subfolder: 'atelier', type: 'temp' }), { headers: { 'content-type': 'application/json' } }); })() },
      onPrompt: (id, s) => s.socket.push(m.progress(id, 5, 20, '10'), m.executed(id, '13', over.files ?? [VIDEO]), m.success(id)),
    });
    const adapter = createComfyUi({ ...instance, workflows: [wf] }, { fetch: server.fetch, socket: () => Promise.resolve(server.socket) }, FAST);
    const request = {
      model: 'workflow:wf-1',
      prompt: 'a fox in snow',
      negativePrompt: 'ugly',
      count: 1,
      quality: 'standard' as const,
      references: [],
      tuning: {},
      loras: [],
      width: 640,
      height: 368,
      seed: 9,
      capabilities: workflowCapabilities(wf),
      signal: new AbortController().signal,
      video: { seconds: 3, firstFrame: frame, lastFrame: frame },
    };
    return { server, events: await collectEvents(adapter.generate(request)) };
  }

  it('uploads both pictures, fills the graph and hands over the clip’s bytes', async () => {
    const { server, events } = await run();
    const sent = sentGraph(server);
    expect(sent['4']?.inputs.text).toBe('a fox in snow');
    expect(sent['5']?.inputs.text).toBe('ugly');
    expect(sent['6']?.inputs.image).toBe('atelier/up-1.png [temp]');
    expect(sent['8']?.inputs.image).toBe('atelier/up-2.png [temp]');
    expect(sent['9']?.inputs).toMatchObject({ width: 640, height: 368, length: 49 });
    expect(sent['12']?.inputs.fps).toBe(16);
    expect(sent['10']?.inputs.seed).toBe(9);
    // A video save stays as it is: unlike a picture, there is no preview version of it.
    expect(sent['13']?.class_type).toBe('SaveVideo');
    expect(events).toContainEqual({ type: 'progress', step: 5, steps: 20 });
    const clip = events.find((e) => e.type === 'video');
    expect(clip && 'bytes' in clip && clip.bytes?.byteLength).toBe(MP4.byteLength);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'done' });
    expect(events.filter((e) => e.type === 'image')).toHaveLength(0);
  });

  it('takes the video from the files a node listed beside a preview picture', async () => {
    const { server } = await run({ files: [{ ...IMAGE, filename: 'poster.png' }, VIDEO] });
    const views = server.calls.filter((c) => c.url.includes('/view'));
    expect(views).toHaveLength(1);
    expect(views[0]?.url).toContain('ComfyUI_00001_.mp4');
  });

  it('says what to change when the workflow wrote no MP4 or WebM', async () => {
    const { events } = await run({ files: [{ ...IMAGE, filename: 'anim.webp' }] });
    const finish = events.at(-1);
    expect(finish).toMatchObject({ type: 'finish', reason: 'error', error: { message: expect.stringContaining('wrote no MP4 or WebM video') } });
  });

  it('cannot read an animated picture node as video: it is not an output Atelier takes', () => {
    const g = graph();
    g['13'] = { class_type: 'SaveAnimatedWEBP', inputs: { images: ['11', 0], filename_prefix: 'a', fps: 16, lossless: false, quality: 80, method: 'default' } };
    delete g['12'];
    expect(() => mapWorkflow(g)).toThrow('no SaveImage, PreviewImage, SaveVideo, SaveWEBM or VHS_VideoCombine');
  });
});

