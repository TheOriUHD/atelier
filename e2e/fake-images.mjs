#!/usr/bin/env node
/**
 * Scripted stand-in for an image server, for end-to-end tests and manual QA without a GPU. One port speaks three wire
 * formats: OpenAI images, ComfyUI (REST and the /ws WebSocket, with binary preview frames) and AUTOMATIC1111. What it
 * returns are real PNGs of the size asked for, each a small drawn scene that depends on the prompt.
 *
 * How a run goes is picked from words in the prompt, which read like a prompt so they can stay on screen in screenshots:
 *   "unhurried" → about 14 s with live steps and previews      "forever" → runs until it is stopped
 *   "forbidden" → the service refuses it                        "broken"  → the server answers 500
 *   "reworded"  → the service reports a revised prompt          anything else → about 2 s
 *
 * GET /__log lists the jobs it saw, oldest first: { api, model, prompt, n, size, inputs, inputBytes, stopped }.
 * POST /__reset forgets them.
 *
 * Usage: node e2e/fake-images.mjs [port=11600]
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const port = Number(process.argv[2] ?? 11600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = [];

// ------------------------------------------------------------------ PNG

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
}
/** RGB rows into a PNG. The Up filter keeps a drawn scene small: neighbouring rows are nearly the same. */
function encodePng(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 2;
    for (let x = 0; x < stride; x++) raw[at + 1 + x] = rgb[y * stride + x] - (y ? rgb[(y - 1) * stride + x] : 0);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

const hash = (text) => createHash('sha256').update(text).digest();
const mix = (a, b, t) => a + (b - a) * t;

/**
 * A dusk scene: a sky in the prompt's colours, a low sun and three ridges. Noise over it stands in for a picture still
 * being denoised, so `noise` 1 is the first preview and 0 the finished image.
 */
function scene(width, height, prompt, noise = 0) {
  const seed = hash(prompt);
  const hue = seed[0] / 255;
  const top = [mix(24, 70, hue), mix(30, 60, seed[1] / 255), mix(84, 130, seed[2] / 255)];
  const glow = [mix(240, 255, seed[3] / 255), mix(120, 190, hue), mix(90, 140, seed[4] / 255)];
  const sunX = mix(0.25, 0.75, seed[5] / 255) * width;
  const sunY = mix(0.42, 0.6, seed[6] / 255) * height;
  const sunR = Math.min(width, height) * 0.09;
  const ridges = [0, 1, 2].map((i) => ({
    base: height * (0.62 + i * 0.12),
    amplitude: height * (0.05 - i * 0.008),
    phase: seed[7 + i] / 40,
    frequency: (2 + i) / width,
    colour: [mix(52, 12, i / 2), mix(40, 12, i / 2), mix(74, 26, i / 2)],
  }));
  const rgb = Buffer.alloc(width * height * 3);
  const random = seed.readUInt32LE(8);
  let state = random || 1;
  for (let y = 0; y < height; y++) {
    const t = Math.min(1, y / (height * 0.72));
    const sky = [mix(top[0], glow[0], t * t), mix(top[1], glow[1], t * t), mix(top[2], glow[2], t * t)];
    for (let x = 0; x < width; x++) {
      let pixel = sky;
      const fromSun = Math.hypot(x - sunX, y - sunY);
      if (fromSun < sunR) pixel = [255, 244, 214];
      else if (fromSun < sunR * 3) pixel = sky.map((c, i) => mix(c, [255, 226, 180][i], ((1 - fromSun / (sunR * 3)) ** 2) * 0.55));
      for (const ridge of ridges) {
        const line = ridge.base + Math.sin(x * ridge.frequency * Math.PI + ridge.phase) * ridge.amplitude + Math.sin(x * ridge.frequency * 7 + ridge.phase * 2) * ridge.amplitude * 0.18;
        if (y >= line) pixel = ridge.colour;
      }
      const at = (y * width + x) * 3;
      if (noise > 0) {
        // A quick xorshift: repeatable, so the same prompt forms the same way.
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        const grain = ((state >>> 0) % 256) * noise;
        for (let i = 0; i < 3; i++) rgb[at + i] = Math.max(0, Math.min(255, pixel[i] * (1 - noise) + grain));
      } else for (let i = 0; i < 3; i++) rgb[at + i] = pixel[i];
    }
  }
  return encodePng(width, height, rgb);
}

const cache = new Map();
function finished(width, height, prompt) {
  const key = `${width}x${height}:${prompt}`;
  if (!cache.has(key)) cache.set(key, scene(width, height, prompt));
  return cache.get(key);
}
/** The picture at this point of the work, small as a preview is. */
function preview(width, height, prompt, fraction) {
  const scale = 192 / Math.max(width, height);
  return scene(Math.max(8, Math.round(width * scale)), Math.max(8, Math.round(height * scale)), prompt, Math.max(0, 1 - fraction * 1.15));
}

// ------------------------------------------------------------------ one job

/** How a prompt's run goes. */
function plan(prompt) {
  if (/\bforever\b/i.test(prompt)) return { steps: 600, stepMs: 200 };
  if (/\bunhurried\b/i.test(prompt)) return { steps: 28, stepMs: 500 };
  return { steps: 8, stepMs: 250 };
}

/** Runs the steps, telling `onStep` about each, until the end or until `job.stopped` is set. */
async function run(job, width, height, onStep) {
  const { steps, stepMs } = plan(job.prompt);
  for (let step = 1; step <= steps; step++) {
    await sleep(stepMs);
    if (job.stopped) return false;
    await onStep(step, steps, () => preview(width, height, job.prompt, step / steps));
  }
  return true;
}

function newJob(api, fields) {
  const job = { api, model: fields.model ?? null, prompt: fields.prompt ?? '', n: fields.n ?? 1, size: fields.size ?? null, inputs: fields.inputs ?? 0, inputBytes: fields.inputBytes ?? 0, stopped: false };
  jobs.push(job);
  return job;
}

// ------------------------------------------------------------------ HTTP helpers

const readBytes = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });
async function readJson(req) {
  const bytes = await readBytes(req);
  return bytes.length ? JSON.parse(bytes.toString()) : {};
}
const sendJson = (res, value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

/** The parts of a multipart body, by their headers; only what these routes need. */
function multipart(body, contentType) {
  const boundary = /boundary="?([^";]+)/.exec(contentType)?.[1];
  if (!boundary) return [];
  const mark = Buffer.from(`--${boundary}`);
  const parts = [];
  let at = body.indexOf(mark);
  while (at !== -1) {
    const next = body.indexOf(mark, at + mark.length);
    if (next === -1) break;
    const part = body.subarray(at + mark.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString();
    parts.push({ name: /name="([^"]+)"/.exec(head)?.[1], filename: /filename="([^"]+)"/.exec(head)?.[1], body: part.subarray(split + 4) });
    at = next;
  }
  return parts;
}

