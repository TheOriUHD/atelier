import https from 'node:https';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const password = randomUUID();
const setupToken = randomUUID();
const backend = spawn(process.execPath, ['apps/server/dist/server.mjs'], {
  env: { ...process.env, ATELIER_DATA_DIR: `/tmp/atelier-mobile-${randomUUID()}`, ATELIER_PORT: '17349', ATELIER_SETUP_TOKEN: setupToken },
  stdio: ['ignore', 'pipe', 'pipe'],
});
backend.stdout.on('data', () => {});
backend.stderr.on('data', () => {});
let proxy;
const model = http.createServer(async (request, response) => {
  if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'mobile-test', object: 'model', owned_by: 'test' }] })); return; }
  if (request.url === '/v1/chat/completions') {
    for await (const chunk of request) void chunk;
    response.setHeader('content-type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Native streaming verified.' }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return;
  }
  response.writeHead(404); response.end();
});
await new Promise((resolve) => model.listen(17351, '127.0.0.1', resolve));
try {
  await new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try { if ((await fetch('http://127.0.0.1:17349/api/health')).ok) { clearInterval(timer); clearTimeout(deadline); resolve(); } } catch { /* The isolated server may still be applying migrations. */ }
    }, 200);
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('Test server did not start')); }, 15000);
  });
  const socket = new WebSocket('ws://127.0.0.1:17349/api/ws');
  await new Promise((resolve, reject) => {
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.setup', params: { username: 'mobiletest', name: 'Mobile Test', password, setupToken, clientKind: 'mobile' } }));
    socket.onmessage = ({ data }) => { const result = JSON.parse(data); if (result.id === 1) { socket.close(); if (result.error) reject(new Error(result.error.message)); else resolve(); } };
    socket.onerror = reject;
  });
  proxy = https.createServer({ key: await readFile('/tmp/atelier-mobile-test.key'), cert: await readFile('/tmp/atelier-mobile-test.crt') }, (request, response) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: 17349, path: request.url, method: request.method, headers: request.headers }, (result) => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on('upgrade', (request, socket, head) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: 17349, path: request.url, headers: request.headers });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket); socket.pipe(remote);
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise((resolve) => proxy.listen(17350, '127.0.0.1', resolve));
  const test = spawn('xcodebuild', ['-project', 'apps/ios/Atelier.xcodeproj', '-scheme', 'Atelier', '-destination', 'platform=iOS Simulator,id=3EFB4971-CE0F-405A-9678-F70097A234A8', '-derivedDataPath', '/tmp/atelier-ios-build', '-only-testing:AtelierTests/ServerIntegrationTests', 'CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_ALLOWED=YES', 'test'], {
    env: { ...process.env, TEST_RUNNER_ATELIER_TEST_SERVER: 'https://127.0.0.1:17350', TEST_RUNNER_ATELIER_TEST_USER: 'mobiletest', TEST_RUNNER_ATELIER_TEST_PASSWORD: password },
    stdio: 'inherit',
  });
  process.exitCode = await new Promise((resolve) => test.on('exit', resolve));
} finally {
  proxy?.closeAllConnections(); proxy?.close(); model.closeAllConnections(); model.close(); backend.kill();
}
