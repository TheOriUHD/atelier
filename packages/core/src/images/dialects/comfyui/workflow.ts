/**
 * Workflows people bring: API-format JSON, a PNG holding one, or a flat graph as the ComfyUI page saves it.
 * `mapWorkflow` follows the sampler's links to find what Atelier can set; a person can correct that before saving.
 * A graph from the page is only converted when every value lands in a known input, because a guess there would quietly
 * send a different workflow than the one they saved.
 */
import { createHash } from 'node:crypto';
import type { ImageCapabilities, ImageWorkflow, ImageWorkflowInput } from '@atelier/protocol';
import { arr, isRecord, num, rec, str, strings } from '../../../providers/util.ts';
import type { ImageRequest } from '../../types.ts';
import type { NodeInfo, ObjectInfo } from './discovery.ts';
import type { Graph, GraphNode, GraphPlan, Link } from './templates.ts';
import { hostedVideo } from '../video-common.ts';

export const MAX_WORKFLOW_BYTES = 256 * 1024;

const SAVE_API = 'In ComfyUI, turn on Dev mode in its settings if you need to, and use Save (API).';

/** A workflow that can't be used, and why; the message is for the person. */
export class WorkflowRefused extends Error {}

const WORKFLOW_PREFIX = 'workflow:';
export const workflowModelId = (workflow: Pick<ImageWorkflow, 'id'>): string => `${WORKFLOW_PREFIX}${workflow.id}`;
export const workflowIdOf = (modelId: string): string | null => (modelId.startsWith(WORKFLOW_PREFIX) ? modelId.slice(WORKFLOW_PREFIX.length) : null);

const isLink = (value: unknown): value is Link => Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number') && typeof value[1] === 'number';
const linkId = (value: Link): string => String(value[0]);

const SAMPLER = /KSampler(?!Select)|SamplerCustom/;
const SAVES_IMAGE = /^(Save|Preview)Image/;
/** The nodes that write a clip Atelier can keep: MP4 or WebM. Animated WebP and PNG are pictures, which it doesn't take as video. */
const SAVES_VIDEO = /^(?:SaveVideo|SaveWEBM|VHS_VideoCombine)$/;
/** Nodes that make a video's latent from words or a picture: they hold its size and its frame count (`length`). */
const VIDEO_LATENT = /ToVideo$|^Empty.*LatentVideo$/;
/** Where the frame rate lives. */
const FPS_INPUT: Record<string, string> = { CreateVideo: 'fps', SaveWEBM: 'fps', VHS_VideoCombine: 'frame_rate' };
const EMPTY_LATENT = /^Empty.*Latent/;
/** Inputs that carry a model or an image, never the conditioning a prompt lives in. */
const NOT_CONDITIONING = new Set(['clip', 'model', 'vae', 'control_net', 'image', 'pixels', 'latent', 'samples', 'style_model', 'clip_vision']);
const TEXT_INPUTS = ['text', 'prompt', 'text_g', 'value', 'string'];

function inputsOf(graph: Graph, id: string): Record<string, unknown> {
  return graph[id]?.inputs ?? {};
}

/** Every node a node depends on, nearest first. */
function ancestors(graph: Graph, start: string): string[] {
  const seen = new Set([start]);
  const order: string[] = [];
  const queue = [start];
  while (queue.length) {
    for (const value of Object.values(inputsOf(graph, queue.shift()!))) {
      if (!isLink(value) || seen.has(linkId(value)) || !graph[linkId(value)]) continue;
      seen.add(linkId(value));
      order.push(linkId(value));
      queue.push(linkId(value));
    }
  }
  return order;
}

/** Where a value is really set: following links to a primitive node, for inputs that are wired to one. */
function literal(graph: Graph, node: string, input: string, depth = 0): ImageWorkflowInput | null {
  const value = inputsOf(graph, node)[input];
  if (value === undefined || depth > 8) return null;
  if (!isLink(value)) return { node, input };
  const source = linkId(value);
  const holder = ['value', 'seed', 'int', 'float', 'number', 'string', 'text'].find((name) => inputsOf(graph, source)[name] !== undefined);
  return holder ? literal(graph, source, holder, depth + 1) : null;
}