// ------------------------------------------------------------------ OpenAI images

const OPENAI_MODELS = ['gpt-image-fake', 'stable-diffusion-fake'];
const PARTIAL_EVERY_MS = 1200;
const REFUSAL = { error: { message: 'This prompt was blocked by the content policy (moderation).', type: 'invalid_request_error', code: 'moderation_blocked' } };

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(size ?? '');
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1024, height: 1024 };
}

function imageResult(job, width, height, index) {
  const prompt = index ? `${job.prompt} ${index}` : job.prompt;
  return {
    b64_json: finished(width, height, prompt).toString('base64'),
    ...(/\breworded\b/i.test(job.prompt) ? { revised_prompt: `${job.prompt}, in the evening light` } : {}),
  };
}

async function openAiImages(req, res, job, { width, height }, stream) {
  // On `res`: a request's own close comes as soon as its body has been read.
  res.once('close', () => {
    if (!res.writableFinished) job.stopped = true;
  });
  if (/\bforbidden\b/i.test(job.prompt)) return sendJson(res, REFUSAL, 400);
  if (/\bbroken\b/i.test(job.prompt)) return sendJson(res, { error: { message: 'The server fell over.', type: 'server_error' } }, 500);
  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    let partial = 0;
    const kind = job.api === 'edits' ? 'image_edit' : 'image_generation';
    const every = Math.max(1, Math.round(PARTIAL_EVERY_MS / plan(job.prompt).stepMs));
    const done = await run(job, width, height, (step, _steps, picture) => {
      if (step % every === 0) event(`${kind}.partial_image`, { b64_json: picture().toString('base64'), partial_image_index: partial++ });
    });
    if (!done) return;
    event(`${kind}.completed`, { b64_json: imageResult(job, width, height, 0).b64_json, usage: { input_tokens: 40, output_tokens: 1056 } });
    return res.end();
  }
  const done = await run(job, width, height, () => {});
  if (done) sendJson(res, { created: 1, data: Array.from({ length: job.n }, (_, i) => imageResult(job, width, height, i)) });
}

