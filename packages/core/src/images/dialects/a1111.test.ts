import { describe, expect, it, vi } from 'vitest';
import { imagePreset } from '@atelier/protocol';
import { jsonResponse, type RecordedCall } from '../../providers/__fixtures__/harness.ts';
import { adapterDeps, drain, finishOf, held, imageInstance, imageRequest, imagesOf, JPEG_B64, PNG_B64, pngOf, WEBP_B64 } from '../__fixtures__/harness.ts';
import { checkpointFamily } from '../families.ts';
import { createA1111 } from './a1111.ts';

const POLL = { pollMs: 1 };
const a1111 = (preset: string | undefined = 'a1111') => imageInstance('a1111', preset);

// What modules/api/api.py answers, trimmed to the fields that matter.
const CHECKPOINTS = [
  { title: 'v1-5-pruned-emaonly.safetensors [6ce0161689]', model_name: 'v1-5-pruned-emaonly', hash: '6ce0161689', sha256: 'x', filename: '/m/v1-5-pruned-emaonly.safetensors', config: null },
  { title: 'sdxl/juggernautXL_v9.safetensors [c9e3e68f89]', model_name: 'sdxl_juggernautXL_v9', hash: 'c9e3e68f89', sha256: 'y', filename: '/m/sdxl/juggernautXL_v9.safetensors', config: null },
];
const SAMPLERS = [{ name: 'DPM++ 2M', aliases: ['k_dpmpp_2m'], options: {} }, { name: 'Euler a', aliases: [], options: {} }];
const SCHEDULERS = [{ name: 'automatic', label: 'Automatic', aliases: null, default_rho: -1, need_inner_model: false }, { name: 'karras', label: 'Karras', aliases: null, default_rho: 7, need_inner_model: false }];
const LORAS = [{ name: 'add_detail', alias: 'add_detail', path: '/m/lora/add_detail.safetensors', metadata: {} }];

const txt2img = (over: Record<string, unknown> = {}) =>
  jsonResponse({ images: [PNG_B64], parameters: {}, info: JSON.stringify({ seed: 1234, all_seeds: [1234], subseed: 9, sampler_name: 'Euler a' }), ...over });

const progress = (step: number, steps: number, extra: Record<string, unknown> = {}) =>
  jsonResponse({ progress: steps ? step / steps : 0.01, eta_relative: 3.5, state: { skipped: false, interrupted: false, job: 'scripts_txt2img', job_count: 1, job_timestamp: '20261102', job_no: 0, sampling_step: step, sampling_steps: steps }, current_image: null, textinfo: null, ...extra });

const idle = () => jsonResponse({ progress: 0, eta_relative: 0, state: { skipped: false, interrupted: false, job: '', job_count: 0, job_no: 0, sampling_step: 0, sampling_steps: 0 }, current_image: null, textinfo: null });

/** Answers each poll in turn, then lets the blocking request finish. */
function script(answers: (() => Response)[], end: () => Response = () => txt2img()) {
  const pending = held();
  let poll = 0;
  return {
    txt2img: () => pending.promise,
    progress: () => {
      const answer = answers[poll++];
      if (!answer) {
        pending.release(end());
        return idle();
      }
      return answer();
    },
  };
}

const bodyOf = (calls: RecordedCall[], path: string) => calls.find((c) => c.url.includes(path))?.body as Record<string, unknown>;

