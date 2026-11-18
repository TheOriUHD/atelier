#!/usr/bin/env node
// Makes the demo server's data (README.md): runs the release's own server on this computer with the demo model, creates the
// admin and the reviewer account through the server's RPC, and has the reviewer's conversations written the way anyone's
// are: by sending the questions. What ends up in `--out` is the folder the demo image carries as /demo-data.
//
//   node scripts/seed.mjs --server <path to the release's server.mjs> --out build/data --creds build/creds.json
//
// Passwords are made here (or read from DEMO_ADMIN_PASSWORD / DEMO_REVIEWER_PASSWORD) and written to --creds, mode 600.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONVERSATIONS, PROJECTS, SCRIPT } from './conversations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const serverFile = resolve(arg('server', ''));
const outDir = resolve(arg('out', join(here, '../build/data')));
const credsFile = resolve(arg('creds', join(here, '../build/creds.json')));
const SERVER_PORT = 17340;
const MODEL_PORT = 18099;
// The model the reviewer starts with (a model ref, `provider/model`); the OpenAI one once its key is on the server.
const defaultModel = process.env.DEMO_DEFAULT_MODEL ?? 'demo/demo-model';

if (!existsSync(serverFile)) throw new Error('--server must be the release\'s server.mjs');
const password = () => randomBytes(15).toString('base64url');
const creds = {
  admin: { username: 'demo-admin', password: process.env.DEMO_ADMIN_PASSWORD ?? password() },
  reviewer: { username: 'reviewer', password: process.env.DEMO_REVIEWER_PASSWORD ?? password() },
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'home'), { recursive: true });
const scriptFile = join(dirname(outDir), 'script.json');
writeFileSync(scriptFile, JSON.stringify(SCRIPT));

const children = [];
const run = (file, args, env) => {
  const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(child);
  return child;
};
const stopAll = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('exit', stopAll);

run(join(here, '../container/demo-model.mjs'), [], { DEMO_MODEL_PORT: String(MODEL_PORT), DEMO_MODEL_SCRIPT: scriptFile });
const server = run(serverFile, [], {
  NODE_ENV: 'production',
  ATELIER_DATA_DIR: outDir,
  ATELIER_HOST: '127.0.0.1',
  ATELIER_PORT: String(SERVER_PORT),
  ATELIER_SETUP_TOKEN: 'seed',
  // The release's own web app (docker cp <image>:/app/ui build/ui): the server reads it when it starts.
  ATELIER_UI_DIR: join(dirname(outDir), 'ui'),
  HOME: join(outDir, 'home'),
  // Present while the data is made, so the OpenAI provider has a key to list models with; the real one is the container's.
  OPENAI_API_KEY: 'sk-demo-placeholder-not-a-real-key',
});

async function until(check, what, seconds = 60) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A JSON-RPC client on the server's WebSocket. */
async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/api/ws`);
  await new Promise((resolveOpen, reject) => {
    socket.onopen = resolveOpen;
    socket.onerror = () => reject(new Error('The server did not accept the connection'));
  });
  let next = 1;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined && waiting.has(message.id)) {
      const { ok, fail } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) fail(new Error(`${message.error.message}${message.error.data ? ` ${JSON.stringify(message.error.data)}` : ''}`));
      else ok(message.result);
    }
  };
  const call = (method, params = {}) =>
    new Promise((ok, fail) => {
      const id = next++;
      waiting.set(id, { ok, fail });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    }).catch((error) => {
      throw new Error(`${method}: ${error.message}`);
    });
  return { call, close: () => socket.close() };
}

async function main() {
  await until(async () => (await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`)).ok, 'the server to start');
  await until(async () => (await fetch(`http://127.0.0.1:${MODEL_PORT}/v1/models`)).ok, 'the demo model to start');

  // The admin, the providers, the models' names, and the reviewer.
  const admin = await connect();
  await admin.call('auth.setup', { ...creds.admin, name: 'Demo Admin', clientKind: 'web', setupToken: 'seed' });
  await admin.call('settings.set', {
    layer: 'global',
    path: ['providers'],
    value: [
      { id: 'demo', type: 'openai-compatible', name: 'Demo', baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`, headers: {}, enabled: true },
      // The key is the container's OPENAI_API_KEY, read when a request goes out; nothing of it is stored in this data.
      { id: 'openai', type: 'openai', name: 'GPT', baseUrl: 'https://api.openai.com', apiKey: '${env:OPENAI_API_KEY}', headers: {}, enabled: true },
    ],
  });
  await admin.call('settings.set', { layer: 'global', path: ['models', 'overrides'], value: { 'demo/demo-model': { displayName: 'Demo model (fixed replies)', favorite: true } } });
  await admin.call('settings.set', { layer: 'global', path: ['models', 'defaults', 'chat'], value: defaultModel });
  const made = await admin.call('users.create', { username: creds.reviewer.username, name: 'App Reviewer', role: 'user' });
  admin.close();

  // The reviewer: a normal account that has already changed its first password.
  const reviewer = await connect();
  await reviewer.call('auth.login', { username: creds.reviewer.username, password: made.temporaryPassword, clientKind: 'web' });
  await reviewer.call('account.changePassword', { current: made.temporaryPassword, next: creds.reviewer.password });
  await until(async () => (await reviewer.call('models.list')).some((m) => m.ref === 'demo/demo-model'), 'the demo model to be listed');

  const projects = new Map();
  for (const project of PROJECTS) projects.set(project.name, await reviewer.call('projects.create', project));

  // Oldest first, so the newest is at the top of the list.
  for (const conversation of [...CONVERSATIONS].reverse()) {
    const project = conversation.project ? projects.get(conversation.project) : undefined;
    const session = await reviewer.call('sessions.create', { mode: 'chat', model: 'demo/demo-model', ...(project ? { projectId: project.id } : {}) });
    for (const turn of conversation.turns) {
      await reviewer.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: turn.user }] });
      await until(async () => (await reviewer.call('sessions.list', { mode: 'chat' })).find((s) => s.id === session.id)?.status === 'idle', `"${conversation.title}" to be answered`, 90);
    }
    await reviewer.call('sessions.update', { id: session.id, title: conversation.title, ...(conversation.pinned ? { pinned: true } : {}) });
    console.log(`made: ${conversation.title}`);
  }
  reviewer.close();
}

try {
  await main();
  // A clean stop, so the database is closed and written out.
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  mkdirSync(dirname(credsFile), { recursive: true });
  writeFileSync(credsFile, `${JSON.stringify({ ...creds, server: { note: 'Admin: only for looking after the demo. Reviewer: what goes in the review notes.' } }, null, 2)}\n`);
  chmodSync(credsFile, 0o600);
  console.log(`Data in ${outDir}; accounts in ${credsFile}`);
} catch (error) {
  console.error(error);
  stopAll();
  process.exitCode = 1;
}
stopAll();
