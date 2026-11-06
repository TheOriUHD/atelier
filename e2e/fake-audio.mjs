#!/usr/bin/env node
/**
 * Scripted stand-in for a sound server, for end-to-end tests and manual QA without a GPU or a key. It speaks LocalAI's
 * routes: `/v1/models`, `/v1/audio/voices`, OpenAI's `/v1/audio/speech` for speech, and `/v1/sound-generation` for music
 * and sound effects. Speech is a real 6 s MP3 (made once with ffmpeg and kept in e2e/assets), music a 12 s one.
 *
 * How a request goes is picked from words in its text, which read like a request so they can stay on screen:
 *   "unhurried" → about 6 s before it answers      "forbidden" → turned down as unsafe
 *   "broken"    → the server answers 500           "garbage"   → what comes back is not a sound
 *   anything else → about half a second
 *
 * GET /__log lists the requests it saw, oldest first: { route, model, text, voice, seconds, lyrics, instrumental, speed }.
 * POST /__reset forgets them.
 *
 * Usage: node e2e/fake-audio.mjs [port=11630]
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 11630);
const VOICE = readFileSync(new URL('./assets/voice.mp3', import.meta.url));
const SONG = readFileSync(new URL('./assets/song.mp3', import.meta.url));
const log = [];

const json = (res, value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const body = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}));
  });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Answers a request for a sound as its words say. */
async function answer(res, text, bytes) {
  if (/\bbroken\b/i.test(text)) return json(res, { error: { message: 'The server is having trouble.' } }, 500);
  if (/\bforbidden\b/i.test(text)) return json(res, { error: { message: 'This request was flagged by the safety filter.' } }, 400);
  await wait(/\bunhurried\b/i.test(text) ? 6_000 : 500);
  const out = /\bgarbage\b/i.test(text) ? Buffer.from('<html>not a sound</html>') : bytes;
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': out.length }).end(out);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/__log') return json(res, log);
  if (url.pathname === '/__reset') return log.splice(0), json(res, { ok: true });

  if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, { object: 'list', data: [{ id: 'fake-kokoro', object: 'model' }, { id: 'fake-ace-step', object: 'model' }, { id: 'fake-chat-8b', object: 'model' }] });
  if (req.method === 'GET' && url.pathname === '/v1/audio/voices') {
    const model = url.searchParams.get('model');
    return json(res, { data: [{ model: 'fake-kokoro', voices: ['af_heart', 'bm_george', 'af_sky'] }].filter((d) => !model || d.model === model) });
  }

  if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
    const input = await body(req);
    log.push({ route: 'speech', model: input.model ?? null, text: String(input.input ?? ''), voice: input.voice ?? null, speed: input.speed ?? null, format: input.response_format ?? null });
    return answer(res, String(input.input ?? ''), VOICE);
  }
  if (req.method === 'POST' && url.pathname === '/v1/sound-generation') {
    const input = await body(req);
    log.push({ route: 'sound', model: input.model_id ?? null, text: String(input.text ?? ''), seconds: input.duration_seconds ?? null, lyrics: input.lyrics ?? null, instrumental: input.instrumental ?? null });
    return answer(res, String(input.text ?? ''), SONG);
  }
  json(res, { error: { message: 'Not found' } }, 404);
}).listen(port, '127.0.0.1', () => console.log(`fake audio server on ${port}`));