describe('a1111 models', () => {
  it('lists checkpoints with the family their name says, and the server\'s own samplers', async () => {
    const { deps } = adapterDeps({
      'GET /sdapi/v1/sd-models': () => jsonResponse(CHECKPOINTS),
      'GET /sdapi/v1/samplers': () => jsonResponse(SAMPLERS),
      'GET /sdapi/v1/schedulers': () => jsonResponse(SCHEDULERS),
      'GET /sdapi/v1/loras': () => jsonResponse(LORAS),
    });
    const models = await createA1111(a1111(), deps, POLL).listModels();
    expect(models.map((m) => [m.modelId, m.displayName, m.capabilities.family])).toEqual([
      ['v1-5-pruned-emaonly.safetensors', 'v1-5-pruned-emaonly', 'sd15'],
      ['sdxl/juggernautXL_v9.safetensors', 'juggernautXL_v9', 'sdxl'],
    ]);
    const [sd15, sdxl] = models.map((m) => m.capabilities);
    expect(sd15).toMatchObject({ promptStyle: 'tags', negativePrompt: true, previews: true, edit: true, mask: true, sizes: { base: 512, multiple: 8 }, samplers: ['DPM++ 2M', 'Euler a'], loras: ['add_detail'], defaults: { steps: 25, guidance: 7, sampler: 'DPM++ 2M', scheduler: 'Karras' } });
    // The server has no such sampler, so it isn't a default.
    expect(sdxl?.defaults).toEqual({ steps: 30, guidance: 6, scheduler: 'Karras' });
    expect(sdxl?.sizes).toMatchObject({ base: 1024 });
  });

  it('loses nothing else when an optional list is missing', async () => {
    const { deps } = adapterDeps({ 'GET /sdapi/v1/sd-models': () => jsonResponse(CHECKPOINTS), 'GET /sdapi/v1/samplers': () => jsonResponse(SAMPLERS) });
    const [model] = await createA1111(a1111(), deps, POLL).listModels();
    expect(model?.capabilities.samplers).toEqual(['DPM++ 2M', 'Euler a']);
    expect(model?.capabilities).not.toHaveProperty('schedulers');
    expect(model?.capabilities).not.toHaveProperty('loras');
  });

  it('has no models and no error when the API is off', async () => {
    const { deps } = adapterDeps({});
    await expect(createA1111(a1111(), deps, POLL).listModels()).resolves.toEqual([]);
  });

  it('says how to turn the API on when the routes are not there', async () => {
    const { deps } = adapterDeps({});
    const health = await createA1111(a1111(), deps, POLL).health();
    expect(health).toMatchObject({ ok: false, error: "Server's API isn't on. Start it with --api." });
  });

  it('is healthy when the checkpoint list answers', async () => {
    const { deps } = adapterDeps({ 'GET /sdapi/v1/sd-models': () => jsonResponse(CHECKPOINTS) });
    await expect(createA1111(a1111(), deps, POLL).health()).resolves.toMatchObject({ ok: true, warnings: [] });
  });
});

