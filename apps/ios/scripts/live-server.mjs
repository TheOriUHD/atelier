#!/usr/bin/env node
// A throwaway Atelier backend with a scripted model behind an HTTPS front, for trying the iOS app against the real thing.
//
//   PORT_BASE=17400 node apps/ios/scripts/live-server.mjs
//
// PORT_BASE+0 is the backend (plain http, for scripts), +1 the https front the app connects to, +2 the scripted model.
// It prints READY with the address and two accounts: an admin (demo / atelier-demo-pass) and an ordinary user
// (member / the temporary password it prints). Data lives under DATA_DIR (default: a new folder in $TMPDIR).
// The https front uses a self-signed certificate for 127.0.0.1; trust it in a simulator once with:
//   xcrun simctl keychain <udid> add-root-cert <CERT_DIR>/atelier-mobile-test.crt
import https from 'node:https';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(new URL('../../..', import.meta.url).pathname);
const base = Number(process.env.PORT_BASE ?? 17400);
const dataDir = process.env.DATA_DIR ?? join(tmpdir(), `atelier-live-${base}`);
const certDir = process.env.CERT_DIR ?? join(tmpdir(), 'atelier-live-cert');
const password = 'atelier-demo-pass';
const setupToken = 'setup-demo-token';
mkdirSync(certDir, { recursive: true });
if (!existsSync(join(certDir, 'atelier-mobile-test.key'))) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'atelier-mobile-test.key'), '-out', join(certDir, 'atelier-mobile-test.crt'), '-days', '30', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
}

// A git folder to work in, for Code mode: two commits, an edit, an untracked file and a branch.
const folder = join(dataDir, 'demo-repo');
if (!existsSync(folder)) {
  mkdirSync(join(folder, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: folder, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'demo@example.com'); git('config', 'user.name', 'Demo');
  writeFileSync(join(folder, 'README.md'), '# Demo repo\n\nA folder for trying Code mode.\n');
  writeFileSync(join(folder, 'src', 'server.js'), "export function start() {\n  const server = http.createServer(handler);\n  server.listen(0);\n  return server;\n}\n");
  git('add', '.'); git('commit', '-q', '-m', 'Start the demo repo');
  writeFileSync(join(folder, 'src', 'util.js'), 'export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n');
  git('add', '.'); git('commit', '-q', '-m', 'Add a sleep helper');
  git('checkout', '-q', '-b', 'feature/wait-for-port'); git('checkout', '-q', 'main');
  writeFileSync(join(folder, 'src', 'server.js'), "export async function start() {\n  const server = http.createServer(handler);\n  await new Promise((resolve) => server.listen(0, resolve));\n  return server;\n}\n");
  writeFileSync(join(folder, 'notes.txt'), 'Untracked notes\n');
}

const backend = spawn(process.execPath, [`${repo}/apps/server/dist/server.mjs`], {
  env: { ...process.env, ATELIER_DATA_DIR: dataDir, ATELIER_PORT: String(base), ATELIER_SETUP_TOKEN: setupToken },
  stdio: ['ignore', 'pipe', 'pipe'],
});
backend.stdout.on('data', () => {}); backend.stderr.on('data', () => {});

const REPLY = ['Here is a short plan for the **week**.\n\n', '## Monday\n\n', '- Review the open pull requests\n- Reply to `Anna` about the offsite\n\n', '1. Ship the settings change\n2. Run the full suite\n\n', '```swift\nlet plan = ["review", "ship"]\n```\n\n', '> Small steps, done in order.\n\n', 'Want a checklist?'];
const model = http.createServer(async (request, response) => {
  if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'demo-model', object: 'model', owned_by: 'demo' }] })); return; }
  if (request.url === '/v1/chat/completions') {
    for await (const chunk of request) void chunk;
    response.setHeader('content-type', 'text/event-stream');
    // THINK=1: a first pause and some reasoning before the answer, as a thinking model does.
    if (process.env.THINK) {
      await new Promise((r) => setTimeout(r, 1500));
      for (const word of 'Let me think about how the week should go. The pull requests come first, then the offsite reply, then the settings change. '.split(/(?<=\s)/)) {
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: word }, finish_reason: null }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    for (const piece of REPLY) for (const word of piece.split(/(?<=\s)/)) {
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: word }, finish_reason: null }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 25));
    }
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return;
  }
  response.writeHead(404); response.end();
});
await new Promise((resolve) => model.listen(base + 2, '127.0.0.1', resolve));
await new Promise((resolve, reject) => {
  const timer = setInterval(async () => { try { if ((await fetch(`http://127.0.0.1:${base}/api/health`)).ok) { clearInterval(timer); resolve(); } } catch {} }, 200);
  setTimeout(() => reject(new Error('server did not start')), 30000);
});