function firstLiteral(graph: Graph, node: string, inputs: readonly string[]): ImageWorkflowInput | undefined {
  for (const input of inputs) {
    const found = literal(graph, node, input);
    if (found) return found;
  }
  return undefined;
}

/** The text a conditioning link comes from. A zeroed-out conditioning has no text of its own. */
function traceText(graph: Graph, link: unknown, want: 'positive' | 'negative', seen = new Set<string>()): ImageWorkflowInput | null {
  if (!isLink(link)) return null;
  const id = linkId(link);
  const node = graph[id];
  if (!node || seen.has(id) || node.class_type === 'ConditioningZeroOut') return null;
  seen.add(id);
  const text = TEXT_INPUTS.map((name) => literal(graph, id, name)).find((found) => found && typeof inputsOf(graph, found.node)[found.input] === 'string');
  if (text) return text;
  // A node that passes both conditionings on (the video nodes do) is followed through the input of the kind being traced.
  for (const [name, value] of Object.entries(node.inputs).sort(([a], [b]) => Number(b === want) - Number(a === want))) {
    if (NOT_CONDITIONING.has(name)) continue;
    const found = traceText(graph, value, want, seen);
    if (found) return found;
  }
  return null;
}

function linkedNode(graph: Graph, node: string, input: string): string | undefined {
  const value = inputsOf(graph, node)[input];
  return isLink(value) && graph[linkId(value)] ? linkId(value) : undefined;
}

/** Walks back along latents from the sampler nearest the output to the first, which started from the empty or input image. */
function firstPass(graph: Graph, last: string): { sampler: string; latent?: string } {
  let sampler = last;
  const seen = new Set<string>();
  let current = linkedNode(graph, sampler, 'latent_image');
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = graph[current]!;
    if (SAMPLER.test(node.class_type)) {
      sampler = current;
      current = linkedNode(graph, current, 'latent_image');
    } else if (EMPTY_LATENT.test(node.class_type) || VIDEO_LATENT.test(node.class_type) || node.class_type === 'VAEEncode') return { sampler, latent: current };
    else current = linkedNode(graph, current, 'samples') ?? linkedNode(graph, current, 'latent') ?? linkedNode(graph, current, 'latent_image');
  }
  return { sampler };
}

/** A guided sampler keeps its settings on the nodes around it. */
function samplerSettings(graph: Graph, sampler: string) {
  const guider = linkedNode(graph, sampler, 'guider');
  const noise = linkedNode(graph, sampler, 'noise');
  const picker = linkedNode(graph, sampler, 'sampler');
  const sigmas = linkedNode(graph, sampler, 'sigmas');
  const flux = ancestors(graph, sampler).find((id) => graph[id]?.class_type === 'FluxGuidance');
  return {
    seed: firstLiteral(graph, sampler, ['seed', 'noise_seed']) ?? (noise ? firstLiteral(graph, noise, ['noise_seed', 'seed']) : undefined),
    steps: firstLiteral(graph, sampler, ['steps']) ?? (sigmas ? firstLiteral(graph, sigmas, ['steps']) : undefined),
    guidance: (flux ? firstLiteral(graph, flux, ['guidance']) : undefined) ?? firstLiteral(graph, sampler, ['cfg']) ?? (guider ? firstLiteral(graph, guider, ['cfg']) : undefined),
    sampler: firstLiteral(graph, sampler, ['sampler_name']) ?? (picker ? firstLiteral(graph, picker, ['sampler_name']) : undefined),
    scheduler: firstLiteral(graph, sampler, ['scheduler']) ?? (sigmas ? firstLiteral(graph, sigmas, ['scheduler']) : undefined),
    positive: inputsOf(graph, sampler).positive ?? inputsOf(graph, guider ?? '').positive ?? inputsOf(graph, guider ?? '').conditioning,
    negative: inputsOf(graph, sampler).negative ?? inputsOf(graph, guider ?? '').negative,
  };
}