describe('a1111 generation', () => {
  it('sends what the API takes, chooses the checkpoint per request, and reads seeds from info', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img({ images: [PNG_B64, PNG_B64], info: JSON.stringify({ seed: 7, all_seeds: [7, 8] }) }) });
    const request = imageRequest({
      model: 'dreamshaper.safetensors',
      negativePrompt: 'blurry',
      count: 2,
      seed: 7,
      tuning: { steps: 20, guidance: 6.5, sampler: 'Euler a', scheduler: 'karras' },
      loras: [{ name: 'add_detail', weight: 0.8 }],
    });
    const events = await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(request));
    expect(bodyOf(calls, 'txt2img')).toEqual({
      prompt: 'a red fox <lora:add_detail:0.8>',
      negative_prompt: 'blurry',
      width: 512,
      height: 768,
      batch_size: 2,
      n_iter: 1,
      seed: 7,
      steps: 20,
      cfg_scale: 6.5,
      sampler_name: 'Euler a',
      scheduler: 'karras',
      send_images: true,
      save_images: false,
      override_settings: { sd_model_checkpoint: 'dreamshaper.safetensors', show_progress_every_n_steps: 1 },
    });
    expect(imagesOf(events).map((e) => e.seed)).toEqual([7, 8]);
    expect(finishOf(events).reason).toBe('done');
  });

  it('keeps a checkpoint\'s id when the server adds its hash to the title, as real Forge does on first use', async () => {
    const before = adapterDeps({ 'GET /sdapi/v1/sd-models': () => jsonResponse([{ title: 'model.safetensors', model_name: 'model', hash: null }]) });
    const after = adapterDeps({ 'GET /sdapi/v1/sd-models': () => jsonResponse([{ title: 'model.safetensors [e9476a1372]', model_name: 'model', hash: 'e9476a1372' }]) });
    const [first] = await createA1111(a1111(), before.deps, POLL).listModels();
    const [second] = await createA1111(a1111(), after.deps, POLL).listModels();
    expect(second?.ref).toBe(first?.ref);
    expect(second?.modelId).toBe('model.safetensors');
  });

  it.each([
    ['model.safetensors', 'model'],
    ['sdxl/juggernautXL_v9.safetensors', 'sdxl_juggernautXL_v9'],
  ])('accepts %s reported back as %s', async (model, used) => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img({ info: JSON.stringify({ seed: 1, all_seeds: [1], sd_model_name: used }) }) });
    expect(finishOf(await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest({ model })))).reason).toBe('done');
  });

  it('says so when the server quietly used another checkpoint, instead of passing it off as the one asked for', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img({ info: JSON.stringify({ seed: 1, all_seeds: [1], sd_model_name: 'other' }) }) });
    const events = await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest({ model: 'gone.safetensors' })));
    expect(imagesOf(events)).toEqual([]);
    expect(finishOf(events)).toMatchObject({ reason: 'error', error: { code: 'model_not_found', message: "Server doesn't have gone any more, and used other instead. Refresh it in Settings." } });
  });

  it('keeps going when a server does not say which checkpoint it used', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img() });
    expect(finishOf(await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest({ model: 'x' })))).reason).toBe('done');
  });

  it('asks for a random seed and keeps the one the server chose', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img() });
    const events = await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest()));
    expect(bodyOf(calls, 'txt2img').seed).toBe(-1);
    expect(imagesOf(events)[0]?.seed).toBe(1234);
  });

  it('takes a seed from info that is an object, and goes without when info is empty', async () => {
    const asObject = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img({ info: { seed: 55 } }) });
    expect(imagesOf(await drain(createA1111(a1111(), asObject.deps, { pollMs: 10_000 }).generate(imageRequest())))[0]?.seed).toBe(55);
    const empty = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img({ info: '' }) });
    expect(imagesOf(await drain(createA1111(a1111(), empty.deps, { pollMs: 10_000 }).generate(imageRequest())))[0]).not.toHaveProperty('seed');
  });

  it('leaves out extra pictures an extension adds after the batch', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img({ images: [PNG_B64, PNG_B64, PNG_B64] }) });
    const events = await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest()));
    expect(imagesOf(events)).toHaveLength(1);
  });

  it('strips a data URL prefix from an image', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img({ images: [`data:image/png;base64,${PNG_B64}`] }) });
    const [image] = imagesOf(await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest())));
    expect(Buffer.from(image!.bytes!).toString('base64')).toBe(PNG_B64);
  });

  it('reports no image as a failure', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img({ images: [] }) });
    const finish = finishOf(await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest())));
    expect(finish).toMatchObject({ reason: 'error', error: { message: 'Server made no image.' } });
  });

  it('edits through img2img, in the shape of the input picture', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/img2img': () => txt2img() });
    const input = { bytes: pngOf(1000, 500), mime: 'image/png', name: 'in.png' };
    const mask = { bytes: pngOf(1000, 500), mime: 'image/png', name: 'mask.png' };
    await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest({ references: [input], mask })));
    const body = bodyOf(calls, 'img2img');
    expect(body).toMatchObject({ width: 728, height: 360, denoising_strength: 0.6, inpainting_fill: 1, mask_blur: 4 });
    expect(body.init_images).toEqual([Buffer.from(input.bytes).toString('base64')]);
    expect(body.mask).toBe(Buffer.from(mask.bytes).toString('base64'));
    expect(calls.some((c) => c.url.includes('txt2img'))).toBe(false);
  });

  it('says the API is off on a 404', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => jsonResponse({ detail: 'Not Found' }, 404) });
    const finish = finishOf(await drain(createA1111(imageInstance('a1111', 'forge', undefined, { name: 'Forge' }), deps, { pollMs: 10_000 }).generate(imageRequest())));
    expect(finish).toMatchObject({ reason: 'error', error: { message: "Forge's API isn't on. Start it with --api.", retryable: false } });
  });

  it('keeps a real 404 apart from the API being off', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => jsonResponse({ detail: 'Sampler not found' }, 404) });
    const finish = finishOf(await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest())));
    expect(finish.error?.message).toContain('Sampler not found');
    expect(finish.error?.message).not.toContain('--api');
  });

  it('reports the real reason from a failed generation', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => jsonResponse({ error: 'OutOfMemoryError', detail: '', body: '', errors: 'CUDA out of memory.' }, 500) });
    const finish = finishOf(await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest())));
    expect(finish.error?.message).toContain('CUDA out of memory.');
  });

  it('reports a server that cannot be reached', async () => {
    const deps = { fetch: async () => Promise.reject(new TypeError('fetch failed')), socket: async () => Promise.reject(new Error('no')) };
    const finish = finishOf(await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest())));
    expect(finish).toMatchObject({ reason: 'error', error: { code: 'provider_offline' } });
  });
});