async function openAiRoutes(req, res, url) {
  if (url.pathname === '/v1/models') return sendJson(res, { object: 'list', data: OPENAI_MODELS.map((id) => ({ id, object: 'model' })) });
  if (url.pathname === '/v1/images/generations' && req.method === 'POST') {
    const body = await readJson(req);
    const job = newJob('generations', { ...body });
    return openAiImages(req, res, job, parseSize(body.size), !!body.stream);
  }
  if (url.pathname === '/v1/images/edits' && req.method === 'POST') {
    const parts = multipart(await readBytes(req), req.headers['content-type'] ?? '');
    const field = (name) => parts.find((p) => p.name === name)?.body.toString();
    const images = parts.filter((p) => p.name === 'image' || p.name === 'image[]');
    const job = newJob('edits', { model: field('model'), prompt: field('prompt'), n: Number(field('n') ?? 1), size: field('size'), inputs: images.length, inputBytes: images.reduce((sum, p) => sum + p.body.length, 0) });
    return openAiImages(req, res, job, parseSize(field('size')), field('stream') === 'true');
  }
  return false;
}

// ------------------------------------------------------------------ WebSocket (ComfyUI's /ws)

/** A server-side RFC 6455 frame: never masked. */
function wsFrame(opcode, payload) {
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : payload.length < 65536 ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => {
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(payload.length));
    return size;
  })()]);
  return Buffer.concat([head, payload]);
}

const sockets = new Map();