/** The node that makes the result: a save over a preview, and the one with the most sampling behind it. */
function findOutput(graph: Graph): string | null {
  const score = (id: string) => ancestors(graph, id).filter((a) => SAMPLER.test(graph[a]!.class_type)).length * 2 + (graph[id]!.class_type.startsWith('Save') ? 1 : 0);
  const outputs = Object.keys(graph).filter((id) => (SAVES_IMAGE.test(graph[id]!.class_type) || SAVES_VIDEO.test(graph[id]!.class_type)) && ancestors(graph, id).some((a) => SAMPLER.test(graph[a]!.class_type)));
  return outputs.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The `LoadImage` behind a node's input, through any scaling or cropping on the way. */
function loaderBehind(graph: Graph, node: string, input: string): string | undefined {
  const source = linkedNode(graph, node, input);
  if (!source) return undefined;
  return [source, ...ancestors(graph, source)].find((id) => graph[id]!.class_type === 'LoadImage');
}

/** What Atelier can set in a graph, found by following the links back from its output. Throws when there's no prompt. */
export function mapWorkflow(graph: Graph): ImageWorkflow['map'] {
  const output = findOutput(graph);
  if (!output) throw new WorkflowRefused("This workflow has no SaveImage, PreviewImage, SaveVideo, SaveWEBM or VHS_VideoCombine after a sampler, so there's no result to take from it.");
  const upstream = ancestors(graph, output);
  const last = upstream.find((id) => SAMPLER.test(graph[id]!.class_type))!;
  const { sampler, latent } = firstPass(graph, last);
  const settings = samplerSettings(graph, sampler);
  const prompt = traceText(graph, settings.positive, 'positive');
  if (!prompt) throw new WorkflowRefused("Atelier couldn't find the prompt in this workflow: nothing with text leads to the sampler's positive input.");
  const found = traceText(graph, settings.negative, 'negative');
  const negative = found && (found.node !== prompt.node || found.input !== prompt.input) ? found : undefined;
  const video = SAVES_VIDEO.test(graph[output]!.class_type);
  const empty = latent && (EMPTY_LATENT.test(graph[latent]!.class_type) || VIDEO_LATENT.test(graph[latent]!.class_type)) ? latent : undefined;
  // A video's first and last picture are two loaders: the one behind `start_image` is the start, the one behind `end_image` the end.
  const end = video && empty ? loaderBehind(graph, empty, 'end_image') : undefined;
  const start = video && empty ? loaderBehind(graph, empty, 'start_image') : undefined;
  const image = start ?? upstream.find((id) => graph[id]!.class_type === 'LoadImage' && id !== end);
  const mask = upstream.find((id) => graph[id]!.class_type === 'LoadImageMask');
  const width = empty ? (literal(graph, empty, 'width') ?? undefined) : undefined;
  const height = empty ? (literal(graph, empty, 'height') ?? undefined) : undefined;
  const count = empty && !video ? (literal(graph, empty, 'batch_size') ?? undefined) : undefined;
  const frames = video && empty ? (literal(graph, empty, 'length') ?? literal(graph, empty, 'frames') ?? undefined) : undefined;
  const rateNode = video ? [output, ...upstream].find((id) => FPS_INPUT[graph[id]!.class_type]) : undefined;
  const fps = rateNode ? (literal(graph, rateNode, FPS_INPUT[graph[rateNode]!.class_type]!) ?? undefined) : undefined;
  const optional = { negative, seed: settings.seed, steps: settings.steps, guidance: settings.guidance, sampler: settings.sampler, scheduler: settings.scheduler, width, height, count, frames, fps, ...(image ? { image: { node: image, input: 'image' } } : {}), ...(end ? { endImage: { node: end, input: 'image' } } : {}), ...(mask ? { mask: { node: mask, input: 'image' } } : {}) };
  return { prompt, output, ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)) };
}

const valueAt = (graph: ImageWorkflow['graph'], place: ImageWorkflowInput | undefined): unknown => (place ? rec(rec(graph[place.node]).inputs)[place.input] : undefined);

