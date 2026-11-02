import { describe, expect, it } from 'vitest';
import { jsonResponse, type RecordedCall } from '../../providers/__fixtures__/harness.ts';
import { adapterDeps, drain, finishOf, imageInstance, imageRequest, imagesOf, PNG, pngOf } from '../__fixtures__/harness.ts';
import { buildGraph, createInvokeAi } from './invokeai.ts';

const POLL = { pollMs: 1 };
const invoke = () => imageInstance('invokeai', 'invokeai', 'http://127.0.0.1:9090');

const SD1 = { key: 'k-sd1', hash: 'blake3:aa', name: 'Dreamshaper 8', base: 'sd-1', type: 'main', format: 'checkpoint', variant: 'normal' };
const SDXL = { key: 'k-xl', hash: 'blake3:bb', name: 'Juggernaut', base: 'sdxl', type: 'main', format: 'diffusers', variant: 'normal', default_settings: { steps: 40, cfg_scale: 5, scheduler: 'euler' } };

type Graph = { nodes: Record<string, Record<string, unknown>>; edges: { source: { node_id: string; field: string }; destination: { node_id: string; field: string } }[] };
const wire = (graph: Graph) => graph.edges.map((e) => `${e.source.node_id}.${e.source.field} -> ${e.destination.node_id}.${e.destination.field}`);