function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const answer = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`);
  const clientId = new URL(req.url, 'http://x').searchParams.get('clientId') ?? 'anonymous';
  const client = { text: (value) => socket.write(wsFrame(1, Buffer.from(JSON.stringify(value)))), binary: (bytes) => socket.write(wsFrame(2, bytes)) };
  sockets.set(clientId, client);
  socket.on('data', (frame) => {
    // A close from the client (opcode 8); nothing else it sends means anything here.
    if ((frame[0] & 0x0f) === 8) socket.end(wsFrame(8, Buffer.alloc(0)));
  });
  const leave = () => sockets.get(clientId) === client && sockets.delete(clientId);
  socket.on('close', leave);
  socket.on('error', leave);
  client.text({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: clientId } });
}

// ------------------------------------------------------------------ ComfyUI

const CHECKPOINTS = ['sdxl-fake.safetensors', 'flux-fake.safetensors', 'z-image-turbo-fake.safetensors'];
const OBJECT_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [CHECKPOINTS] } } },
  UNETLoader: { input: { required: { unet_name: [['flux-fake.safetensors', 'z-image-turbo-fake.safetensors'], {}], weight_dtype: [['default']] } } },
  CLIPLoader: { input: { required: { clip_name: [['t5-fake.safetensors'], {}], type: [['stable_diffusion', 'lumina2', 'flux']] } } },
  VAELoader: { input: { required: { vae_name: [['ae-fake.safetensors'], {}] } } },
  LoraLoader: { input: { required: { lora_name: [['detail-fake.safetensors'], {}] } } },
  KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m', 'dpmpp_2m_sde', 'res_multistep']], scheduler: [['normal', 'karras', 'simple']] } } },
};

const comfy = { number: 0, running: null, queue: [], history: new Map(), files: new Map() };

/** What a graph asks for: whatever node holds each input. */
function readGraph(graph) {
  const nodes = Object.values(graph ?? {});
  const input = (name) => nodes.map((n) => n.inputs?.[name]).find((v) => typeof v === 'string' || typeof v === 'number');
  const texts = nodes.filter((n) => /CLIPTextEncode/.test(n.class_type ?? '')).map((n) => n.inputs?.text).filter((t) => typeof t === 'string');
  return { prompt: texts[0] ?? '', width: Number(input('width') ?? 1024), height: Number(input('height') ?? 1024), count: Number(input('batch_size') ?? 1), steps: Number(input('steps') ?? 8), checkpoint: input('ckpt_name') ?? input('unet_name') ?? null };
}

const PREVIEW_IMAGE = 1;
const PNG_FRAME = 2;
function previewFrame(png) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(PREVIEW_IMAGE, 0);
  header.writeUInt32BE(PNG_FRAME, 4);
  return Buffer.concat([header, png]);
}

/** Runs a queued job as ComfyUI does: the nodes in turn, `progress` per step and a binary preview after each. */
async function runComfy(entry) {
  const { id, job, clientId, width, height, count } = entry;
  const client = () => sockets.get(clientId);
  const send = (type, data) => client()?.text({ type, data: { ...data, prompt_id: id } });
  comfy.running = entry;
  send('execution_start', {});
  send('executing', { node: '4' });
  await sleep(300);
  if (/\bforbidden\b|\bbroken\b/i.test(job.prompt)) {
    send('execution_error', { node_id: '3', node_type: 'KSampler', exception_message: 'CUDA out of memory.', exception_type: 'RuntimeError' });
    comfy.history.set(id, { prompt: [entry.number, id], outputs: {}, status: { status_str: 'error', completed: false, messages: [] } });
    comfy.running = null;
    return;
  }
  send('executing', { node: '3' });
  const done = await run(job, width, height, (step, steps, picture) => {
    send('progress', { value: step, max: steps, node: '3' });
    client()?.binary(previewFrame(picture()));
  });
  if (!done) {
    send('execution_interrupted', { node_id: '3', node_type: 'KSampler' });
    comfy.history.set(id, { prompt: [entry.number, id], outputs: {}, status: { status_str: 'error', completed: false, messages: [] } });
    comfy.running = null;
    return;
  }
  const images = Array.from({ length: count }, (_, i) => {
    const filename = `fake_${String(entry.number).padStart(5, '0')}_${i}.png`;
    comfy.files.set(filename, finished(width, height, i ? `${job.prompt} ${i}` : job.prompt));
    return { filename, subfolder: '', type: 'output' };
  });
  send('executing', { node: '9' });
  send('executed', { node: '9', output: { images } });
  send('execution_success', {});
  send('executing', { node: null });
  comfy.history.set(id, { prompt: [entry.number, id], outputs: { 9: { images } }, status: { status_str: 'success', completed: true, messages: [] } });
  comfy.running = null;
}

let comfyLoop = Promise.resolve();
function enqueueComfy(entry) {
  comfy.queue.push(entry);
  comfyLoop = comfyLoop.then(async () => {
    if (!comfy.queue.includes(entry)) return;
    comfy.queue.splice(comfy.queue.indexOf(entry), 1);
    await runComfy(entry);
  });
}

async function comfyRoutes(req, res, url) {
  const path = url.pathname;
  if (path === '/system_stats') return sendJson(res, { system: { os: 'posix', comfyui_version: '0.43.0', python_version: '3.12.0' }, devices: [{ name: 'fake', type: 'cuda', vram_total: 32 * 2 ** 30, vram_free: 24 * 2 ** 30 }] });
  if (path === '/object_info') return sendJson(res, OBJECT_INFO);
  if (path.startsWith('/object_info/')) {
    const name = path.slice('/object_info/'.length);
    return sendJson(res, OBJECT_INFO[name] ? { [name]: OBJECT_INFO[name] } : {});
  }
  if (path === '/userdata') return sendJson(res, []);
  if (path === '/prompt' && req.method === 'POST') {
    const body = await readJson(req);
    const graph = readGraph(body.prompt);
    const id = hash(`${Date.now()}:${comfy.number}`).toString('hex').slice(0, 32);
    const job = newJob('comfyui', { model: graph.checkpoint, prompt: graph.prompt, n: graph.count, size: `${graph.width}x${graph.height}` });
    enqueueComfy({ id, job, number: ++comfy.number, clientId: body.client_id, width: graph.width, height: graph.height, count: graph.count });
    return sendJson(res, { prompt_id: id, number: comfy.number, node_errors: {} });
  }
  if (path === '/queue' && req.method === 'GET') return sendJson(res, { queue_running: comfy.running ? [[comfy.running.number, comfy.running.id]] : [], queue_pending: comfy.queue.map((e) => [e.number, e.id]) });
  if (path === '/queue' && req.method === 'POST') {
    const body = await readJson(req);
    for (const id of body.delete ?? []) {
      const at = comfy.queue.findIndex((e) => e.id === id);
      if (at !== -1) comfy.queue.splice(at, 1)[0].job.stopped = true;
    }
    return res.writeHead(200).end();
  }
  if (path === '/interrupt' && req.method === 'POST') {
    if (comfy.running) comfy.running.job.stopped = true;
    return res.writeHead(200).end();
  }
  if (path === '/free' && req.method === 'POST') return res.writeHead(200).end();
  if (path.startsWith('/history/')) {
    const id = path.slice('/history/'.length);
    return sendJson(res, comfy.history.has(id) ? { [id]: comfy.history.get(id) } : {});
  }
  if (path === '/view') {
    const file = comfy.files.get(url.searchParams.get('filename') ?? '');
    return file ? res.writeHead(200, { 'content-type': 'image/png' }).end(file) : res.writeHead(404).end();
  }
  if (path === '/upload/image' && req.method === 'POST') {
    const parts = multipart(await readBytes(req), req.headers['content-type'] ?? '');
    const image = parts.find((p) => p.name === 'image');
    if (!image) return res.writeHead(400).end();
    comfy.files.set(image.filename, image.body);
    return sendJson(res, { name: image.filename, subfolder: '', type: 'input' });
  }
  return false;
}

// ------------------------------------------------------------------ AUTOMATIC1111

const a1111 = { state: { job: null, step: 0, steps: 0, picture: null, started: 0 } };

async function a1111Generate(req, res, api) {
  const body = await readJson(req);
  const [width, height] = [Number(body.width ?? 512), Number(body.height ?? 512)];
  const count = Number(body.batch_size ?? 1) * Number(body.n_iter ?? 1);
  const inputs = (body.init_images ?? []).length;
  const job = newJob(api, { model: body.override_settings?.sd_model_checkpoint ?? null, prompt: body.prompt ?? '', n: count, size: `${width}x${height}`, inputs, inputBytes: (body.init_images ?? []).reduce((sum, i) => sum + Buffer.from(i, 'base64').length, 0) });
  if (/\bbroken\b/i.test(job.prompt)) return sendJson(res, { error: 'RuntimeError', detail: 'The server fell over.', errors: 'CUDA out of memory.' }, 500);
  const state = a1111.state;
  Object.assign(state, { job, step: 0, steps: 0, picture: null, started: Date.now() });
  const done = await run(job, width, height, (step, steps, picture) => Object.assign(state, { step, steps, picture }));
  state.job = null;
  const seed = hash(job.prompt).readUInt32LE(0);
  if (!done) return sendJson(res, { images: [], parameters: body, info: JSON.stringify({ seed, all_seeds: [] }) });
  const images = Array.from({ length: count }, (_, i) => finished(width, height, i ? `${job.prompt} ${i}` : job.prompt).toString('base64'));
  return sendJson(res, { images, parameters: body, info: JSON.stringify({ seed, all_seeds: images.map((_, i) => seed + i) }) });
}

async function a1111Routes(req, res, url) {
  const path = url.pathname;
  if (path === '/sdapi/v1/sd-models') return sendJson(res, CHECKPOINTS.map((file) => ({ title: `${file} [abcd1234]`, model_name: file.replace(/\.safetensors$/, ''), hash: 'abcd1234', filename: `/models/${file}` })));
  if (path === '/sdapi/v1/samplers') return sendJson(res, [{ name: 'DPM++ 2M', aliases: [] }, { name: 'Euler', aliases: [] }]);
  if (path === '/sdapi/v1/schedulers') return sendJson(res, [{ name: 'karras', label: 'Karras' }, { name: 'simple', label: 'Simple' }]);
  if (path === '/sdapi/v1/loras') return sendJson(res, [{ name: 'detail-fake', alias: 'detail-fake' }]);
  if (path === '/sdapi/v1/options') return sendJson(res, { sd_model_checkpoint: `${CHECKPOINTS[0]} [abcd1234]` });
  if (path === '/sdapi/v1/txt2img' && req.method === 'POST') return a1111Generate(req, res, 'txt2img');
  if (path === '/sdapi/v1/img2img' && req.method === 'POST') return a1111Generate(req, res, 'img2img');
  if (path === '/sdapi/v1/progress') {
    const { job, step, steps, picture, started } = a1111.state;
    const fraction = steps ? step / steps : 0;
    const elapsed = (Date.now() - started) / 1000;
    return sendJson(res, { progress: job ? fraction : 0, eta_relative: job && fraction ? elapsed / fraction - elapsed : 0, state: { job_count: job ? 1 : 0, sampling_step: step, sampling_steps: steps, interrupted: !!job?.stopped }, current_image: job && picture ? picture().toString('base64') : null, textinfo: null });
  }
  if (path === '/sdapi/v1/interrupt' && req.method === 'POST') {
    if (a1111.state.job) a1111.state.job.stopped = true;
    return sendJson(res, {});
  }
  if (path === '/sdapi/v1/unload-checkpoint' && req.method === 'POST') return sendJson(res, {});
  return false;
}

// ------------------------------------------------------------------ the server

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__log') return sendJson(res, jobs);
  if (url.pathname === '/__reset' && req.method === 'POST') {
    jobs.length = 0;
    return res.writeHead(200).end();
  }
  for (const routes of [openAiRoutes, comfyRoutes, a1111Routes]) {
    const handled = await routes(req, res, url);
    if (handled !== false) return;
  }
  res.writeHead(404).end();
});
server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname === '/ws') accept(req, socket);
  else socket.destroy();
});
server.listen(port, '127.0.0.1', () => console.log(`fake images on http://127.0.0.1:${port}`));
