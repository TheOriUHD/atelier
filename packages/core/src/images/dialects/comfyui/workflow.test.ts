import { PNG as PngFile } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { ImageWorkflow, type ImageCapabilities } from '@atelier/protocol';
import { fixture, imageRequest, nodesOf, OBJECT_INFO, PNG, validateGraph } from './__fixtures__/comfy.ts';
import { detectFamily, discoverModels, sourceOf, stackFor, type ObjectInfo } from './discovery.ts';
import { buildGraph, type Graph } from './templates.ts';
import { applyWorkflow, convertFrontend, frontendNodeTypes, mapWorkflow, MAX_WORKFLOW_BYTES, pngTextChunks, readWorkflow, workflowCapabilities, workflowIdOf, workflowModelId, WorkflowRefused, workflowText } from './workflow.ts';

/** A real export: the graph ComfyUI saved into a PNG it made. */
const REAL_API = fixture<Graph>('api-z-image.json');
/** Real graphs as the ComfyUI page saves them, with their file names made neutral. */
const REAL_HIRES = fixture('frontend-hires-face.json');
const REAL_IMG2IMG = fixture('frontend-image-to-image.json');
const REAL_SUBGRAPH = fixture('frontend-subgraph.json');

/** What Save (API) writes for the default workflow. */
const STOCK: Graph = {
  3: { class_type: 'KSampler', inputs: { seed: 156680208700286, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'a landscape', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
};

const nodeInfo = async (types: string[]): Promise<ObjectInfo> => Object.fromEntries(types.flatMap((t) => (OBJECT_INFO[t] ? [[t, OBJECT_INFO[t]]] : [])));
const hires = () => convertFrontend(REAL_HIRES, OBJECT_INFO);

describe('mapWorkflow', () => {
  it('finds everything in the stock workflow', () => {
    expect(mapWorkflow(STOCK)).toEqual({
      prompt: { node: '6', input: 'text' },
      negative: { node: '7', input: 'text' },
      seed: { node: '3', input: 'seed' },
      steps: { node: '3', input: 'steps' },
      guidance: { node: '3', input: 'cfg' },
      sampler: { node: '3', input: 'sampler_name' },
      scheduler: { node: '3', input: 'scheduler' },
      width: { node: '5', input: 'width' },
      height: { node: '5', input: 'height' },
      count: { node: '5', input: 'batch_size' },
      output: '9',
    });
  });

  it('reads a graph a real server embedded in a real image', () => {
    expect(mapWorkflow(REAL_API)).toMatchObject({ prompt: { node: '5', input: 'text' }, negative: { node: '6', input: 'text' }, seed: { node: '8', input: 'seed' }, width: { node: '7', input: 'width' }, output: '10' });
  });

  it('follows two passes and a face pass back to the first pass, for the real hires workflow', () => {
    const map = mapWorkflow(hires());
    expect(map).toMatchObject({ prompt: { node: '2', input: 'text' }, negative: { node: '3', input: 'text' }, seed: { node: '5', input: 'seed' }, steps: { node: '5', input: 'steps' }, width: { node: '4', input: 'width' }, output: '7' });
  });

  it('finds the input image in the real image to image workflow, and no size to set', () => {
    const map = mapWorkflow(convertFrontend(REAL_IMG2IMG, OBJECT_INFO));
    expect(map.image).toEqual({ node: '9', input: 'image' });
    expect(map.width).toBeUndefined();
    expect(map.count).toBeUndefined();
  });

  it('finds a mask', () => {
    const graph: Graph = {
      ...STOCK,
      10: { class_type: 'LoadImage', inputs: { image: 'in.png' } },
      11: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
      12: { class_type: 'LoadImageMask', inputs: { image: 'mask.png', channel: 'red' } },
      13: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['11', 0], mask: ['12', 0] } },
      3: { class_type: 'KSampler', inputs: { ...STOCK['3']!.inputs, latent_image: ['13', 0] } },
    };
    expect(mapWorkflow(graph)).toMatchObject({ image: { node: '10', input: 'image' }, mask: { node: '12', input: 'image' } });
  });

  it('prefers the save at the end over a preview along the way', () => {
    const graph: Graph = { ...STOCK, 20: { class_type: 'PreviewImage', inputs: { images: ['8', 0] } } };
    expect(mapWorkflow(graph).output).toBe('9');
  });

  it('finds what sits around a guided sampler', () => {
    const models = discoverModels({ id: 'c', type: 'comfyui', name: 'C', baseUrl: 'http://x', headers: {}, models: [], workflows: [] }, OBJECT_INFO);
    const file = 'flux-2-klein-4b.safetensors';
    const source = sourceOf(file, OBJECT_INFO)!;
    const family = detectFamily(file, source)!;
    const capabilities = models.find((m) => m.modelId === file)!.capabilities;
    const { graph } = buildGraph({ file, source, family, stack: stackFor(family, file, source, OBJECT_INFO)!, request: imageRequest({ model: file, capabilities, tuning: capabilities.defaults ?? {} }), seed: 1, images: [], info: OBJECT_INFO });
    const map = mapWorkflow(graph);
    const classOf = (place: { node: string } | undefined) => (place ? graph[place.node]?.class_type : undefined);
    expect(classOf(map.prompt)).toBe('CLIPTextEncode');
    expect(classOf(map.seed)).toBe('RandomNoise');
    expect(classOf(map.steps)).toBe('Flux2Scheduler');
    expect(classOf(map.guidance)).toBe('CFGGuider');
    expect(classOf(map.sampler)).toBe('KSamplerSelect');
    expect(classOf(map.width)).toBe('EmptyFlux2LatentImage');
    // Its negative is the positive zeroed out, which is no prompt at all.
    expect(map.negative).toBeUndefined();
  });

  it('finds FLUX.1 guidance on its own node', () => {
    const graph: Graph = {
      ...STOCK,
      20: { class_type: 'FluxGuidance', inputs: { conditioning: ['6', 0], guidance: 3.5 } },
      3: { class_type: 'KSampler', inputs: { ...STOCK['3']!.inputs, positive: ['20', 0], cfg: 1 } },
    };
    expect(mapWorkflow(graph).guidance).toEqual({ node: '20', input: 'guidance' });
  });

  it('follows values wired to a primitive node', () => {
    const graph: Graph = {
      ...STOCK,
      20: { class_type: 'PrimitiveInt', inputs: { value: 1024 } },
      21: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'wired prompt' } },
      5: { class_type: 'EmptyLatentImage', inputs: { width: ['20', 0], height: ['20', 0], batch_size: 1 } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: ['21', 0], clip: ['4', 1] } },
    };
    expect(mapWorkflow(graph)).toMatchObject({ prompt: { node: '21', input: 'value' }, width: { node: '20', input: 'value' }, height: { node: '20', input: 'value' } });
  });

  it('reads through nodes between the sampler and the text', () => {
    const graph: Graph = {
      ...STOCK,
      20: { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['6', 0], conditioning_2: ['6', 0] } },
      3: { class_type: 'KSampler', inputs: { ...STOCK['3']!.inputs, positive: ['20', 0] } },
    };
    expect(mapWorkflow(graph).prompt).toEqual({ node: '6', input: 'text' });
  });

  it('finds no negative prompt where the negative is zeroed out, since no text there could change anything', () => {
    const graph: Graph = {
      ...STOCK,
      20: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['7', 0] } },
      3: { class_type: 'KSampler', inputs: { ...STOCK['3']!.inputs, negative: ['20', 0] } },
    };
    expect(mapWorkflow(graph).negative).toBeUndefined();
  });

  it('drops a negative that is the same text as the prompt', () => {
    const graph: Graph = { ...STOCK, 3: { class_type: 'KSampler', inputs: { ...STOCK['3']!.inputs, negative: ['6', 0] } } };
    expect(mapWorkflow(graph).negative).toBeUndefined();
  });

  it('refuses a graph with no image at the end of it', () => {
    const { 9: _save, ...rest } = STOCK;
    expect(() => mapWorkflow(rest)).toThrow(WorkflowRefused);
    expect(() => mapWorkflow(rest)).toThrow(/no SaveImage or PreviewImage/);
  });

  it('refuses a save with no sampler behind it', () => {
    expect(() => mapWorkflow({ 1: { class_type: 'LoadImage', inputs: { image: 'x' } }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0] } } })).toThrow(/no SaveImage or PreviewImage/);
  });

  it('refuses a graph whose prompt can\'t be found', () => {
    const graph: Graph = { ...STOCK, 6: { class_type: 'SomethingElse', inputs: { conditioning_seed: 5 } } };
    expect(() => mapWorkflow(graph)).toThrow(/couldn't find the prompt/);
  });

  it('survives a graph that loops back on itself', () => {
    const graph: Graph = { ...STOCK, 6: { class_type: 'Odd', inputs: { conditioning: ['7', 0] } }, 7: { class_type: 'Odd', inputs: { conditioning: ['6', 0] } } };
    expect(() => mapWorkflow(graph)).toThrow(/couldn't find the prompt/);
  });
});