/** A queue item as `GET /api/v1/queue/default/i/{id}` returns it. */
const item = (status: string, session: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => jsonResponse({ item_id: 1, status, batch_id: 'b', session_id: 's', session: { id: 's', graph: { nodes: { loader: {}, noise: { seed: 42 }, l2i: {} }, edges: [] }, execution_graph: { nodes: {}, edges: [] }, results: {}, source_prepared_mapping: {}, ...session }, ...extra });

const DONE = { source_prepared_mapping: { l2i: ['p-3'] }, results: { 'p-1': { type: 'image_output', image: { image_name: 'resized.png' } }, 'p-3': { type: 'image_output', image: { image_name: 'final.png' }, width: 512, height: 512 } } };

function queue(answers: (() => Response)[], routes: Parameters<typeof adapterDeps>[0] = {}) {
  let poll = 0;
  return adapterDeps({
    'GET /api/v2/models/i/k-sd1': () => jsonResponse(SD1),
    'GET /api/v2/models/i/k-xl': () => jsonResponse(SDXL),
    'POST /api/v1/queue/default/enqueue_batch': () => jsonResponse({ item_ids: [1], enqueued: 1, requested: 1 }, 201),
    'GET /api/v1/queue/default/i/1': () => (answers[Math.min(poll++, answers.length - 1)] as () => Response)(),
    'GET /api/v1/images/i/final.png/full': () => new Response(PNG),
    ...routes,
  });
}

const enqueued = (calls: RecordedCall[]) => calls.find((c) => c.url.endsWith('/enqueue_batch'))?.body as { prepend: boolean; batch: { graph: Graph; runs: number; origin: string; data: unknown } };

describe('invokeai models', () => {
  const MODELS = {
    models: [
      SD1,
      SDXL,
      { key: 'k-2', hash: 'h', name: 'SD 2.1', base: 'sd-2', type: 'main', variant: 'normal' },
      { key: 'k-flux', hash: 'h', name: 'FLUX Dev', base: 'flux', type: 'main' },
      { key: 'k-refiner', hash: 'h', name: 'SDXL Refiner', base: 'sdxl-refiner', type: 'main' },
      { key: 'k-inpaint', hash: 'h', name: 'SD Inpainting', base: 'sd-1', type: 'main', variant: 'inpaint' },
      { key: 'k-pixl', hash: 'h', name: 'pixl art', base: 'sd-1', type: 'main', variant: 'normal' },
    ],
  };

  it('offers only the families there are graphs for', async () => {
    const { deps, calls } = adapterDeps({ 'GET /api/v2/models/': () => jsonResponse(MODELS) });
    const models = await createInvokeAi(invoke(), deps, POLL).listModels();
    expect(models.map((m) => [m.modelId, m.displayName, m.capabilities.family])).toEqual([
      ['k-sd1', 'Dreamshaper 8', 'sd15'],
      ['k-xl', 'Juggernaut', 'sdxl'],
      ['k-2', 'SD 2.1', 'sd2'],
      // Its base is known, so "pixl" doesn't make it SDXL.
      ['k-pixl', 'pixl art', 'sd15'],
    ]);
    expect(calls[0]?.url).toContain('model_type=main');
  });

  it('uses the settings Invoke holds for a model, then the family\'s', async () => {
    const { deps } = adapterDeps({ 'GET /api/v2/models/': () => jsonResponse(MODELS) });
    const [sd1, xl] = await createInvokeAi(invoke(), deps, POLL).listModels();
    expect(xl?.capabilities.defaults).toEqual({ steps: 40, guidance: 5, sampler: 'euler' });
    expect(sd1?.capabilities).toMatchObject({ defaults: { steps: 25, guidance: 7, sampler: 'dpmpp_2m_k' }, previews: false, mask: false, edit: true });
    expect(sd1?.capabilities.samplers).toContain('dpmpp_2m_k');
  });

  it('checks health at the app version', async () => {
    const { deps } = adapterDeps({ 'GET /api/v1/app/version': () => jsonResponse({ version: '6.14.3' }) });
    await expect(createInvokeAi(invoke(), deps, POLL).health()).resolves.toMatchObject({ ok: true });
  });
});

describe('invokeai graphs', () => {
  const request = imageRequest({ negativePrompt: 'blurry', tuning: { steps: 20, guidance: 7, sampler: 'euler_a' } });

  it('builds an SD graph as the app\'s own builder does', () => {
    const graph = buildGraph(SD1, request, 42, undefined) as Graph;
    expect(graph.nodes).toMatchObject({
      loader: { id: 'loader', type: 'main_model_loader', model: { key: 'k-sd1', hash: 'blake3:aa', name: 'Dreamshaper 8', base: 'sd-1', type: 'main' } },
      positive: { type: 'compel', prompt: 'a red fox' },
      negative: { type: 'compel', prompt: 'blurry' },
      noise: { type: 'noise', seed: 42, width: 512, height: 768, use_cpu: true },
      denoise: { type: 'denoise_latents', steps: 20, cfg_scale: 7, scheduler: 'euler_a', denoising_start: 0, denoising_end: 1 },
      l2i: { type: 'l2i', is_intermediate: true, use_cache: false },
    });
    expect(wire(graph).sort()).toEqual(
      [
        'denoise.latents -> l2i.latents',
        'loader.clip -> negative.clip',
        'loader.clip -> positive.clip',
        'loader.unet -> denoise.unet',
        'loader.vae -> l2i.vae',
        'negative.conditioning -> denoise.negative_conditioning',
        'noise.noise -> denoise.noise',
        'positive.conditioning -> denoise.positive_conditioning',
      ].sort(),
    );
  });

  it('gives SDXL its own loader, both text encoders and its size conditioning', () => {
    const graph = buildGraph(SDXL, request, 42, undefined) as Graph;
    expect(graph.nodes.loader).toMatchObject({ type: 'sdxl_model_loader' });
    expect(graph.nodes.positive).toEqual({ id: 'positive', type: 'sdxl_compel_prompt', prompt: 'a red fox', style: 'a red fox', original_width: 512, original_height: 768, target_width: 512, target_height: 768, crop_top: 0, crop_left: 0 });
    expect(wire(graph)).toEqual(expect.arrayContaining(['loader.clip2 -> positive.clip2', 'loader.clip2 -> negative.clip2']));
  });

  it('starts an edit from the input picture, resized to what the noise expects', () => {
    const graph = buildGraph(SD1, imageRequest({ tuning: { steps: 20 }, references: [{ bytes: pngOf(1000, 500), mime: 'image/png', name: 'in.png' }] }), 42, 'uploaded.png') as Graph;
    expect(graph.nodes.resize).toMatchObject({ type: 'img_resize', image: { image_name: 'uploaded.png' }, width: 728, height: 360 });
    expect(graph.nodes.noise).toMatchObject({ width: 728, height: 360 });
    expect(graph.nodes.denoise?.denoising_start).toBeCloseTo(0.4);
    expect(wire(graph)).toEqual(expect.arrayContaining(['resize.image -> i2l.image', 'loader.vae -> i2l.vae', 'i2l.latents -> denoise.latents']));
  });

  it('wires only nodes that exist', () => {
    const graph = buildGraph(SDXL, imageRequest({ references: [{ bytes: PNG, mime: 'image/png', name: 'in.png' }] }), 1, 'x.png') as Graph;
    for (const { source, destination } of graph.edges) {
      expect(graph.nodes[source.node_id]).toBeDefined();
      expect(graph.nodes[destination.node_id]).toBeDefined();
    }
  });
});

describe('invokeai generation', () => {
  it('queues a graph, follows the item and fetches the image', async () => {
    const { deps, calls } = queue([() => item('pending'), () => item('in_progress'), () => item('in_progress', { results: { a: {} } }), () => item('completed', DONE)]);
    const events = await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'k-sd1', seed: 42 })));
    const { prepend, batch } = enqueued(calls);
    expect(prepend).toBe(false);
    expect(batch).toMatchObject({ runs: 1, origin: 'atelier', data: [[{ node_path: 'noise', field_name: 'seed', items: [42] }]] });
    expect(batch.graph.nodes.loader).toMatchObject({ type: 'main_model_loader' });
    expect(events.filter((e) => e.type !== 'image')).toEqual([{ type: 'loading' }, { type: 'progress', fraction: 1 / 3 }, { type: 'finish', reason: 'done' }]);
    expect(imagesOf(events)).toEqual([{ type: 'image', bytes: new Uint8Array(PNG), seed: 42 }]);
  });

  it('fetches the output node\'s image, not the resized input an edit also leaves in the results', async () => {
    const { deps, calls } = queue([() => item('completed', DONE)]);
    await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'k-sd1' })));
    expect(calls.some((c) => c.url.includes('final.png'))).toBe(true);
    expect(calls.some((c) => c.url.includes('resized.png'))).toBe(false);
  });

  it('finds the image without a source mapping', async () => {
    const { deps } = queue([() => item('completed', { results: { x: { type: 'image_output', image: { image_name: 'final.png' } } } })]);
    expect(imagesOf(await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'k-sd1' }))))).toHaveLength(1);
  });

  it('runs one queue item per image, each with its own seed', async () => {
    const answers = (id: number) => () => jsonResponse({ item_id: id, status: 'completed', session: { graph: { nodes: { noise: { seed: 10 + id } } }, results: { p: { type: 'image_output', image: { image_name: 'final.png' } } }, source_prepared_mapping: { l2i: ['p'] } } });
    const { deps, calls } = adapterDeps({
      'GET /api/v2/models/i/k-sd1': () => jsonResponse(SD1),
      'POST /api/v1/queue/default/enqueue_batch': () => jsonResponse({ item_ids: [1, 2] }, 201),
      'GET /api/v1/queue/default/i/1': answers(1),
      'GET /api/v1/queue/default/i/2': answers(2),
      'GET /api/v1/images/i/final.png/full': () => new Response(PNG),
    });
    const events = await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'k-sd1', count: 2, seed: 10 })));
    expect(enqueued(calls).batch.data).toEqual([[{ node_path: 'noise', field_name: 'seed', items: [10, 11] }]]);
    expect(imagesOf(events).map((e) => e.seed)).toEqual([11, 12]);
  });

  it('uploads an input picture first, as multipart bytes', async () => {
    const seen: { contentType?: string; bytes?: number } = {};
    const { deps, calls } = queue([() => item('completed', DONE)], { 'POST /api/v1/images/upload': () => jsonResponse({ image_name: 'up.png' }, 201) });
    const plain = deps.fetch;
    const spying = {
      ...deps,
      fetch: ((url, init) => {
        if (url.includes('/images/upload')) {
          seen.contentType = new Headers(init.headers).get('content-type') ?? '';
          seen.bytes = (init.body as Uint8Array).byteLength;
        }
        return plain(url, init);
      }) as typeof deps.fetch,
    };
    await drain(createInvokeAi(invoke(), spying, POLL).generate(imageRequest({ model: 'k-sd1', references: [{ bytes: PNG, mime: 'image/png', name: 'in.png' }] })));
    expect(calls.find((c) => c.url.includes('/images/upload'))?.url).toContain('image_category=general&is_intermediate=true');
    expect(seen.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen.bytes).toBeGreaterThan(PNG.byteLength);
    expect(enqueued(calls).batch.graph.nodes.resize).toMatchObject({ image: { image_name: 'up.png' } });
  });

  it('reports a failed job with Invoke\'s reason', async () => {
    const { deps } = queue([() => item('failed', {}, { error_type: 'OutOfMemoryError', error_message: 'CUDA out of memory' })]);
    const finish = finishOf(await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'k-sd1' }))));
    expect(finish).toMatchObject({ reason: 'error' });
    expect(finish.error?.message).toContain('OutOfMemoryError: CUDA out of memory');
  });

  it('reports a job cancelled by someone in Invoke', async () => {
    const { deps } = queue([() => item('canceled')]);
    const finish = finishOf(await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'k-sd1' }))));
    expect(finish.error?.message).toBe('The job was cancelled in Server.');
  });

  it('reports a batch it refused', async () => {
    const { deps } = queue([], { 'POST /api/v1/queue/default/enqueue_batch': () => jsonResponse({ detail: 'Invalid graph' }, 422) });
    expect(finishOf(await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'k-sd1' })))).error?.message).toContain('Invalid graph');
  });

  it('reports a model that has gone', async () => {
    const { deps } = queue([]);
    expect(finishOf(await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'missing' })))).reason).toBe('error');
  });

  it('cancels the queue item when stopped', async () => {
    const controller = new AbortController();
    const { deps, calls } = queue(
      [
        () => {
          controller.abort();
          return item('in_progress');
        },
      ],
      { 'PUT /api/v1/queue/default/i/1/cancel': () => item('canceled') },
    );
    const finish = finishOf(await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'k-sd1', signal: controller.signal }))));
    expect(finish.reason).toBe('aborted');
    expect(calls.filter((c) => c.url.endsWith('/cancel')).map((c) => c.method)).toEqual(['PUT']);
  });

  it('leaves finished items alone when stopped', async () => {
    const controller = new AbortController();
    const { deps, calls } = adapterDeps({
      'GET /api/v2/models/i/k-sd1': () => jsonResponse(SD1),
      'POST /api/v1/queue/default/enqueue_batch': () => jsonResponse({ item_ids: [1, 2] }, 201),
      'GET /api/v1/queue/default/i/1': () => item('completed', DONE),
      'GET /api/v1/queue/default/i/2': () => (controller.abort(), item('in_progress')),
      'GET /api/v1/images/i/final.png/full': () => new Response(PNG),
      'PUT /api/v1/queue/default/i/2/cancel': () => item('canceled'),
    });
    await drain(createInvokeAi(invoke(), deps, POLL).generate(imageRequest({ model: 'k-sd1', count: 2, signal: controller.signal })));
    expect(calls.filter((c) => c.url.endsWith('/cancel')).map((c) => new URL(c.url).pathname)).toEqual(['/api/v1/queue/default/i/2/cancel']);
  });

  it('empties the model cache on free', async () => {
    const { deps, calls } = adapterDeps({ 'POST /api/v2/models/empty_model_cache': () => jsonResponse({}) });
    await createInvokeAi(invoke(), deps, POLL).free?.();
    expect(calls).toHaveLength(1);
  });

  it('sends the bearer token on every route of a server with accounts', async () => {
    const { deps, calls } = queue([() => item('completed', DONE)]);
    await drain(createInvokeAi(imageInstance('invokeai', 'invokeai', 'http://127.0.0.1:9090', { apiKey: 'tok' }), deps, POLL).generate(imageRequest({ model: 'k-sd1' })));
    for (const call of calls) expect(call.headers.authorization).toBe('Bearer tok');
  });
});
