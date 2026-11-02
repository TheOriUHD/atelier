import { describe, expect, it } from 'vitest';
import { jsonResponse, type RecordedCall } from '../../providers/__fixtures__/harness.ts';
import { adapterDeps, drain, fakeSocket, finishOf, imageInstance, imageRequest, imagesOf, JPEG_B64, PNG, PNG_B64, pngOf } from '../__fixtures__/harness.ts';
import type { ImageSocket } from '../types.ts';
import { createSwarmUi } from './swarmui.ts';

const swarm = (over = {}) => imageInstance('swarmui', 'swarmui', 'http://127.0.0.1:7801', over);
const IMAGE_PATH = 'View/local/raw/2026-11-02/0304-a red fox-1.png';
const pngResponse = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });

// What GenT2I_Internal in T2IAPI.cs sends: the path is a plain string at the root, unlike the route docs' nested form.
const STATUS = { status: { waiting_gens: 1, loading_models: 0, waiting_backends: 0, live_gens: 0 }, backend_status: { status: 'running', class: '', message: '', any_loading: false }, supported_features: [] };
const LOADING = { ...STATUS, status: { ...STATUS.status, loading_models: 1 } };
const progress = (overall: number, extra: Record<string, unknown> = {}) => ({ gen_progress: { batch_index: '0', overall_percent: overall, current_percent: overall / 2, ...extra } });
const image = (path = IMAGE_PATH, index = '0', seed = 1234) => ({ image: path, batch_index: index, request_id: '1', metadata: JSON.stringify({ sui_image_params: { seed, steps: 20 } }) });
const CLOSE = { socket_intention: 'close' };

function sessions() {
  let n = 0;
  return () => jsonResponse({ session_id: `session-${++n}`, user_id: 'local', output_append_user: true, version: '0.9.7', server_id: 'x', permissions: [] });
}

const posted = (calls: RecordedCall[], route: string) => calls.filter((c) => c.url.endsWith(`/API/${route}`)).map((c) => c.body as Record<string, unknown>);

function withSocket(messages: Parameters<typeof fakeSocket>[0], routes: Parameters<typeof adapterDeps>[0] = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const open = (url: string) => {
    const socket = fakeSocket(messages, { url });
    sockets.push(socket);
    return Promise.resolve<ImageSocket>(socket);
  };
  return { ...adapterDeps({ 'POST /API/GetNewSession': sessions(), [`GET /${IMAGE_PATH.replaceAll(' ', '%20')}`]: pngResponse, ...routes }, open), sockets };
}