describe('a1111 progress', () => {
  it('polls while the request blocks, with steps, fraction, time left and a preview', async () => {
    const run = script([() => idle(), () => progress(0, 0), () => progress(1, 4, { current_image: PNG_B64 }), () => progress(1, 4, { current_image: PNG_B64 }), () => progress(2, 4, { current_image: JPEG_B64 })]);
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    const events = await drain(createA1111(a1111(), deps, POLL).generate(imageRequest()));
    expect(calls.find((c) => c.url.includes('progress'))?.url).toContain('skip_current_image=false');
    expect(events.filter((e) => e.type !== 'image')).toEqual([
      { type: 'loading' },
      { type: 'progress', step: 1, steps: 4, fraction: 0.25, etaMs: 3500 },
      { type: 'preview', mime: 'image/png', data: PNG_B64 },
      { type: 'progress', step: 2, steps: 4, fraction: 0.5, etaMs: 3500 },
      { type: 'preview', mime: 'image/jpeg', data: JPEG_B64 },
      { type: 'finish', reason: 'done' },
    ]);
    expect(imagesOf(events)).toHaveLength(1);
  });

  it('gives no time left until a step has finished, when the sum is only its starting value', async () => {
    const run = script([() => jsonResponse({ progress: 0.01, eta_relative: 401.5, state: { job_count: 1, sampling_step: 0, sampling_steps: 25 } }), () => jsonResponse({ progress: 0.05, eta_relative: 136, state: { job_count: 1, sampling_step: 1, sampling_steps: 25 } })]);
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    const events = await drain(createA1111(a1111(), deps, POLL).generate(imageRequest()));
    expect(events.filter((e) => e.type === 'progress')).toEqual([{ type: 'progress', step: 0, steps: 25, fraction: 0.01 }, { type: 'progress', step: 1, steps: 25, fraction: 0.05, etaMs: 136_000 }]);
  });

  it('stops polling once the image is in', async () => {
    const run = script([() => progress(1, 2)]);
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    await drain(createA1111(a1111(), deps, POLL).generate(imageRequest()));
    const polls = calls.filter((c) => c.url.includes('progress')).length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((c) => c.url.includes('progress'))).toHaveLength(polls);
  });

  it('survives a failed poll', async () => {
    const run = script([() => new Response('busy', { status: 500 }), () => progress(1, 2)]);
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    const events = await drain(createA1111(a1111(), deps, POLL).generate(imageRequest()));
    expect(events.some((e) => e.type === 'progress')).toBe(true);
    expect(finishOf(events).reason).toBe('done');
  });

  it('gives up polling a server without the route, and the job still ends', async () => {
    const pending = held();
    let polls = 0;
    const { deps } = adapterDeps({
      'POST /sdapi/v1/txt2img': () => pending.promise,
      'GET /sdapi/v1/progress': () => {
        polls++;
        setTimeout(() => pending.release(txt2img()), 15);
        return new Response('not found', { status: 404 });
      },
    });
    const events = await drain(createA1111(a1111(), deps, POLL).generate(imageRequest()));
    expect(polls).toBe(1);
    expect(finishOf(events).reason).toBe('done');
  });

  it('survives a poll that answers junk', async () => {
    const run = script([() => new Response('<html>', { status: 200 }), () => progress(1, 2)]);
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    expect(finishOf(await drain(createA1111(a1111(), deps, POLL).generate(imageRequest()))).reason).toBe('done');
  });

  it.each([
    ['PNG', PNG_B64, 'image/png'],
    ['JPEG', JPEG_B64, 'image/jpeg'],
    ['WebP', WEBP_B64, 'image/webp'],
  ])('names a %s preview by its bytes, because it follows the server setting', async (_label, image, mime) => {
    const run = script([() => progress(1, 2, { current_image: image })]);
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    const events = await drain(createA1111(a1111(), deps, POLL).generate(imageRequest()));
    expect(events.find((e) => e.type === 'preview')).toEqual({ type: 'preview', mime, data: image });
  });

  it('takes a preview with a data URL prefix, and skips one that is not a picture', async () => {
    const run = script([() => progress(1, 3, { current_image: `data:image/jpeg;base64,${JPEG_B64}` }), () => progress(2, 3, { current_image: 'bm90IGFuIGltYWdlIGF0IGFsbA==' })]);
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    const previews = (await drain(createA1111(a1111(), deps, POLL).generate(imageRequest()))).filter((e) => e.type === 'preview');
    expect(previews).toEqual([{ type: 'preview', mime: 'image/jpeg', data: JPEG_B64 }]);
  });

  it('clamps a progress above 1', async () => {
    const run = script([() => jsonResponse({ progress: 1.3, eta_relative: 0, state: { job_count: 1, sampling_step: 4, sampling_steps: 4 } })]);
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    const events = await drain(createA1111(a1111(), deps, POLL).generate(imageRequest()));
    expect(events.find((e) => e.type === 'progress')).toEqual({ type: 'progress', step: 4, steps: 4, fraction: 1 });
  });
});

