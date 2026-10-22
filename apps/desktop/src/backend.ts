/**
 * Backend entry for the Electron utility process. Runs the same createBackend() as the web server;
 * secrets are encrypted by main's safeStorage, renderer connections arrive as MessagePorts.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { RpcMessage, Transport } from '@atelier/protocol';
import { createBackend, hostRunnerBinary, type Cipher } from '@atelier/core';
import type { BackendToMain, MainToBackend } from './bridge.ts';
import { localConfigDir, localDataDir } from './data-dir.ts';
import { DESKTOP_USER_AGENT } from './relay.ts';
import { createWebFetch } from './web-fetch.ts';

const parentPort = process.parentPort;
const send = (m: BackendToMain) => parentPort.postMessage(m);

let nextId = 1;
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
const request = (op: 'encrypt' | 'decrypt', value: string) =>
  new Promise<string>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ kind: 'req', id, op, value });
  });

const cipher: Cipher = {
  encrypt: (plaintext) => request('encrypt', plaintext).then((b64) => `ss1:${b64}`),
  decrypt: (ciphertext) => {
    if (!ciphertext.startsWith('ss1:')) return Promise.reject(new Error('Unknown secret format'));
    return request('decrypt', ciphertext.slice(4));
  },
};

const runnerDir = process.env.ATELIER_RUNNER_DIR;
// Without a runner build for this machine, local folders can't be opened (Code and Work need one).
const hasRunner = runnerDir !== undefined && existsSync(hostRunnerBinary(runnerDir));
if (!hasRunner) console.error(`No runner build in ${runnerDir ?? '(unset)'}; run \`pnpm runner:build\` to use local folders.`);
// Chromium's network stack for search engines' result pages (utility processes may use `net`; the bundle keeps
// `electron` external, so it is loaded the way the process itself does).
const { net } = createRequire(import.meta.url)('electron') as typeof import('electron');
const backend = await createBackend({
  chatgptChat: { request: (operation, value = '') => new Promise<string>((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ kind: 'req', id, op: 'chatgptChat', operation, value }); }) },
  webFetch: createWebFetch(net),
  surface: 'desktop',
  configDir: localConfigDir(),
  dataDir: localDataDir(),
  cipher,
  ...(hasRunner ? { runnerDir } : {}),
  env: process.env,
  logger: {
    info: (message, data) => console.log(message, data ?? ''),
    error: (message, error) => console.error(message, error instanceof Error ? error.message : error),
  },
});

parentPort.on('message', (event: { data: MainToBackend; ports: Electron.MessagePortMain[] }) => {
  const m = event.data;
  if (m.kind === 'res') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) p?.resolve(m.value);
    else p?.reject(new Error(m.error));
  } else if (m.kind === 'connect') {
    const port = event.ports[0];
    if (!port) return;
    const handlers = new Set<(msg: RpcMessage) => void>();
    const closeHandlers = new Set<() => void>();
    const transport: Transport = {
      send: (msg) => port.postMessage(msg),
      onMessage: (h) => (handlers.add(h), () => handlers.delete(h)),
      onClose: (h) => (closeHandlers.add(h), () => closeHandlers.delete(h)),
    };
    const disconnect = backend.connect(transport, { ...(m.token ? { token: m.token } : {}), client: { clientKind: 'desktop', userAgent: DESKTOP_USER_AGENT } });
    port.on('message', (e) => {
      for (const h of handlers) h(e.data as RpcMessage);
    });
    port.on('close', () => {
      for (const h of closeHandlers) h();
      disconnect();
    });
    port.start();
  } else if (m.kind === 'blob') {
    void backend.readBlob(m.sha256).then(
      (blob) => send(blob ? { kind: 'blob', id: m.id, found: true, bytes: blob.bytes, mime: blob.mime } : { kind: 'blob', id: m.id, found: false }),
      () => send({ kind: 'blob', id: m.id, found: false }),
    );
  } else if (m.kind === 'removeScreenLock') {
    void backend.removeScreenLock().catch((e: unknown) => console.error('Removing the screen lock failed:', e instanceof Error ? e.message : e));
  } else if (m.kind === 'shutdown') {
    void backend.dispose().then(() => process.exit(0));
  }
});

send({ kind: 'ready' });