describe('swarmui models', () => {
  const MODELS = {
    folders: [],
    files: [
      { name: 'OfficialStableDiffusion/sd_xl_base_1.0.safetensors', title: 'SDXL 1.0 Base', architecture: 'stable-diffusion-xl-v1-base', compat_class: 'stable-diffusion-xl-v1', standard_width: 1024, standard_height: 1024, is_supported_model_format: true, is_negative_embedding: false },
      { name: 'flux1-schnell.safetensors', title: null, architecture: 'Flux.1-schnell', standard_width: 1360, standard_height: 768, is_supported_model_format: true },
      { name: 'odd.bin', is_supported_model_format: false },
      { name: 'negative.safetensors', is_negative_embedding: true },
    ],
  };
  const PARAMS = { list: [{ id: 'sampler', values: ['euler///Euler', 'dpmpp_2m///DPM++ 2M'] }, { id: 'scheduler', values: ['normal///Normal', 'karras///Karras'] }, { id: 'steps' }] };

  it('sends a session with every route and lists models with their real architecture', async () => {
    const { deps, calls } = adapterDeps({
      'POST /API/GetNewSession': sessions(),
      'POST /API/ListModels': (call) => jsonResponse((call.body as { subtype: string }).subtype === 'LoRA' ? { folders: [], files: [{ name: 'detail.safetensors' }] } : MODELS),
      'POST /API/ListT2IParams': () => jsonResponse(PARAMS),
    });
    const models = await createSwarmUi(swarm(), deps).listModels();
    expect(models.map((m) => [m.modelId, m.displayName, m.capabilities.family])).toEqual([
      ['OfficialStableDiffusion/sd_xl_base_1.0.safetensors', 'SDXL 1.0 Base', 'sdxl'],
      ['flux1-schnell.safetensors', 'flux1-schnell', 'flux'],
    ]);
    expect(models[0]?.capabilities).toMatchObject({ previews: true, edit: true, mask: true, samplers: ['euler', 'dpmpp_2m'], schedulers: ['normal', 'karras'], loras: ['detail.safetensors'], defaults: { steps: 30, guidance: 6, scheduler: 'karras' } });
    expect(models[1]?.capabilities.sizes).toMatchObject({ base: 1022, multiple: 16 });
    for (const body of [...posted(calls, 'ListModels'), ...posted(calls, 'ListT2IParams')]) expect(body.session_id).toBe('session-1');
    expect(posted(calls, 'GetNewSession')).toHaveLength(1);
    expect(posted(calls, 'ListModels')[0]).toMatchObject({ path: '', subtype: 'Stable-Diffusion' });
  });

  it('keeps the models when the sampler and LoRA routes fail', async () => {
    const { deps } = adapterDeps({ 'POST /API/GetNewSession': sessions(), 'POST /API/ListModels': (call) => ((call.body as { subtype: string }).subtype === 'LoRA' ? new Response('nope', { status: 500 }) : jsonResponse(MODELS)) });
    const models = await createSwarmUi(swarm(), deps).listModels();
    expect(models).toHaveLength(2);
    expect(models[0]?.capabilities).not.toHaveProperty('samplers');
  });

  it('gets a new session when the server forgot the old one, and tries again once', async () => {
    let refused = 0;
    const { deps, calls } = adapterDeps({
      'POST /API/GetNewSession': sessions(),
      'POST /API/FreeBackendMemory': (call) => {
        if ((call.body as { session_id: string }).session_id === 'session-1') {
          refused++;
          return jsonResponse({ error: 'Invalid session ID. You may need to refresh the page.', error_id: 'invalid_session_id' }, 401);
        }
        return jsonResponse({ result: true, count: 1 });
      },
    });
    await createSwarmUi(swarm(), deps).free?.();
    expect(refused).toBe(1);
    expect(posted(calls, 'FreeBackendMemory').map((b) => b.session_id)).toEqual(['session-1', 'session-2']);
  });

  it('gives up after one retry', async () => {
    const { deps, calls } = adapterDeps({ 'POST /API/GetNewSession': sessions(), 'POST /API/FreeBackendMemory': () => jsonResponse({ error_id: 'invalid_session_id' }, 401) });
    await expect(createSwarmUi(swarm(), deps).free?.()).rejects.toThrow();
    expect(posted(calls, 'FreeBackendMemory')).toHaveLength(2);
  });

  it('is healthy when it gives a session, and says so when it does not', async () => {
    const good = adapterDeps({ 'POST /API/GetNewSession': sessions() });
    await expect(createSwarmUi(swarm(), good.deps).health()).resolves.toMatchObject({ ok: true });
    const bad = adapterDeps({});
    await expect(createSwarmUi(swarm(), bad.deps).health()).resolves.toMatchObject({ ok: false });
  });
});