let nextId = 1;
const call = (socket, method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const handler = ({ data }) => { const m = JSON.parse(data); if (m.id === id) { socket.removeEventListener('message', handler); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); } };
  socket.addEventListener('message', handler);
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});
const socket = new WebSocket(`ws://127.0.0.1:${base}/api/ws`);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
try {
  await call(socket, 'auth.setup', { username: 'demo', name: 'Philipp Buss', password, setupToken, clientKind: 'mobile' });
  await call(socket, 'providers.save', { id: 'demo', type: 'openai-compatible', name: 'Demo model', baseUrl: `http://127.0.0.1:${base + 2}/v1` });
  const member = await call(socket, 'users.create', { username: 'member', name: 'Mia Member', role: 'user' }).catch(() => null);
  const project = await call(socket, 'projects.create', { name: 'Launch 0.11', description: 'Everything for the next release.' }).catch(() => null);
  for (const title of ['Plan for the week', 'Compare three self-hosted wikis', 'Draft a reply to Anna']) {
    const s = await call(socket, 'sessions.create', { mode: 'chat', model: 'demo/demo-model', ...(project && title.startsWith('Plan') ? { projectId: project.id } : {}) });
    await call(socket, 'sessions.update', { id: s.id, title });
  }
  const workspace = await call(socket, 'workspaces.addLocal', { path: folder }).catch((e) => { console.error(String(e)); return null; });
  if (workspace) {
    await call(socket, 'workspaces.trust', { id: workspace.id }).catch(() => {});
    const s = await call(socket, 'sessions.create', { mode: 'code', model: 'demo/demo-model', workspaceId: workspace.id });
    await call(socket, 'sessions.update', { id: s.id, title: 'Fix the flaky health test' });
  }
  console.log(`MEMBER ${member ? `member ${member.temporaryPassword}` : 'not created'}`);
} finally { socket.close(); }
console.log(`READY https://127.0.0.1:${base + 1} demo ${password}`);

const front = https.createServer({ key: readFileSync(join(certDir, 'atelier-mobile-test.key')), cert: readFileSync(join(certDir, 'atelier-mobile-test.crt')) }, (request, response) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: base, path: request.url, method: request.method, headers: request.headers }, (result) => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
  upstream.on('error', () => response.destroy());
  request.pipe(upstream);
});
front.on('upgrade', (request, sock, head) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: base, path: request.url, headers: request.headers });
  upstream.on('upgrade', (response, remote, remoteHead) => {
    sock.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (remoteHead.length) sock.write(remoteHead);
    if (head.length) remote.write(head);
    remote.pipe(sock); sock.pipe(remote);
    sock.on('error', () => remote.destroy()); remote.on('error', () => sock.destroy());
  });
  upstream.on('error', () => sock.destroy()); upstream.end();
});
await new Promise((resolve) => front.listen(base + 1, '127.0.0.1', resolve));
process.on('SIGTERM', () => { backend.kill(); process.exit(0); });
process.on('SIGINT', () => { backend.kill(); process.exit(0); });
