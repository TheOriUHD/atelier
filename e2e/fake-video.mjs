#!/usr/bin/env node
/**
 * Scripted stand-in for a video service, for end-to-end tests and manual QA without a GPU or a key. It speaks OpenRouter's
 * video API (list models, submit, poll, download with the key), and what it makes is a real WebM (VP8, 640×360, 3 s, made
 * once with ffmpeg and kept in e2e/assets) or, when the prompt says "mp4", the small MP4 with sound from the core tests.
 *
 * How a run goes is picked from words in the prompt, which read like a prompt so they can stay on screen in screenshots:
 *   "unhurried" → about 14 s in the queue and at work       "forever" → never finishes (until the test stops waiting)
 *   "forbidden" → the service turns the prompt down          "broken"  → the server answers 500
 *   "faulty"    → the job starts, then fails                 "mp4"     → an MP4 with sound instead of a WebM
 *   "garbage"   → the download is not a video at all         anything else → about 3 s
 *
 * GET /__log lists the jobs it saw, oldest first: { model, prompt, duration, resolution, aspectRatio, frames, audio, seed, polls, downloaded }.
 * POST /__reset forgets them.
 *
 * Usage: node e2e/fake-video.mjs [port=11620]
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 11620);
const WEBM = readFileSync(new URL('./assets/dusk.webm', import.meta.url));
const MP4 = readFileSync(new URL('../packages/core/src/images/__fixtures__/tiny.mp4', import.meta.url));
const jobs = [];

const MODELS = [
  {
    id: 'fake/dusk',
    name: 'Fake Dusk',
    description: 'Scripted: a gradient at dusk',
    supported_resolutions: ['480p', '720p'],
    supported_aspect_ratios: ['16:9', '9:16', '1:1'],
    supported_sizes: null,
    supported_durations: [3, 5, 8],
    supported_frame_images: ['first_frame'],
    generate_audio: false,
    seed: true,
    pricing_skus: {},
    allowed_passthrough_parameters: [],
  },
  {
    id: 'fake/animator',
    name: 'Fake Animator',
    description: 'Scripted: only from a picture',
    supported_resolutions: ['720p'],
    supported_aspect_ratios: ['16:9'],
    supported_sizes: null,
    supported_durations: [4],
    supported_frame_images: ['first_frame', 'last_frame'],
    generate_audio: true,
    seed: false,
    pricing_skus: {},
    allowed_passthrough_parameters: [],
  },
];

const json = (res, value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const body = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}));
  });

/** Seconds a job spends queued, and then working, from its prompt. */
function plan(prompt) {
  if (/\bforever\b/i.test(prompt)) return { queued: 2, working: 1e9 };
  if (/\bunhurried\b/i.test(prompt)) return { queued: 4, working: 10 };
  return { queued: 1, working: 2 };
}

function state(job) {
  const seconds = (Date.now() - job.startedAt) / 1000;
  const { queued, working } = plan(job.prompt);
  if (/\bfaulty\b/i.test(job.prompt) && seconds > queued) return 'failed';
  if (seconds < queued) return 'pending';
  return seconds < queued + working ? 'in_progress' : 'completed';
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const key = req.headers.authorization;
  if (url.pathname === '/__log') return json(res, jobs.map(({ startedAt: _s, ...job }) => job));
  if (url.pathname === '/__reset') return jobs.splice(0), json(res, { ok: true });

  if (req.method === 'GET' && url.pathname === '/api/v1/videos/models') return json(res, { data: MODELS });

  if (req.method === 'POST' && url.pathname === '/api/v1/videos') {
    const input = await body(req);
    const prompt = String(input.prompt ?? '');
    if (/\bbroken\b/i.test(prompt)) return json(res, { error: { message: 'The server is having trouble.' } }, 500);
    if (/\bforbidden\b/i.test(prompt)) return json(res, { error: { message: 'This prompt was blocked by content moderation.' } }, 400);
    const job = {
      id: randomUUID(),
      model: input.model ?? null,
      prompt,
      duration: input.duration ?? null,
      resolution: input.resolution ?? null,
      aspectRatio: input.aspect_ratio ?? null,
      frames: (input.frame_images ?? []).map((f) => f.frame_type),
      audio: input.generate_audio ?? null,
      seed: input.seed ?? null,
      polls: 0,
      downloaded: 0,
      keyOk: true,
      startedAt: Date.now(),
    };
    jobs.push(job);
    return json(res, { id: job.id, polling_url: `http://127.0.0.1:${port}/api/v1/videos/${job.id}`, status: 'pending' }, 202);
  }

  const match = /^\/api\/v1\/videos\/([0-9a-f-]+)(\/content)?$/.exec(url.pathname);
  const job = match && jobs.find((j) => j.id === match[1]);
  if (req.method === 'GET' && job) {
    if (match[2]) {
      job.downloaded++;
      const bytes = /\bgarbage\b/i.test(job.prompt) ? Buffer.from('<html>not a video</html>') : /\bmp4\b/i.test(job.prompt) ? MP4 : WEBM;
      return res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length }).end(bytes);
    }
    job.polls++;
    const status = state(job);
    return json(res, {
      id: job.id,
      generation_id: `gen-${job.id}`,
      polling_url: `http://127.0.0.1:${port}/api/v1/videos/${job.id}`,
      status,
      ...(status === 'completed' ? { unsigned_urls: [`http://127.0.0.1:${port}/api/v1/videos/${job.id}/content?index=0`], usage: { cost: 0.25, is_byok: false } } : {}),
      ...(status === 'failed' ? { error: 'The provider could not finish this clip.' } : {}),
    });
  }
  void key;
  json(res, { error: { message: 'Not found' } }, 404);
}).listen(port, '127.0.0.1', () => console.log(`fake video service on ${port}`));