describe('swarmui generation', () => {
  it('sends the request over the socket and follows it to the image', async () => {
    const t = withSocket([STATUS, LOADING, STATUS, progress(0.25, { preview: `data:image/jpeg;base64,${JPEG_B64}` }), progress(0.25), progress(0.75), image(), CLOSE]);
    const events = await drain(
      createSwarmUi(swarm(), t.deps).generate(
        imageRequest({ model: 'sdxl/base', negativePrompt: 'blurry', seed: 9, tuning: { steps: 20, guidance: 6, sampler: 'euler', scheduler: 'karras' }, loras: [{ name: 'a', weight: 0.5 }, { name: 'b', weight: 1 }] }),
      ),
    );
    const socket = t.sockets[0]!;
    expect(socket.url).toBe('ws://127.0.0.1:7801/API/GenerateText2ImageWS');
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      session_id: 'session-1',
      images: 1,
      prompt: 'a red fox',
      negativeprompt: 'blurry',
      model: 'sdxl/base',
      width: 512,
      height: 768,
      seed: 9,
      steps: 20,
      cfgscale: 6,
      sampler: 'euler',
      scheduler: 'karras',
      donotsave: true,
      loras: 'a,b',
      loraweights: '0.5,1',
    });
    expect(events.filter((e) => e.type !== 'image')).toEqual([
      { type: 'loading' },
      { type: 'progress', step: 3, steps: 20, fraction: 0.25 },
      { type: 'preview', mime: 'image/jpeg', data: JPEG_B64 },
      { type: 'progress', step: 8, steps: 20, fraction: 0.75 },
      { type: 'finish', reason: 'done' },
    ]);
    expect(imagesOf(events)).toEqual([{ type: 'image', bytes: new Uint8Array(PNG), seed: 1234 }]);
    expect(socket.closed).toBe(true);
    expect(t.calls.some((c) => c.url.includes('/View/'))).toBe(true);
  });

  it('reads the nested image shape the route docs show too', async () => {
    const t = withSocket([{ image: { image: IMAGE_PATH, batch_index: '0', metadata: JSON.stringify({ sui_image_params: { seed: 5 } }) } }, CLOSE]);
    const events = await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest()));
    expect(imagesOf(events)[0]?.seed).toBe(5);
  });

  it('takes an image that comes as a data URL, as it does with donotsave', async () => {
    const t = withSocket([image(`data:image/png;base64,${PNG_B64}`), CLOSE]);
    const events = await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest()));
    expect(Buffer.from(imagesOf(events)[0]!.bytes!).toString('base64')).toBe(PNG_B64);
    expect(t.calls.some((c) => c.url.includes('/View/'))).toBe(false);
  });

  it('copes with metadata that is not JSON', async () => {
    const t = withSocket([{ image: `data:image/png;base64,${PNG_B64}`, batch_index: '0', metadata: 'plain text' }, CLOSE]);
    expect(imagesOf(await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest())))[0]).not.toHaveProperty('seed');
  });

  it('leaves out the images the server discards', async () => {
    const t = withSocket([image(`data:image/png;base64,${PNG_B64}`, '0', 1), image(`data:image/png;base64,${PNG_B64}`, '1', 2), { discard_indices: [0] }, CLOSE]);
    const events = await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest({ count: 2 })));
    expect(imagesOf(events).map((e) => e.seed)).toEqual([2]);
  });

  it('spreads progress over the images of a batch and never runs backwards', async () => {
    const t = withSocket([progress(0.5), progress(0.2), { gen_progress: { batch_index: '1', overall_percent: 0.5 } }, image(`data:image/png;base64,${PNG_B64}`), CLOSE]);
    const events = await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest({ count: 2 })));
    expect(events.filter((e) => e.type === 'progress')).toEqual([{ type: 'progress', fraction: 0.25 }, { type: 'progress', fraction: 0.75 }]);
  });

  it('counts no steps on an edit, which skips the first ones', async () => {
    const t = withSocket([progress(0.5), image(`data:image/png;base64,${PNG_B64}`), CLOSE]);
    const events = await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest({ tuning: { steps: 20 }, references: [{ bytes: PNG, mime: 'image/png', name: 'in.png' }] })));
    expect(events.find((e) => e.type === 'progress')).toEqual({ type: 'progress', fraction: 0.5 });
  });

  it('follows the two series a real server sends side by side, without going back', async () => {
    const series = (overall: number, current: number, preview?: string) => ({ gen_progress: { batch_index: '0', request_id: '1001', overall_percent: overall, current_percent: current, ...(preview ? { preview } : {}) } });
    const t = withSocket([series(0.6458, 1 / 6), series(0.7381, 1 / 6, `data:image/jpeg;base64,${JPEG_B64}`), series(0.6667, 2 / 6), series(0.7619, 2 / 6, `data:image/jpeg;base64,${JPEG_B64}`), series(0.75, 0), series(0.875, 0), image(`data:image/png;base64,${PNG_B64}`), CLOSE]);
    const events = await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest({ tuning: { steps: 6 } })));
    expect(events.filter((e) => e.type === 'progress')).toEqual([
      { type: 'progress', step: 1, steps: 6, fraction: 0.6458 },
      { type: 'progress', step: 1, steps: 6, fraction: 0.7381 },
      { type: 'progress', step: 2, steps: 6, fraction: 0.7619 },
      { type: 'progress', fraction: 0.875 },
    ]);
  });

  it('reports the error the server sends on the socket', async () => {
    const t = withSocket([STATUS, { error: 'Model "gone" not found.' }]);
    const finish = finishOf(await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest())));
    expect(finish).toMatchObject({ reason: 'error', error: { message: 'Server: Model "gone" not found.' } });
    expect(t.sockets[0]!.closed).toBe(true);
  });

  it('gets a new session and starts over when the socket refuses the session', async () => {
    const replies = [[{ error: 'Invalid session ID.', error_id: 'invalid_session_id' }], [image(`data:image/png;base64,${PNG_B64}`), CLOSE]];
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const { deps } = adapterDeps({ 'POST /API/GetNewSession': sessions() }, () => {
      const socket = fakeSocket(replies[sockets.length]!);
      sockets.push(socket);
      return Promise.resolve(socket);
    });
    const events = await drain(createSwarmUi(swarm(), deps).generate(imageRequest()));
    expect(sockets.map((s) => (JSON.parse(s.sent[0]!) as { session_id: string }).session_id)).toEqual(['session-1', 'session-2']);
    expect(finishOf(events).reason).toBe('done');
  });

  it('stops retrying a session that keeps being refused', async () => {
    const { deps } = adapterDeps({ 'POST /API/GetNewSession': sessions() }, () => Promise.resolve(fakeSocket([{ error_id: 'invalid_session_id' }])));
    expect(finishOf(await drain(createSwarmUi(swarm(), deps).generate(imageRequest()))).reason).toBe('error');
  });

  it('uses the HTTP route when the socket will not open', async () => {
    const { deps, calls } = adapterDeps({
      'POST /API/GetNewSession': sessions(),
      'POST /API/GenerateText2Image': () => jsonResponse({ images: [`data:image/png;base64,${PNG_B64}`] }),
    });
    const events = await drain(createSwarmUi(swarm(), deps).generate(imageRequest({ count: 2, seed: 3 })));
    expect(posted(calls, 'GenerateText2Image')[0]).toMatchObject({ session_id: 'session-1', images: 2, seed: 3 });
    expect(imagesOf(events)).toHaveLength(1);
    expect(finishOf(events).reason).toBe('done');
  });

  it('uses the HTTP route when the socket closes without a word', async () => {
    const { deps, calls } = adapterDeps({ 'POST /API/GetNewSession': sessions(), 'POST /API/GenerateText2Image': () => jsonResponse({ images: [`data:image/png;base64,${PNG_B64}`] }) }, () => Promise.resolve(fakeSocket([])));
    expect(finishOf(await drain(createSwarmUi(swarm(), deps).generate(imageRequest()))).reason).toBe('done');
    expect(posted(calls, 'GenerateText2Image')).toHaveLength(1);
  });

  it('does not generate twice when a socket ends after it had started', async () => {
    const t = withSocket([STATUS, progress(0.5)], { 'POST /API/GenerateText2Image': () => jsonResponse({ images: [] }) });
    const finish = finishOf(await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest())));
    expect(posted(t.calls, 'GenerateText2Image')).toHaveLength(0);
    expect(finish).toMatchObject({ reason: 'error', error: { message: 'Server made no image.' } });
  });

  it('reports an error from the HTTP route', async () => {
    const { deps } = adapterDeps({ 'POST /API/GetNewSession': sessions(), 'POST /API/GenerateText2Image': () => jsonResponse({ error: 'No backends available.' }) });
    expect(finishOf(await drain(createSwarmUi(swarm(), deps).generate(imageRequest()))).error?.message).toContain('No backends available.');
  });

  it('asks over HTTP with the sign-in cookie on a server with accounts, since a socket cannot carry it', async () => {
    let opened = false;
    const { deps, calls } = adapterDeps({ 'POST /API/GetNewSession': sessions(), 'POST /API/GenerateText2Image': () => jsonResponse({ images: [`data:image/png;base64,${PNG_B64}`] }) }, () => ((opened = true), Promise.resolve(fakeSocket([]))));
    await drain(createSwarmUi(swarm({ apiKey: 'tok123' }), deps).generate(imageRequest()));
    expect(opened).toBe(false);
    expect(calls[0]?.headers.cookie).toBe('swarm_token=tok123');
  });

  it('sends the input picture and mask as data URLs, in the input picture\'s shape', async () => {
    const t = withSocket([image(`data:image/png;base64,${PNG_B64}`), CLOSE]);
    const input = { bytes: pngOf(800, 400), mime: 'image/png', name: 'in.png' };
    await drain(createSwarmUi(swarm(), t.deps).generate(imageRequest({ references: [input], mask: input })));
    const sent = JSON.parse(t.sockets[0]!.sent[0]!) as Record<string, unknown>;
    expect(sent.initimage).toMatch(/^data:image\/png;base64,/);
    expect(sent.maskimage).toMatch(/^data:image\/png;base64,/);
    expect(sent).toMatchObject({ initimagecreativity: 0.6, width: 728, height: 360 });
  });

  it('interrupts its own session when stopped, and no other', async () => {
    const controller = new AbortController();
    const { deps, calls } = adapterDeps({ 'POST /API/GetNewSession': sessions(), 'POST /API/InterruptAll': () => jsonResponse({ success: true }) }, () => Promise.resolve(fakeSocket([STATUS], { stayOpen: controller.signal })));
    const running = drain(createSwarmUi(swarm(), deps).generate(imageRequest({ signal: controller.signal })));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(finishOf(await running).reason).toBe('aborted');
    expect(posted(calls, 'InterruptAll')).toEqual([{ session_id: 'session-1', other_sessions: false }]);
  });

  it('frees the backend\'s memory', async () => {
    const { deps, calls } = adapterDeps({ 'POST /API/GetNewSession': sessions(), 'POST /API/FreeBackendMemory': () => jsonResponse({ result: true }) });
    await createSwarmUi(swarm(), deps).free?.();
    expect(posted(calls, 'FreeBackendMemory')[0]).toMatchObject({ system_ram: false, backend: 'all' });
  });
});