/** A workflow as a model: what it can do follows from what the mapping found, and a person can override that. */
export function workflowCapabilities(workflow: ImageWorkflow, samplers: readonly string[] = []): ImageCapabilities {
  const { map, graph } = workflow;
  const width = num(valueAt(graph, map.width));
  const height = num(valueAt(graph, map.height));
  const guidance = num(valueAt(graph, map.guidance));
  const steps = num(valueAt(graph, map.steps));
  const sampler = str(valueAt(graph, map.sampler));
  const scheduler = str(valueAt(graph, map.scheduler));
  const base = width && height ? Math.max(width, height) : 1024;
  if (SAVES_VIDEO.test(str(rec(graph[map.output ?? '']).class_type) ?? '')) return videoWorkflowCapabilities(workflow, { width, height, steps, guidance });
  const sizes: ImageCapabilities['sizes'] = map.width && map.height ? { kind: 'free', min: 256, max: 2048, multiple: 16, base } : { kind: 'fixed', list: [{ width: width ?? 1024, height: height ?? 1024 }] };
  return {
    family: 'workflow',
    promptStyle: 'natural',
    negativePrompt: !!map.negative && (guidance === undefined || guidance > 1),
    sizes,
    maxCount: map.count ? 4 : 1,
    edit: !!map.image,
    mask: !!map.mask,
    maxReferences: map.image ? 1 : 0,
    transparent: false,
    seed: !!map.seed,
    previews: true,
    tunable: !!(map.steps || map.guidance || map.sampler || map.scheduler),
    defaults: { ...(steps !== undefined ? { steps } : {}), ...(guidance !== undefined ? { guidance } : {}), ...(sampler ? { sampler } : {}), ...(scheduler ? { scheduler } : {}) },
    ...(samplers.length && map.sampler ? { samplers: [...samplers] } : {}),
    ...workflow.capabilities,
  };
}

/** Which channel the workflow's mask node reads: `red` (white changes, as in our templates) unless it says `alpha`. */
export function maskChannel(workflow: ImageWorkflow): 'red' | 'alpha' {
  const place = workflow.map.mask;
  return place && rec(rec(workflow.graph[place.node]).inputs).channel === 'alpha' ? 'alpha' : 'red';
}

/** Longest clip a workflow is offered for: its own length is where it starts, and these are models trained on a few seconds. */
const WORKFLOW_MAX_SECONDS = 10;

/** A workflow that makes a clip as a model: its length and frame rate are what the graph holds. */
function videoWorkflowCapabilities(workflow: ImageWorkflow, found: { width: number | undefined; height: number | undefined; steps: number | undefined; guidance: number | undefined }): ImageCapabilities {
  const { map, graph } = workflow;
  const frames = num(valueAt(graph, map.frames));
  const fps = num(valueAt(graph, map.fps)) ?? 24;
  const seconds = frames ? Math.min(WORKFLOW_MAX_SECONDS, Math.max(1, Math.round(frames / fps))) : 4;
  const side = found.width && found.height ? Math.max(found.width, found.height) : 832;
  return {
    ...hostedVideo({
      family: 'workflow-video',
      ratios: [],
      durations: { kind: 'range', min: 1, max: WORKFLOW_MAX_SECONDS, step: 1 },
      defaultSeconds: seconds,
      defaultFps: Math.round(fps),
      firstFrame: !!map.image,
      lastFrame: !!map.endImage,
      // A graph with a picture loader would use the picture it was saved with: say a clip needs one rather than send that.
      firstFrameRequired: !!map.image,
      audio: 'none',
      seed: !!map.seed,
      negativePrompt: !!map.negative && (found.guidance === undefined || found.guidance > 1),
    }),
    sizes: map.width && map.height ? { kind: 'free', min: 256, max: 1920, multiple: 16, base: side } : { kind: 'fixed', list: [{ width: found.width ?? 832, height: found.height ?? 480 }] },
    previews: true,
    ...workflow.capabilities,
  };
}

/** Frames for a length, in the counts each family makes: Wan and Hunyuan 4n+1, LTX-V 8n+1, Mochi 6n+1. */
export function frameCount(classType: string | undefined, seconds: number, fps: number): number {
  const wanted = Math.max(1, Math.round(seconds * fps));
  const step = /Wan|Hunyuan/.test(classType ?? '') ? 4 : /LTXV/.test(classType ?? '') ? 8 : /Mochi/.test(classType ?? '') ? 6 : 1;
  return step === 1 ? wanted : Math.max(1, Math.round((wanted - 1) / step)) * step + 1;
}