describe('applyWorkflow', () => {
  const workflow = (graph: Graph = STOCK): ImageWorkflow => ({ id: 'wf', name: 'W', graph, map: mapWorkflow(graph) });
  const tuning = { steps: 11, guidance: 2.5, sampler: 'lcm', scheduler: 'karras' };

  it('puts the request into the mapped inputs', () => {
    const { graph } = applyWorkflow(workflow(), imageRequest({ prompt: 'new', negativePrompt: 'bad', width: 768, height: 512, count: 2, tuning }), 99, [], undefined);
    expect(graph['6']?.inputs.text).toBe('new');
    expect(graph['7']?.inputs.text).toBe('bad');
    expect(graph['3']?.inputs).toMatchObject({ seed: 99, steps: 11, cfg: 2.5, sampler_name: 'lcm', scheduler: 'karras' });
    expect(graph['5']?.inputs).toEqual({ width: 768, height: 512, batch_size: 2 });
  });

  it('clears the saved negative when the request has none', () => {
    expect(applyWorkflow(workflow(), imageRequest(), 1, [], undefined).graph['7']?.inputs.text).toBe('');
  });

  it('leaves the saved settings alone where the request has none', () => {
    expect(applyWorkflow(workflow(), imageRequest(), 1, [], undefined).graph['3']?.inputs).toMatchObject({ steps: 20, cfg: 8 });
  });

  it('changes a copy, never what was saved', () => {
    const saved = workflow();
    const before = JSON.stringify(saved);
    applyWorkflow(saved, imageRequest({ prompt: 'other' }), 1, [], undefined);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('turns SaveImage into PreviewImage, so a result lands in temp', () => {
    const { graph, output } = applyWorkflow(workflow(), imageRequest(), 1, [], undefined);
    expect(graph[output]).toEqual({ class_type: 'PreviewImage', inputs: { images: ['8', 0] } });
  });

  it('feeds uploaded images to the mapped inputs', () => {
    const edit = convertFrontend(REAL_IMG2IMG, OBJECT_INFO);
    expect(applyWorkflow(workflow(edit), imageRequest(), 1, ['atelier/in.png [temp]'], undefined).graph['9']?.inputs.image).toBe('atelier/in.png [temp]');
  });

  it('keeps the two copies of a FLUX.2 size in step', () => {
    const graph: Graph = {
      ...STOCK,
      5: { class_type: 'EmptyFlux2LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      20: { class_type: 'Flux2Scheduler', inputs: { steps: 4, width: 1024, height: 1024 } },
    };
    const applied = applyWorkflow(workflow(graph), imageRequest({ width: 768, height: 512 }), 1, [], undefined);
    expect(applied.graph['20']?.inputs).toMatchObject({ width: 768, height: 512 });
  });

  it('gives a graph the server would accept, for a real workflow', () => {
    const { graph } = applyWorkflow(workflow(hires()), imageRequest({ width: 832, height: 1216 }), 5, [], undefined);
    expect(validateGraph(graph)).toEqual([]);
  });
});

describe('workflowCapabilities', () => {
  const capabilities = (graph: Graph, over: Partial<ImageWorkflow> = {}): ImageCapabilities => workflowCapabilities({ id: 'wf', name: 'W', graph, map: mapWorkflow(graph), ...over });

  it('follows from what the mapping found', () => {
    expect(capabilities(STOCK)).toMatchObject({ family: 'workflow', negativePrompt: true, maxCount: 4, edit: false, mask: false, maxReferences: 0, seed: true, previews: true, tunable: true, sizes: { kind: 'free', base: 512 }, defaults: { steps: 20, guidance: 8, sampler: 'euler', scheduler: 'normal' } });
  });

  it('takes an input image when one is mapped, and one size when there is nothing to set', () => {
    expect(capabilities(convertFrontend(REAL_IMG2IMG, OBJECT_INFO))).toMatchObject({ edit: true, maxReferences: 1, maxCount: 1, sizes: { kind: 'fixed' } });
  });

  it('has no negative prompt at guidance 1, where it would do nothing', () => {
    const graph: Graph = { ...STOCK, 3: { class_type: 'KSampler', inputs: { ...STOCK['3']!.inputs, cfg: 1 } } };
    expect(capabilities(graph).negativePrompt).toBe(false);
  });

  it('lets a person override what was found', () => {
    expect(capabilities(STOCK, { capabilities: { promptStyle: 'tags', maxCount: 2 } })).toMatchObject({ promptStyle: 'tags', maxCount: 2 });
  });

  it('offers the server\'s samplers when the sampler can be set', () => {
    expect(workflowCapabilities({ id: 'wf', name: 'W', graph: STOCK, map: mapWorkflow(STOCK) }, ['euler', 'lcm']).samplers).toEqual(['euler', 'lcm']);
  });
});

describe('workflow ids', () => {
  it('reads back what it writes', () => {
    expect(workflowIdOf(workflowModelId({ id: 'wf-1' }))).toBe('wf-1');
    expect(workflowIdOf('sd_xl_base_1.0.safetensors')).toBeNull();
  });
});

describe('PNG chunks', () => {
  function pngWith(chunks: Record<string, string>): Uint8Array {
    const base = PngFile.sync.write(new PngFile({ width: 1, height: 1 }));
    const parts: Buffer[] = [base.subarray(0, 33)];
    for (const [key, value] of Object.entries(chunks)) {
      const data = Buffer.from(`${key}\0${value}`, 'latin1');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      parts.push(length, Buffer.from('tEXt'), data, Buffer.alloc(4));
    }
    parts.push(base.subarray(33));
    return new Uint8Array(Buffer.concat(parts));
  }
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  it('reads text chunks and nothing else', () => {
    expect(pngTextChunks(pngWith({ prompt: '{"a":1}', workflow: '{"b":2}', parameters: 'other' }))).toEqual({ prompt: '{"a":1}', workflow: '{"b":2}', parameters: 'other' });
  });

  it('finds none in a plain PNG', () => {
    expect(pngTextChunks(PNG)).toEqual({});
  });

  it('stops at a chunk that claims more than the file holds', () => {
    const bytes = pngWith({ prompt: 'x' });
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(33, 0xffffff);
    expect(pngTextChunks(bytes)).toEqual({});
  });

  it('refuses what isn\'t a PNG', () => {
    expect(() => pngTextChunks(new Uint8Array([0xff, 0xd8, 0xff]))).toThrow("isn't a PNG");
  });

  it('reads the workflow out of an image ComfyUI made', async () => {
    const workflow = await readWorkflow({ pngBase64: base64(pngWith({ prompt: JSON.stringify(REAL_API) })) });
    expect(workflow.map.prompt).toEqual({ node: '5', input: 'text' });
  });

  it('prefers prompt, which is already API format, over the page\'s workflow', () => {
    expect(workflowText({ pngBase64: base64(pngWith({ workflow: '{"page":1}', prompt: '{"api":1}' })) })).toBe('{"api":1}');
  });

  it('reads the page\'s workflow when that\'s all it holds', async () => {
    const png = base64(pngWith({ workflow: JSON.stringify(REAL_IMG2IMG) }));
    expect((await readWorkflow({ pngBase64: png }, nodeInfo)).map.image).toEqual({ node: '9', input: 'image' });
  });

  it('says so when a PNG holds no workflow', () => {
    expect(() => workflowText({ pngBase64: base64(PNG) })).toThrow('holds no ComfyUI workflow');
  });
});

describe('the page\'s format', () => {
  it('converts the real hires and face workflow', () => {
    const graph = hires();
    expect(Object.keys(graph).sort()).toEqual(['1', '10', '12', '13', '2', '3', '4', '5', '6', '7', '9']);
    expect(validateGraph(graph)).toEqual([]);
  });

  it('puts every value where the file\'s own names say it goes', () => {
    for (const workflow of [REAL_HIRES, REAL_IMG2IMG]) {
      const graph = convertFrontend(workflow, OBJECT_INFO);
      for (const node of workflow.nodes as { id: number; widgets_values_named?: Record<string, unknown> }[]) {
        const converted = graph[String(node.id)];
        if (!converted || !node.widgets_values_named) continue;
        const { control_after_generate: _c, upload: _u, ...named } = node.widgets_values_named;
        expect(converted.inputs).toMatchObject(named);
      }
    }
  });

  it('drops the seed\'s control value and LoadImage\'s upload value, which the server doesn\'t take', () => {
    const graph = hires();
    expect(graph['5']?.inputs).toMatchObject({ seed: 0, steps: 30, cfg: 6, denoise: 1 });
    expect(graph['13']?.inputs.steps).toBe(20);
    expect(convertFrontend(REAL_IMG2IMG, OBJECT_INFO)['9']?.inputs).toEqual({ image: '6f0f4916-debd-4991-a4ee-13c3e75f9b73.png' });
  });

  it('wires links to the right outputs, by slot', () => {
    expect(hires()['6']?.inputs).toEqual({ samples: ['10', 0], vae: ['1', 2] });
  });

  it('leaves out nodes that exist only on the page', () => {
    expect(Object.values(hires()).some((n) => n.class_type === 'MarkdownNote')).toBe(false);
  });

  it('reads the nodes a graph needs and nothing else', () => {
    expect(frontendNodeTypes(REAL_IMG2IMG).sort()).toEqual(['CLIPTextEncode', 'CheckpointLoaderSimple', 'KSampler', 'LoadImage', 'SaveImage', 'VAEDecode', 'VAEEncode']);
  });

  const page = (nodes: unknown[], links: unknown[] = []) => ({ nodes, links });
  const loader = (extra: object = {}) => ({ id: 1, type: 'CheckpointLoaderSimple', mode: 0, widgets_values: ['sd_xl_base_1.0.safetensors'], outputs: [{ links: [] }, { links: [] }, { links: [] }], ...extra });

  it('refuses a real workflow with subgraphs and says what to do', async () => {
    await expect(readWorkflow({ text: JSON.stringify(REAL_SUBGRAPH) }, nodeInfo)).rejects.toThrow(/uses subgraphs.*Save \(API\)/);
  });

  it('refuses any page-format workflow when no server can be asked, and says what to do', async () => {
    await expect(readWorkflow({ text: JSON.stringify(REAL_HIRES) })).rejects.toThrow(/format ComfyUI's page saves.*Save \(API\)/);
  });

  it('refuses a node type that isn\'t on the server', () => {
    expect(() => convertFrontend(page([{ id: 1, type: 'SomeCustomNode', mode: 0, outputs: [] }]), OBJECT_INFO)).toThrow('This server has no SomeCustomNode node');
  });

  it('refuses widget values that don\'t line up', () => {
    const tooMany = page([loader({ widgets_values: ['sd_xl_base_1.0.safetensors', 'extra'] })]);
    expect(() => convertFrontend(tooMany, OBJECT_INFO)).toThrow(/can't read the CheckpointLoaderSimple/);
    const wrongType = page([{ id: 2, type: 'EmptyLatentImage', mode: 0, widgets_values: ['wide', 512, 1], outputs: [] }]);
    expect(() => convertFrontend(wrongType, OBJECT_INFO)).toThrow(/can't read the EmptyLatentImage/);
    const tooFew = page([{ id: 3, type: 'EmptyLatentImage', mode: 0, widgets_values: [512], outputs: [] }]);
    expect(() => convertFrontend(tooFew, OBJECT_INFO)).toThrow(/can't read the EmptyLatentImage/);
  });

  it('refuses widget values stored by name, which some nodes do', () => {
    expect(() => convertFrontend(page([loader({ widgets_values: { ckpt_name: 'x' } })]), OBJECT_INFO)).toThrow(/can't read/);
  });

  it('leaves out a muted node', () => {
    expect(convertFrontend(page([loader({ mode: 2 })]), OBJECT_INFO)).toEqual({});
  });

  it('leaves out a bypassed node nothing depends on', () => {
    expect(convertFrontend(page([loader({ mode: 4 })]), OBJECT_INFO)).toEqual({});
  });

  it('refuses a bypassed node others depend on', () => {
    const graph = page([loader({ mode: 4, outputs: [{ links: [9] }] })], [[9, 1, 0, 2, 0, 'MODEL']]);
    expect(() => convertFrontend(graph, OBJECT_INFO)).toThrow(/bypassed CheckpointLoaderSimple/);
  });

  it('looks through reroutes', () => {
    const graph = convertFrontend(
      page(
        [loader({ outputs: [{ links: [] }, { links: [1] }, { links: [] }] }), { id: 2, type: 'Reroute', mode: 0, inputs: [{ name: '', link: 1 }], outputs: [{ links: [2] }] }, { id: 3, type: 'CLIPTextEncode', mode: 0, widgets_values: ['hi'], inputs: [{ name: 'clip', link: 2 }], outputs: [{ links: [] }] }],
        [[1, 1, 1, 2, 0, 'CLIP'], [2, 2, 0, 3, 0, '*']],
      ),
      OBJECT_INFO,
    );
    expect(graph['3']?.inputs).toEqual({ text: 'hi', clip: ['1', 1] });
  });

  it('turns a primitive on the page into its value', () => {
    const graph = convertFrontend(
      page(
        [{ id: 1, type: 'PrimitiveNode', mode: 0, widgets_values: [768, 'fixed'], outputs: [{ links: [1] }] }, { id: 2, type: 'EmptyLatentImage', mode: 0, widgets_values: [512, 512, 1], inputs: [{ name: 'width', link: 1, widget: { name: 'width' } }], outputs: [{ links: [] }] }],
        [[1, 1, 0, 2, 0, 'INT']],
      ),
      OBJECT_INFO,
    );
    expect(graph['2']?.inputs).toEqual({ width: 768, height: 512, batch_size: 1 });
  });

  it('reads links written as objects too', () => {
    const graph = convertFrontend(
      page(
        [loader({ outputs: [{ links: [] }, { links: [1] }, { links: [] }] }), { id: 2, type: 'CLIPTextEncode', mode: 0, widgets_values: ['hi'], inputs: [{ name: 'clip', link: 1 }], outputs: [] }],
        [{ id: 1, origin_id: 1, origin_slot: 1, target_id: 2, target_slot: 0, type: 'CLIP' }],
      ),
      OBJECT_INFO,
    );
    expect(graph['2']?.inputs.clip).toEqual(['1', 1]);
  });

  it('refuses a link that leads nowhere', () => {
    expect(() => convertFrontend(page([{ id: 2, type: 'CLIPTextEncode', mode: 0, widgets_values: ['hi'], inputs: [{ name: 'clip', link: 9 }], outputs: [] }]), OBJECT_INFO)).toThrow(/leads nowhere/);
  });
});

describe('readWorkflow', () => {
  it('makes a workflow the settings schema accepts', async () => {
    const workflow = await readWorkflow({ text: JSON.stringify(STOCK) });
    expect(ImageWorkflow.safeParse(workflow).success).toBe(true);
    expect(workflow).toMatchObject({ id: expect.stringMatching(/^wf-[0-9a-f]{12}$/), name: 'sd_xl_base_1.0 workflow', graph: STOCK });
  });

  it('gives the same graph the same id', async () => {
    expect((await readWorkflow({ text: JSON.stringify(STOCK) })).id).toBe((await readWorkflow({ text: JSON.stringify(STOCK) })).id);
  });

  it('has a name for a graph with no model file in it', async () => {
    const { 4: loader, ...rest } = STOCK;
    expect((await readWorkflow({ text: JSON.stringify({ ...rest, 4: { class_type: 'SomeLoader', inputs: loader!.inputs } }).replace('ckpt_name', 'model') })).name).toBe('Imported workflow');
  });

  it('refuses what isn\'t JSON', async () => {
    await expect(readWorkflow({ text: 'not json' })).rejects.toThrow("isn't valid JSON");
    await expect(readWorkflow({ text: '[1,2]' })).rejects.toThrow("isn't valid JSON");
  });

  it('refuses JSON that isn\'t a workflow', async () => {
    await expect(readWorkflow({ text: '{"hello":"world"}' })).rejects.toThrow("isn't a ComfyUI workflow");
    await expect(readWorkflow({ text: '{}' })).rejects.toThrow("isn't a ComfyUI workflow");
  });

  it('refuses anything over 256 KB', async () => {
    await expect(readWorkflow({ text: `{"x":"${'a'.repeat(MAX_WORKFLOW_BYTES)}"}` })).rejects.toThrow('256 KB');
  });

  it('asks for something to read', async () => {
    await expect(readWorkflow({})).rejects.toThrow('Choose a workflow file');
  });

  it('keeps a real page workflow\'s nodes as it found them', async () => {
    const workflow = await readWorkflow({ text: JSON.stringify(REAL_HIRES) }, nodeInfo);
    expect(nodesOf(workflow.graph as Graph, 'FaceDetailer')).toHaveLength(1);
    expect(workflow.map.output).toBe('7');
  });
});