describe('a1111 stopping and freeing', () => {
  async function stopped(preset: string | undefined, routes: Record<string, () => Response> = {}) {
    const controller = new AbortController();
    const { deps, calls } = adapterDeps({
      'POST /sdapi/v1/txt2img': (_call, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      'GET /sdapi/v1/progress': () => {
        controller.abort();
        return progress(1, 20);
      },
      ...routes,
    });
    const events = await drain(createA1111(imageInstance('a1111', preset), deps, POLL).generate(imageRequest({ signal: controller.signal })));
    return { events, calls };
  }

  it('interrupts the server when stopped', async () => {
    const { events, calls } = await stopped('a1111', { 'POST /sdapi/v1/interrupt': () => jsonResponse({}) });
    expect(calls.filter((c) => c.url.endsWith('/sdapi/v1/interrupt'))).toHaveLength(1);
    expect(finishOf(events).reason).toBe('aborted');
  });

  it('copes with an interrupt that answers 204 with no body, as SD.Next does', async () => {
    const { events } = await stopped('sdnext', { 'POST /sdapi/v1/interrupt': () => new Response(null, { status: 204 }) });
    expect(finishOf(events).reason).toBe('aborted');
  });

  it('still reports a stop when the interrupt fails', async () => {
    const { events } = await stopped('a1111');
    expect(finishOf(events).reason).toBe('aborted');
  });

  it('does not interrupt after a job that ended normally', async () => {
    const controller = new AbortController();
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img() });
    await drain(createA1111(a1111(), deps, { pollMs: 10_000 }).generate(imageRequest({ signal: controller.signal })));
    controller.abort();
    expect(calls.some((c) => c.url.endsWith('/interrupt'))).toBe(false);
  });

  it('unloads the checkpoint on free', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/unload-checkpoint': () => jsonResponse({}) });
    await createA1111(a1111(), deps, POLL).free?.();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /sdapi/v1/unload-checkpoint']);
  });

  it('does not fail when a fork has no unload route', async () => {
    const { deps } = adapterDeps({});
    await expect(createA1111(a1111(), deps, POLL).free?.()).resolves.toBeUndefined();
  });
});

describe('SD.Next', () => {
  it('sends no scheduler field, because its list is its samplers again', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img(), 'GET /sdapi/v1/sd-models': () => jsonResponse(CHECKPOINTS), 'GET /sdapi/v1/samplers': () => jsonResponse([{ name: 'Default', options: {} }]), 'GET /sdapi/v1/schedulers': () => jsonResponse([{ name: 'UniPC', cls: 'x', options: {} }]) });
    const adapter = createA1111(imageInstance('a1111', 'sdnext'), deps, { pollMs: 10_000 });
    await drain(adapter.generate(imageRequest({ tuning: { scheduler: 'karras', sampler: 'Default' } })));
    expect(bodyOf(calls, 'txt2img')).not.toHaveProperty('scheduler');
    expect(calls.some((c) => c.url.endsWith('/schedulers'))).toBe(false);
    expect((await adapter.listModels())[0]?.capabilities).not.toHaveProperty('schedulers');
    expect(calls.some((c) => c.url.endsWith('/schedulers'))).toBe(false);
  });

  it('does not tell someone to use --api, which it does not have', async () => {
    const { deps } = adapterDeps({});
    const health = await createA1111(imageInstance('a1111', 'sdnext'), deps, POLL).health();
    expect(health.error).toContain('Check the address');
  });
});