/** The workflow's graph with this request's values in it. The original stays as it was saved. */
export function applyWorkflow(workflow: ImageWorkflow, request: ImageRequest, seed: number, images: readonly string[], mask: string | undefined, endImage?: string): GraphPlan {
  const graph = structuredClone(workflow.graph) as Graph;
  const { map } = workflow;
  const put = (place: ImageWorkflowInput | undefined, value: unknown) => {
    const node = place ? graph[place.node] : undefined;
    if (place && node && value !== undefined) node.inputs[place.input] = value;
  };
  put(map.prompt, request.prompt);
  put(map.negative, request.negativePrompt ?? '');
  put(map.seed, seed);
  put(map.steps, request.tuning.steps);
  put(map.guidance, request.tuning.guidance);
  put(map.sampler, request.tuning.sampler);
  put(map.scheduler, request.tuning.scheduler);
  put(map.width, request.width);
  put(map.height, request.height);
  put(map.count, request.count);
  put(map.image, images[0]);
  put(map.mask, mask);
  put(map.endImage, endImage);
  if (request.video) {
    const fps = request.video.fps ?? num(valueAt(workflow.graph, map.fps)) ?? 24;
    put(map.fps, fps);
    put(map.frames, frameCount(map.frames ? graph[map.frames.node]?.class_type : undefined, request.video.seconds, fps));
  }
  for (const node of Object.values(graph)) {
    // Its size is a second copy of the latent's, and the two have to agree.
    if (node.class_type === 'Flux2Scheduler') {
      if (request.width && !isLink(node.inputs.width)) node.inputs.width = request.width;
      if (request.height && !isLink(node.inputs.height)) node.inputs.height = request.height;
    }
    // Atelier stores the result itself: a save would leave a second copy in the person's output folder.
    if (node.class_type === 'SaveImage') {
      node.class_type = 'PreviewImage';
      delete node.inputs.filename_prefix;
    }
  }
  return { graph, output: map.output ?? '', samplers: [] };
}

// ---------------------------------------------------------------------- PNG

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's `tEXt` chunks by keyword: ComfyUI keeps `prompt` (API format) and `workflow` (the page's) there. */
export function pngTextChunks(bytes: Uint8Array): Record<string, string> {
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) throw new WorkflowRefused("That file isn't a PNG.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = new TextDecoder('latin1');
  const found: Record<string, string> = {};
  for (let at = PNG_SIGNATURE.length; at + 12 <= bytes.byteLength; ) {
    const length = view.getUint32(at);
    const type = latin1.decode(bytes.subarray(at + 4, at + 8));
    const end = at + 8 + length;
    if (end > bytes.byteLength) break;
    if (type === 'IEND') break;
    if (type === 'tEXt') {
      const chunk = bytes.subarray(at + 8, end);
      const zero = chunk.indexOf(0);
      if (zero > 0) found[latin1.decode(chunk.subarray(0, zero))] = latin1.decode(chunk.subarray(zero + 1));
    }
    at = end + 4;
  }
  return found;
}

// ---------------------------------------------------------------- the page's format

const isFrontend = (value: Record<string, unknown>) => Array.isArray(value.nodes) && Array.isArray(value.links);
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize']);
/** What the page adds and the server never sees. */
const PAGE_ONLY = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode']);
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
const MUTED = 2;
const BYPASSED = 4;

interface FrontendNode {
  id: number;
  type: string;
  mode: number;
  values: unknown;
  inputs: { name: string; link: number | null; widget: boolean }[];
  outputs: { links: unknown[] }[];
}

interface FrontendLink {
  from: number;
  slot: number;
}

function frontendLinks(value: unknown): Map<number, FrontendLink> {
  const links = new Map<number, FrontendLink>();
  for (const link of arr(value)) {
    if (Array.isArray(link)) links.set(Number(link[0]), { from: Number(link[1]), slot: Number(link[2]) });
    else {
      const entry = rec(link);
      links.set(Number(entry.id), { from: Number(entry.origin_id), slot: Number(entry.origin_slot) });
    }
  }
  return links;
}

