// A stand-in for a signed-in desktop app: registers a device, opens the device link and lends one model server and one image
// server, so the personal providers can be added, listed, tested, changed and removed against the real server.
import { randomUUID } from 'node:crypto';

export const TEXT_ID = 'u-probe00001';
export const IMAGE_ID = 'u-probe00002';
export const TEXT_BASE = 'http://127.0.0.1:19911';
export const IMAGE_BASE = 'http://127.0.0.1:19912';

export async function connectFakeDesktop(port, user, password) {
  const http = `http://127.0.0.1:${port}`;
  const rpcSocket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  await new Promise((resolve, reject) => { rpcSocket.onopen = resolve; rpcSocket.onerror = reject; });
  let next = 1;
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    const handler = ({ data }) => { const m = JSON.parse(data); if (m.id === id) { rpcSocket.removeEventListener('message', handler); resolve(m.error ? { error: m.error } : { result: m.result }); } };
    rpcSocket.addEventListener('message', handler);
    rpcSocket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  const login = await call('auth.login', { username: user, password, clientKind: 'desktop' });
  if (login.error) throw new Error(`desktop login: ${JSON.stringify(login.error)}`);
  const device = { id: randomUUID(), name: "Probe's MacBook", platform: 'darwin' };
  const registered = await call('devices.register', device);
  if (registered.error) throw new Error(`devices.register: ${JSON.stringify(registered.error)}`);

  const NodeWebSocket = WebSocket;
  const link = new NodeWebSocket(`ws://127.0.0.1:${port}/api/devices/link`, { headers: { authorization: `Bearer ${login.result.token}`, 'x-atelier-device-id': device.id, 'x-atelier-device-name': device.name, 'x-atelier-device-platform': device.platform } });
  await new Promise((resolve, reject) => { link.onopen = resolve; link.onerror = reject; });
  const send = (frame) => link.send(JSON.stringify(frame));
  const models = [{ id: 'llama3.2:3b' }, { id: 'qwen3:8b' }];
  link.onmessage = ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.t === 'ping') return send({ t: 'pong' });
    if (frame.t === 'req') {
      if (frame.request.op === 'providers.detect') return send({ t: 'res', id: frame.id, ok: true, value: [{ type: 'ollama', baseUrl: TEXT_BASE, label: 'Ollama' }] });
      if (frame.request.op === 'images.detect') return send({ t: 'res', id: frame.id, ok: true, value: [{ preset: 'comfyui', type: 'comfyui', baseUrl: IMAGE_BASE, label: 'ComfyUI' }] });
      return send({ t: 'res', id: frame.id, ok: false, code: 'unsupported', error: 'Not here.' });
    }
    if (frame.t === 'start' && frame.service?.kind === 'http') {
      const { service } = frame;
      const answer = (body, type = 'application/json') => {
        send({ t: 'opened', channel: frame.channel });
        send({ t: 'line', channel: frame.channel, line: JSON.stringify({ head: { status: 200, headers: { 'content-type': type } } }) });
        send({ t: 'line', channel: frame.channel, line: JSON.stringify({ chunk: Buffer.from(body).toString('base64') }) });
        send({ t: 'closed', channel: frame.channel, reason: 'done' });
      };
      if (service.target === TEXT_ID) {
        if (service.url.endsWith('/api/tags')) return answer(JSON.stringify({ models: models.map((m) => ({ name: m.id, model: m.id, size: 2_000_000_000, details: { family: 'llama', parameter_size: '3B', quantization_level: 'Q4_K_M' } })) }));
        if (service.url.endsWith('/api/version')) return answer(JSON.stringify({ version: '0.12.3' }));
        if (service.url.endsWith('/api/show')) return answer(JSON.stringify({ model_info: { 'llama.context_length': 8192 }, capabilities: ['completion', 'tools'] }));
        return answer(JSON.stringify({ data: models }));
      }
      return answer(JSON.stringify({ system: { python_version: '3.12' }, devices: [] }));
    }
  };
  send({ t: 'hello', hello: { protocol: 2, app: '0.2.8', services: ['runner', 'http', 'ws', 'chatgptChat'], lending: { scratch: false, ssh: [], http: [{ id: TEXT_ID, baseUrl: TEXT_BASE }, { id: IMAGE_ID, baseUrl: IMAGE_BASE }], chatgptChat: false, connectors: [], home: false }, home: '/Users/probe', sep: '/', os: 'darwin', arch: 'arm64' } });
  await new Promise((r) => setTimeout(r, 400));
  return { call, token: login.result.token, device, close: () => { link.close(); rpcSocket.close(); } };
}