describe('KoboldCpp', () => {
  const kobold = () => imageInstance('a1111', 'koboldcpp', 'http://127.0.0.1:5001');

  it('names the job, because progress only answers the caller who did', async () => {
    const run = script([() => progress(1, 2, { current_image: PNG_B64 })]);
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    const events = await drain(createA1111(kobold(), deps, POLL).generate(imageRequest()));
    const { genkey } = bodyOf(calls, 'txt2img');
    expect(genkey).toMatch(/^atelier-/);
    expect(calls.find((c) => c.url.includes('progress'))?.url).toContain(`genkey=${String(genkey)}`);
    expect(events.some((e) => e.type === 'preview')).toBe(true);
  });

  it('has one model and one image, and no checkpoint to choose', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => txt2img(), 'GET /sdapi/v1/sd-models': () => jsonResponse([{ title: 'dreamshaper', model_name: 'dreamshaper', hash: '8888888888', sha256: '8', filename: '/m/dreamshaper.gguf', config: null }]) });
    const adapter = createA1111(kobold(), deps, { pollMs: 10_000 });
    await drain(adapter.generate(imageRequest()));
    expect(bodyOf(calls, 'txt2img')).not.toHaveProperty('override_settings');
    expect((await adapter.listModels())[0]?.capabilities.maxCount).toBe(1);
    expect(adapter.free).toBeUndefined();
  });

  it('stops by dropping the connection, because it has no interrupt route', async () => {
    const controller = new AbortController();
    const { deps, calls } = adapterDeps({
      'POST /sdapi/v1/txt2img': (_call, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      'GET /sdapi/v1/progress': () => (controller.abort(), progress(1, 2)),
    });
    const finish = finishOf(await drain(createA1111(kobold(), deps, POLL).generate(imageRequest({ signal: controller.signal }))));
    expect(finish.reason).toBe('aborted');
    expect(calls.some((c) => c.url.endsWith('/interrupt'))).toBe(false);
  });

  it('warns when it runs without an image model', async () => {
    const { deps } = adapterDeps({ 'GET /sdapi/v1/sd-models': () => jsonResponse([]) });
    await expect(createA1111(kobold(), deps, POLL).health()).resolves.toMatchObject({ ok: true, warnings: ['Server has no image model loaded.'] });
  });
});