function frontendNode(value: unknown): FrontendNode {
  const node = rec(value);
  return {
    id: Number(node.id),
    type: str(node.type) ?? '',
    mode: num(node.mode) ?? 0,
    values: node.widgets_values,
    inputs: arr(node.inputs).map((i) => {
      const input = rec(i);
      return { name: str(input.name) ?? '', link: num(input.link) ?? null, widget: input.widget !== undefined };
    }),
    outputs: arr(node.outputs).map((o) => ({ links: arr(rec(o).links) })),
  };
}

const isUuid = (type: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(type);

/** The node types a page graph needs, to read just those from the server. */
export function frontendNodeTypes(workflow: Record<string, unknown>): string[] {
  return [...new Set(arr(workflow.nodes).map((n) => str(rec(n).type) ?? ''))].filter((type) => type && !PAGE_ONLY.has(type) && !isUuid(type));
}

interface WidgetInput {
  name: string;
  type: string;
  options: Record<string, unknown>;
}

/** A node's widget inputs in the order the page stores them, which is the order `/object_info` lists them in. */
function widgetInputs(info: NodeInfo): WidgetInput[] {
  const inputs = rec(info.input);
  const order = rec(info.input_order);
  const names = [...(strings(order.required).length ? strings(order.required) : Object.keys(rec(inputs.required))), ...(strings(order.optional).length ? strings(order.optional) : Object.keys(rec(inputs.optional)))];
  return names.flatMap((name) => {
    const spec = rec(inputs.required)[name] ?? rec(inputs.optional)[name];
    if (!Array.isArray(spec)) return [];
    const options = rec(spec[1]);
    const type = Array.isArray(spec[0]) ? 'COMBO' : str(spec[0]) ?? '';
    return WIDGET_TYPES.has(type) && !options.forceInput ? [{ name, type, options }] : [];
  });
}

const hasControl = (input: WidgetInput) => input.options.control_after_generate === true || (input.type === 'INT' && (input.name === 'seed' || input.name === 'noise_seed'));

function fitsType(value: unknown, type: string): boolean {
  if (type === 'INT' || type === 'FLOAT') return typeof value === 'number';
  if (type === 'BOOLEAN') return typeof value === 'boolean';
  return typeof value === 'string';
}

/** Lays a node's stored widget values out on its input names, and refuses if they don't line up exactly. */
function widgetValues(node: FrontendNode, info: NodeInfo): Record<string, unknown> {
  const refused = () => new WorkflowRefused(`Atelier can't read the ${node.type} node's settings reliably. ${SAVE_API}`);
  if (node.values !== undefined && !Array.isArray(node.values)) throw refused();
  const stored = (node.values as unknown[] | undefined) ?? [];
  const inputs: Record<string, unknown> = {};
  let at = 0;
  for (const input of widgetInputs(info)) {
    if (at >= stored.length) {
      // Only the optional ones may be missing: a node saved before they were added.
      if (rec(rec(info.input).required)[input.name] !== undefined) throw refused();
      continue;
    }
    const value = stored[at++];
    if (!fitsType(value, input.type)) throw refused();
    inputs[input.name] = value;
    if (hasControl(input) && CONTROL_VALUES.has(stored[at] as string)) at++;
    if (input.options.image_upload && stored[at] === 'image') at++;
  }
  if (at !== stored.length) throw refused();
  return inputs;
}

/** Turns a flat graph as the page saves it into API format, using the server's own idea of each node. */
export function convertFrontend(workflow: Record<string, unknown>, info: ObjectInfo): Graph {
  const subgraphs = arr(rec(workflow.definitions).subgraphs);
  const nodes = arr(workflow.nodes).map(frontendNode);
  if (subgraphs.length > 0 || nodes.some((n) => isUuid(n.type))) throw new WorkflowRefused(`This workflow uses subgraphs, which Atelier can't convert. ${SAVE_API}`);
  const links = frontendLinks(workflow.links);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const unused = (n: FrontendNode) => n.outputs.every((o) => o.links.length === 0);
  const running = nodes.filter((n) => !PAGE_ONLY.has(n.type) && n.mode !== MUTED && !(n.mode === BYPASSED && unused(n)));
  for (const n of running) {
    if (n.mode !== 0) throw new WorkflowRefused(`This workflow has a bypassed ${n.type} node that others depend on. ${SAVE_API}`);
    if (!info[n.type]) throw new WorkflowRefused(`This server has no ${n.type} node, which this workflow needs.`);
  }

  /** What a wire carries: reroutes are looked through, and a page-only primitive is just its value. */
  const resolve = (linkId: number): { link: Link } | { value: unknown } | null => {
    let current = links.get(linkId);
    for (let hops = 0; current && hops < 100; hops++) {
      const origin = byId.get(current.from);
      if (!origin) return null;
      if (origin.type === 'PrimitiveNode') return { value: arr(origin.values)[0] };
      if (origin.type !== 'Reroute') return { link: [String(origin.id), current.slot] };
      const through = origin.inputs[0]?.link;
      current = through === undefined || through === null ? undefined : links.get(through);
    }
    return null;
  };

  const graph: Graph = {};
  for (const n of running) {
    const inputs = widgetValues(n, info[n.type]!);
    for (const input of n.inputs) {
      if (input.link === null) continue;
      const wired = resolve(input.link);
      if (!wired) throw new WorkflowRefused(`A link into the ${n.type} node leads nowhere. ${SAVE_API}`);
      inputs[input.name] = 'link' in wired ? wired.link : wired.value;
    }
    const node: GraphNode = { class_type: n.type, inputs };
    graph[String(n.id)] = node;
  }
  return graph;
}

// ---------------------------------------------------------------------- reading

export interface WorkflowSource {
  text?: string | undefined;
  pngBase64?: string | undefined;
}

function checkApiGraph(value: Record<string, unknown>): Graph {
  const entries = Object.values(value);
  if (entries.length === 0 || !entries.every((n) => isRecord(n) && typeof n.class_type === 'string' && isRecord(n.inputs))) throw new WorkflowRefused(`That isn't a ComfyUI workflow in API format. ${SAVE_API}`);
  return value as unknown as Graph;
}

function parseJson(text: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_BYTES) throw new WorkflowRefused('That workflow is larger than 256 KB.');
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch {
    // Reported below.
  }
  throw new WorkflowRefused("That isn't valid JSON.");
}

