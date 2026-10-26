#!/usr/bin/env node
/**
 * A stand-in for the computer use helper (native/computer-macos, computer protocol v1): a pretend screen with a few
 * apps that never touches the real mouse or keyboard. What it is asked to do goes to FAKE_COMPUTER_LOG as JSON lines,
 * so a test can check what reached the "computer". Holding Esc is played by creating `<log>.esc` while it has control.
 *
 *   ATELIER_COMPUTER_HELPER=e2e/fake-computer.mjs FAKE_COMPUTER_LOG=/tmp/computer.log
 *   FAKE_COMPUTER_NO_PERMISSIONS=1   macOS hasn't given Atelier its permissions yet
 */
import { appendFileSync, existsSync, rmSync, unwatchFile, watchFile } from 'node:fs';
import { createInterface } from 'node:readline';
import { deflateSync } from 'node:zlib';

const LOG = process.env.FAKE_COMPUTER_LOG;
const SCREEN = { id: '1', name: 'Built-in Display', x: 0, y: 0, width: 1440, height: 900, scale: 2, primary: true };

const app = (id, name, running = false) => ({ id, name, path: `/Applications/${name}.app`, pid: running ? 100 + id.length : null, running, active: false, hidden: false, category: null });
const apps = [
  app('com.apple.TextEdit', 'TextEdit', true),
  app('com.apple.Safari', 'Safari'),
  app('com.apple.Terminal', 'Terminal'),
  app('com.apple.mail', 'Mail', true),
  app('com.1password.1password', '1Password'),
];
let frontmost = apps[0];
frontmost.active = true;
let cursor = { x: 720, y: 450 };
let control = false;
let stopped = false;
let permissions = { accessibility: !process.env.FAKE_COMPUTER_NO_PERMISSIONS, screenRecording: !process.env.FAKE_COMPUTER_NO_PERMISSIONS };

const log = (entry) => LOG && appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const notify = (method, params) => write({ method, params });

class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** A PNG of one colour, the size asked for. */
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([0xf4, 0xf3, 0xee], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const needs = (kind) => {
  if (!permissions[kind]) throw new RpcError(`Atelier doesn't have the ${kind} permission.`, -32030, { permission: kind });
};
const acting = () => {
  needs('accessibility');
  if (stopped) throw new RpcError('The person stopped computer use.', -32031);
};
const find = (id) => {
  const found = apps.find((a) => a.id === id);
  if (!found) throw new RpcError(`No app ${id}.`, -32033);
  return found;
};

const escFile = LOG ? `${LOG}.esc` : null;
const watchEsc = () => {
  if (!escFile) return;
  watchFile(escFile, { interval: 100 }, () => {
    if (!control || !existsSync(escFile)) return;
    rmSync(escFile, { force: true });
    notify('control.esc', { phase: 'down', heldMs: 0 });
    setTimeout(() => {
      stopped = true;
      notify('control.esc', { phase: 'stopped', heldMs: 1000 });
    }, 300);
  });
};

const methods = {
  initialize: () => ({ protocolVersion: 1, helperVersion: 'fake', platform: 'darwin', supports: { background: false, fullControl: true, filter: true } }),
  'permissions.status': () => permissions,
  'permissions.request': ({ kind }) => {
    log({ method: 'permissions.request', kind });
    permissions = { ...permissions, [kind]: true };
    return permissions;
  },
  'displays.list': () => ({ displays: [SCREEN] }),
  'apps.list': () => ({ apps }),
  'apps.frontmost': () => ({ app: frontmost }),
  'apps.open': ({ id, activate }) => {
    const opened = find(id);
    opened.running = true;
    opened.hidden = false;
    if (activate) {
      frontmost.active = false;
      frontmost = opened;
      opened.active = true;
    }
    log({ method: 'apps.open', id, activate });
    return { app: opened };
  },
  'apps.hide': ({ ids }) => {
    const hid = apps.filter((a) => ids.includes(a.id) && a.running && !a.hidden);
    for (const a of hid) a.hidden = true;
    log({ method: 'apps.hide', ids: hid.map((a) => a.id) });
    return { ids: hid.map((a) => a.id) };
  },
  'apps.unhide': ({ ids }) => {
    for (const a of apps) if (ids.includes(a.id)) a.hidden = false;
    log({ method: 'apps.unhide', ids });
    return {};
  },
  'capture.display': ({ region, maxWidth, maxHeight, apps: only, exclude }) => {
    needs('screenRecording');
    const rect = region ?? SCREEN;
    const scale = Math.min(1, maxWidth / rect.width, maxHeight / rect.height);
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    log({ method: 'capture.display', apps: only ?? null, exclude: exclude ?? null, width, height });
    return { data: png(width, height).toString('base64'), mime: 'image/png', width, height, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  },
  // The pretend screen: whatever app is in front fills it; its lower edge holds a password field and a link.
  'inspect.point': ({ y }) => ({ app: frontmost, role: y > 860 ? 'AXSecureTextField' : y > 820 ? 'AXLink' : 'AXButton', title: null, secure: y > 860, link: y > 820 && y <= 860 ? 'https://example.com/' : null }),
  'inspect.focused': () => ({ app: frontmost, role: 'AXTextArea', title: null, secure: false, link: null }),
  'mouse.move': (p) => {
    acting();
    cursor = { x: p.x, y: p.y };
    log({ method: 'mouse.move', ...p });
    return {};
  },
  'mouse.click': (p) => {
    acting();
    cursor = { x: p.x, y: p.y };
    log({ method: 'mouse.click', ...p });
    return {};
  },
  'mouse.down': (p) => (acting(), log({ method: 'mouse.down', ...p }), {}),
  'mouse.up': (p) => (acting(), log({ method: 'mouse.up', ...p }), {}),
  'mouse.drag': (p) => {
    acting();
    cursor = p.to;
    log({ method: 'mouse.drag', ...p });
    return {};
  },
  'mouse.scroll': (p) => (acting(), log({ method: 'mouse.scroll', ...p }), {}),
  'cursor.position': () => cursor,
  'key.press': (p) => (acting(), log({ method: 'key.press', ...p }), {}),
  'key.type': (p) => (acting(), log({ method: 'key.type', ...p }), {}),
  'key.hold': (p) => (acting(), log({ method: 'key.hold', ...p }), {}),
  'input.releaseAll': () => (log({ method: 'input.releaseAll' }), {}),
  'control.begin': () => {
    control = true;
    log({ method: 'control.begin' });
    return {};
  },
  'control.end': () => {
    control = false;
    log({ method: 'control.end' });
    return {};
  },
  'control.resume': () => {
    stopped = false;
    return {};
  },
  shutdown: () => {
    setTimeout(() => process.exit(0), 10);
    return {};
  },
};

watchEsc();
createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const method = methods[message.method];
  try {
    if (!method) throw new RpcError(`Unknown method ${message.method}.`, -32601);
    write({ id: message.id, result: method(message.params ?? {}) });
  } catch (e) {
    write({ id: message.id, error: { code: e.code ?? -32603, message: e.message, ...(e.data ? { data: e.data } : {}) } });
  }
});
process.stdin.on('end', () => {
  if (escFile) unwatchFile(escFile);
  process.exit(0);
});