describe('stable-diffusion.cpp sd-server', () => {
  const server = () => imageInstance('a1111', 'sd-server', 'http://127.0.0.1:1234');
  // Recorded from a real sd-server, master-1039-290148d, with SD-Turbo on a CPU.
  const SD_MODELS = [{ config: null, filename: 'sd_turbo-f16-q8_0.gguf', hash: '8888888888', model_name: 'sd_turbo-f16-q8_0', sha256: '8'.repeat(64), title: 'sd_turbo-f16-q8_0' }];
  const REAL_SAMPLERS = ['default', 'euler', 'euler_a', 'heun', 'dpm++2m'].map((name) => ({ aliases: [name], name, options: {} }));
  const REAL_SCHEDULERS = ['default', 'discrete', 'karras', 'simple'].map((name) => ({ label: name, name }));
  const realProgress = (step: number, steps: number, image: string | null) => jsonResponse({ current_image: image, eta_relative: 0, progress: steps ? step / steps : 0, state: { interrupted: false, job: 'txt2img', job_count: 1, job_no: 0, job_timestamp: '0', sampling_step: step, sampling_steps: steps, skipped: false }, textinfo: null });
  const realResult = () => jsonResponse({ images: [PNG_B64], parameters: {}, info: JSON.stringify({ all_seeds: [1234], seed: 1234, sampler_name: 'euler_a' }) });

  it('is on the a1111 dialect, for its live progress', () => {
    expect(imagePreset('sd-server')).toMatchObject({ type: 'a1111', baseUrl: 'http://127.0.0.1:1234' });
  });

  it('lists its one model, with the sampler in its own spelling', async () => {
    const { deps } = adapterDeps({ 'GET /sdapi/v1/sd-models': () => jsonResponse(SD_MODELS), 'GET /sdapi/v1/samplers': () => jsonResponse(REAL_SAMPLERS), 'GET /sdapi/v1/schedulers': () => jsonResponse(REAL_SCHEDULERS), 'GET /sdapi/v1/loras': () => jsonResponse([]) });
    const [model, ...rest] = await createA1111(server(), deps, POLL).listModels();
    expect(rest).toEqual([]);
    expect(model).toMatchObject({ modelId: 'sd_turbo-f16-q8_0', displayName: 'sd_turbo-f16-q8_0', capabilities: { family: 'sd-turbo', previews: true, edit: true, mask: true, defaults: { steps: 4, guidance: 1, sampler: 'euler_a' } } });
  });

  it('offers LoRAs by the path it wants back', async () => {
    const { deps } = adapterDeps({ 'GET /sdapi/v1/sd-models': () => jsonResponse(SD_MODELS), 'GET /sdapi/v1/loras': () => jsonResponse([{ name: 'detail', path: 'loras/detail.safetensors' }]) });
    expect((await createA1111(server(), deps, POLL).listModels())[0]?.capabilities.loras).toEqual(['loras/detail.safetensors']);
  });

  it('sends LoRAs as a field, because it ignores tags in the prompt', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': realResult });
    await drain(createA1111(server(), deps, { pollMs: 10_000 }).generate(imageRequest({ loras: [{ name: 'loras/detail.safetensors', weight: 0.7 }] })));
    const body = bodyOf(calls, 'txt2img');
    expect(body.prompt).toBe('a red fox');
    expect(body.lora).toEqual([{ path: 'loras/detail.safetensors', multiplier: 0.7 }]);
  });

  it('chooses no checkpoint and sends no LoRA field without LoRAs', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': realResult });
    await drain(createA1111(server(), deps, { pollMs: 10_000 }).generate(imageRequest()));
    expect(bodyOf(calls, 'txt2img')).not.toHaveProperty('override_settings');
    expect(bodyOf(calls, 'txt2img')).not.toHaveProperty('lora');
  });

  it('reports steps, previews and the seed the way a real one does', async () => {
    const run = script([() => realProgress(0, 0, null), () => realProgress(2, 4, JPEG_B64), () => realProgress(4, 4, JPEG_B64)], realResult);
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': run.txt2img, 'GET /sdapi/v1/progress': run.progress });
    const events = await drain(createA1111(server(), deps, POLL).generate(imageRequest()));
    expect(events.filter((e) => e.type !== 'image')).toEqual([
      { type: 'loading' },
      { type: 'progress', step: 2, steps: 4, fraction: 0.5 },
      { type: 'preview', mime: 'image/jpeg', data: JPEG_B64 },
      { type: 'progress', step: 4, steps: 4, fraction: 1 },
      { type: 'finish', reason: 'done' },
    ]);
    expect(imagesOf(events)[0]?.seed).toBe(1234);
  });

  it('asks no route it lacks when stopped, or to free memory', async () => {
    const controller = new AbortController();
    const { deps, calls } = adapterDeps({
      'POST /sdapi/v1/txt2img': (_call, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      'GET /sdapi/v1/progress': () => (controller.abort(), realProgress(1, 30, null)),
    });
    const adapter = createA1111(server(), deps, POLL);
    expect(finishOf(await drain(adapter.generate(imageRequest({ signal: controller.signal })))).reason).toBe('aborted');
    expect(calls.some((c) => c.url.endsWith('/interrupt'))).toBe(false);
    expect(adapter.free).toBeUndefined();
  });

  it('warns when no model is loaded', async () => {
    const { deps } = adapterDeps({ 'GET /sdapi/v1/sd-models': () => jsonResponse([]) });
    await expect(createA1111(server(), deps, POLL).health()).resolves.toMatchObject({ ok: true, warnings: ['Server has no image model loaded.'] });
  });

  it('says what to do about an old version without these routes', async () => {
    const { deps } = adapterDeps({});
    await expect(createA1111(server(), deps, POLL).health()).resolves.toMatchObject({ ok: false, error: "Server's API isn't on. Update stable-diffusion.cpp: this sd-server has no /sdapi/v1 routes." });
  });

  it('shows its refusal of a LoRA, which comes as a bare error', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => jsonResponse({ error: 'invalid lora path: loras/none.safetensors' }, 400) });
    const finish = finishOf(await drain(createA1111(server(), deps, { pollMs: 10_000 }).generate(imageRequest())));
    expect(finish.error?.message).toContain('invalid lora path');
  });
});