/** The JSON a source holds: the file itself, or a PNG's `prompt` first since that's already API format. */
export function workflowText(source: WorkflowSource): string {
  if (source.text !== undefined) return source.text;
  if (source.pngBase64 === undefined) throw new WorkflowRefused('Choose a workflow file, or a PNG that ComfyUI made.');
  const chunks = pngTextChunks(Buffer.from(source.pngBase64, 'base64'));
  const text = chunks.prompt ?? chunks.workflow;
  if (!text) throw new WorkflowRefused('This PNG holds no ComfyUI workflow. Images that went through another program often lose it.');
  return text;
}

function workflowName(graph: Graph): string {
  for (const node of Object.values(graph)) {
    const file = str(node.inputs.ckpt_name) ?? str(node.inputs.unet_name);
    if (file) return `${(file.split(/[/\\]/).pop() ?? file).replace(/\.\w+$/, '')} workflow`.slice(0, 100);
  }
  return 'Imported workflow';
}

/**
 * Reads a workflow in any form it comes in. `nodes` loads the entries a page graph needs from the server; without
 * it there's nothing to read widget values against, so a page graph is refused.
 */
export async function readWorkflow(source: WorkflowSource, nodes?: (types: string[]) => Promise<ObjectInfo>): Promise<ImageWorkflow> {
  const value = parseJson(workflowText(source));
  let graph: Graph;
  if (isFrontend(value)) {
    if (!nodes) throw new WorkflowRefused(`This workflow is in the format ComfyUI's page saves. ${SAVE_API}`);
    graph = convertFrontend(value, await nodes(frontendNodeTypes(value)));
  } else graph = checkApiGraph(value);
  const map = mapWorkflow(graph);
  const id = `wf-${createHash('sha256').update(JSON.stringify(graph)).digest('hex').slice(0, 12)}`;
  return { id, name: workflowName(graph), graph, map };
}