describe('Draw Things', () => {
  const OPTIONS = { model: 'flux_1_schnell_q8p.ckpt', steps: 6, guidance_scale: 3.5, sampler: 'Euler A Trailing', width: 1024, height: 1024, seed: 1234, negative_prompt: '', batch_size: 1, upscaler: '', loras: [] };
  const drawThings = () => imageInstance('a1111', 'drawthings');
  // The keys its RequestBody accepts; anything else fails the request with "Unrecognized keys".
  const ACCEPTED = new Set(['prompt', 'negative_prompt', 'width', 'height', 'batch_size', 'batch_count', 'n_iter', 'seed', 'model', 'steps', 'guidance_scale', 'cfg_scale', 'sampler', 'sampler_name', 'strength', 'denoising_strength', 'init_images', 'restore_faces']);

  it('offers the model the app has open, with the app\'s settings for it', async () => {
    const { deps, calls } = adapterDeps({ 'GET /sdapi/v1/options': () => jsonResponse(OPTIONS) });
    const [model, ...rest] = await createA1111(drawThings(), deps, POLL).listModels();
    expect(rest).toEqual([]);
    expect(model).toMatchObject({ modelId: 'flux_1_schnell_q8p.ckpt', displayName: 'flux_1_schnell_q8p', capabilities: { family: 'flux', previews: false, mask: false, sizes: { multiple: 64 }, defaults: { steps: 6, guidance: 3.5 } } });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/sdapi/v1/options']);
  });

  it('sends only keys it accepts, and none of the routes it lacks', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => jsonResponse({ images: [PNG_B64] }) });
    const events = await drain(createA1111(drawThings(), deps, POLL).generate(imageRequest({ negativePrompt: 'blurry', tuning: { steps: 8, guidance: 2, sampler: 'DPM++ 2M Karras', scheduler: 'karras' }, loras: [{ name: 'x', weight: 1 }] })));
    const body = bodyOf(calls, 'txt2img');
    expect(Object.keys(body).filter((key) => !ACCEPTED.has(key))).toEqual([]);
    expect(body).toMatchObject({ prompt: 'a red fox', steps: 8, guidance_scale: 2, sampler: 'DPM++ 2M Karras' });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/sdapi/v1/txt2img']);
    expect(finishOf(events).reason).toBe('done');
  });

  it('chooses the seed itself, so a run never repeats the app\'s last one, and reports it', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => jsonResponse({ images: [PNG_B64] }) });
    const events = await drain(createA1111(drawThings(), deps, POLL).generate(imageRequest()));
    const { seed } = bodyOf(calls, 'txt2img');
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(imagesOf(events)[0]?.seed).toBe(seed);
  });

  it('edits at the input image\'s own size, since any other is refused', async () => {
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/img2img': () => jsonResponse({ images: [PNG_B64] }) });
    await drain(createA1111(drawThings(), deps, POLL).generate(imageRequest({ references: [{ bytes: pngOf(768, 512), mime: 'image/png', name: 'in.png' }] })));
    const body = bodyOf(calls, 'img2img');
    expect(body).toMatchObject({ width: 768, height: 512, strength: 0.6 });
    expect(Object.keys(body).filter((key) => !ACCEPTED.has(key))).toEqual([]);
  });

  it('explains an input image whose size it would refuse', async () => {
    const { deps, calls } = adapterDeps({});
    const request = imageRequest({ references: [{ bytes: pngOf(1000, 700), mime: 'image/png', name: 'in.png' }] });
    const finish = finishOf(await drain(createA1111(drawThings(), deps, POLL).generate(request)));
    expect(finish.error?.message).toBe('Draw Things needs an input image whose sides are multiples of 64 pixels, and this one is 1000×700.');
    expect(calls).toEqual([]);
  });

  it('shows its own refusal, which is in `detail`', async () => {
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': () => jsonResponse({ error: 'HTTPException', detail: 'Unrecognized keys: ["foo"]', body: '', errors: '' }, 422) });
    const finish = finishOf(await drain(createA1111(drawThings(), deps, POLL).generate(imageRequest())));
    expect(finish.error?.message).toContain('Unrecognized keys');
  });

  it('says how to turn its server on', async () => {
    const { deps } = adapterDeps({});
    await expect(createA1111(drawThings(), deps, POLL).health()).resolves.toMatchObject({ ok: false, error: "Server's API isn't on. Turn on the API Server in the app, with HTTP as the protocol." });
  });

  it('has nothing to free or interrupt', async () => {
    const controller = new AbortController();
    const { deps, calls } = adapterDeps({ 'POST /sdapi/v1/txt2img': (_call, signal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); controller.abort(); }) });
    const adapter = createA1111(drawThings(), deps, POLL);
    expect(finishOf(await drain(adapter.generate(imageRequest({ signal: controller.signal })))).reason).toBe('aborted');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/sdapi/v1/txt2img']);
    expect(adapter.free).toBeUndefined();
  });
});

describe('a1111 requests from a real capability set', () => {
  it('fits the size to the family of the checkpoint', () => {
    expect(checkpointFamily('juggernautXL_v9').sizes).toMatchObject({ base: 1024 });
  });

  it('does not raise an unhandled rejection when a job fails after the caller left', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const controller = new AbortController();
    const { deps } = adapterDeps({ 'POST /sdapi/v1/txt2img': (_call, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
    // Draw Things reports at the start, so the caller can leave with the request still open.
    const events = createA1111(imageInstance('a1111', 'drawthings'), deps, POLL).generate(imageRequest({ signal: controller.signal }))[Symbol.asyncIterator]();
    await events.next();
    await events.return?.();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
