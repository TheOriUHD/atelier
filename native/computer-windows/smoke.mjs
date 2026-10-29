#!/usr/bin/env node
// Smoke test for the built Windows helper (native/bin/atelier-computer-windows-<arch>.exe, from `pnpm computer:build`):
// speaks computer protocol v1 to it over stdio and checks the shape of each answer. Read-only: it never moves the
// mouse, types, holds keys, hides, opens or activates apps, or starts control. It takes screenshots (and prints only
// their size) unless run with --no-capture.
//
//   node native/computer-windows/smoke.mjs [--no-capture] [--verbose] [path\to\atelier-computer-windows-x64.exe]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const capture = !args.includes('--no-capture');
const verbose = args.includes('--verbose');
const binary =
  args.find((a) => !a.startsWith('--')) ??
  join(
    dirname(fileURLToPath(import.meta.url)),
    `../bin/atelier-computer-windows-${process.arch === 'arm64' ? 'arm64' : 'x64'}.exe`,
  );
if (!existsSync(binary)) {
  console.error(`no helper at ${binary}: run \`pnpm computer:build\` first, or pass its path`);
  process.exit(1);
}

let failures = 0;
const check = (ok, label, detail) => {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(
      `  FAIL  ${label}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`}`,
    );
  }
  return ok;
};
const note = (text) => console.log(`        ${text}`);

const isBool = (v) => typeof v === 'boolean';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isNullOr = (test) => (v) => v === null || test(v);

function appProblems(app) {
  const problems = [];
  if (!isStr(app?.id) || app.id.length === 0) problems.push('id');
  if (!isStr(app?.name) || app.name.length === 0 || app.name.length > 200) problems.push('name');
  if (!isNullOr(isStr)(app?.path)) problems.push('path');
  if (!isNullOr(isNum)(app?.pid)) problems.push('pid');
  for (const key of ['running', 'active', 'hidden']) if (!isBool(app?.[key])) problems.push(key);
  if (app?.category !== null) problems.push('category (null on Windows)');
  if (app?.running === false && app?.pid !== null) problems.push('pid of a stopped app');
  // The id rules: a package family name (Name_publisherhash), a lowercase exe name, or startapp:<AppID>.
  if (
    isStr(app?.id) &&
    !(/^[^\\/]+\.exe$/.test(app.id) && app.id === app.id.toLowerCase()) &&
    !/^[A-Za-z0-9.-]+_[a-z0-9]{13}$/.test(app.id) &&
    !app.id.startsWith('startapp:')
  )
    problems.push(`id form (${app.id})`);
  return problems;
}

function inspectProblems(result) {
  const problems = [];
  if (result?.app !== null && appProblems(result?.app).length > 0) problems.push(`app: ${appProblems(result.app)}`);
  if (!isNullOr(isStr)(result?.role)) problems.push('role');
  if (!isNullOr(isStr)(result?.title) || (result?.title?.length ?? 0) > 200) problems.push('title');
  if (!isBool(result?.secure)) problems.push('secure');
  if (!isNullOr(isStr)(result?.link)) problems.push('link');
  if (Object.keys(result ?? {}).length !== 5) problems.push('fields');
  return problems;
}

/** The size in an image's own header, after checking it decodes: a PNG's data inflates to its rows; a JPEG has its frame and end markers. */
function decodeImage(buffer, mime) {
  if (mime === 'image/png') {
    if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { error: 'not a PNG' };
    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    const idat = [];
    while (offset < buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
      const data = buffer.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        colorType = data[9];
      } else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      offset += 12 + length;
    }
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    const raw = inflateSync(Buffer.concat(idat));
    if (!channels || raw.length !== height * (1 + width * channels))
      return { error: `PNG data is ${raw.length} bytes` };
    return { width, height };
  }
  if (buffer.subarray(0, 3).toString('hex') !== 'ffd8ff') return { error: 'not a JPEG' };
  if (buffer.subarray(buffer.length - 2).toString('hex') !== 'ffd9') return { error: 'the JPEG has no end' };
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return { error: 'bad JPEG marker' };
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc2)
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return { error: 'no JPEG frame' };
}

/** Starts the helper; `call` sends a request and resolves with the whole response message. */
function start() {
  const child = spawn(binary, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ATELIER_COMPUTER_DEBUG: '1' },
  });
  const pending = new Map();
  const stray = [];
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (d) => (stderr += d));
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stray.push(line);
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    } else stray.push(line);
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const call = (method, params, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      const started = Date.now();
      pending.set(id, (message) => {
        clearTimeout(timer);
        message.ms = Date.now() - started;
        resolve(message);
      });
      const request = { jsonrpc: '2.0', id, method };
      if (params !== undefined) request.params = params;
      child.stdin.write(JSON.stringify(request) + '\n');
    });
  return { child, call, exited, stray, stderr: () => stderr };
}

const errorCode = (message) => message?.error?.code;
const ok = (message) => message?.jsonrpc === '2.0' && message.result !== undefined && message.error === undefined;

async function main() {
  console.log(`helper: ${binary}`);
  const helper = start();
  const { call } = helper;

  console.log('before initialize');
  const early = await call('displays.list', {});
  check(errorCode(early) === -32002, 'a call before initialize is NotInitialized (-32002)', early);

  console.log('initialize');
  const wrong = await call('initialize', { protocolVersion: 99, client: { name: 'smoke', version: '0' } });
  check(
    errorCode(wrong) === -32032 && wrong.error.data?.protocolVersion === 1 && isStr(wrong.error.data?.helperVersion),
    'another protocol version is refused (-32032, with the versions)',
    wrong,
  );
  const stillEarly = await call('permissions.status', {});
  check(errorCode(stillEarly) === -32002, 'still uninitialized after the refusal', stillEarly);
  const init = await call('initialize', { protocolVersion: 1, client: { name: 'smoke', version: '0' } });
  const r = init.result;
  check(
    ok(init) &&
      r.protocolVersion === 1 &&
      isStr(r.helperVersion) &&
      r.platform === 'win32' &&
      r.supports?.background === false &&
      r.supports?.fullControl === true &&
      r.supports?.filter === true,
    `initialize (helper ${r?.helperVersion}, ${init.ms} ms)`,
    init,
  );
  const again = await call('initialize', { protocolVersion: 1, client: { name: 'smoke', version: '0' } });
  check(errorCode(again) === -32600, 'a second initialize is InvalidRequest (-32600)', again);

  console.log('read-only methods');
  for (const [method, params] of [
    ['permissions.status', {}],
    ['permissions.request', { kind: 'screenRecording' }],
  ]) {
    const answer = await call(method, params);
    check(
      ok(answer) && answer.result.accessibility === true && answer.result.screenRecording === true,
      `${method}: both granted`,
      answer,
    );
  }

  const displays = await call('displays.list', {});
  const list = displays.result?.displays ?? [];
  const primary = list.find((d) => d.primary) ?? list[0];
  check(
    ok(displays) &&
      list.length > 0 &&
      list.every(
        (d) =>
          isStr(d.id) &&
          isStr(d.name) &&
          isNum(d.scale) &&
          d.scale > 0 &&
          isBool(d.primary) &&
          [d.x, d.y, d.width, d.height].every(isNum),
      ) &&
      list.filter((d) => d.primary).length === 1 &&
      primary.x === 0 &&
      primary.y === 0,
    `displays.list: ${list.length} display(s)`,
    displays,
  );
  for (const d of list)
    note(
      `${d.id} "${d.name}" ${d.width}x${d.height} at ${d.x},${d.y} scale ${d.scale}${d.primary ? ' (primary)' : ''}`,
    );

  const apps = await call('apps.list', { installed: true }, 60_000);
  const all = apps.result?.apps ?? [];
  const bad = all.filter((a) => appProblems(a).length > 0);
  const ids = new Set(all.map((a) => a.id.toLowerCase()));
  check(
    ok(apps) && all.length > 0 && bad.length === 0,
    `apps.list {installed: true}: ${all.length} apps in ${apps.ms} ms`,
    bad.slice(0, 5).map((a) => [a, appProblems(a)]),
  );
  check(ids.size === all.length, 'apps.list: one entry per id');
  check(
    all.some((a) => !a.running),
    'apps.list: Start menu apps (Get-StartApps) are there',
    all.length,
  );
  const families = all.filter((a) => /_[a-z0-9]{13}$/.test(a.id));
  const exes = all.filter((a) => a.id.endsWith('.exe'));
  const startapps = all.filter((a) => a.id.startsWith('startapp:'));
  note(`${families.length} packaged (family names), ${exes.length} by exe, ${startapps.length} startapp: ids`);
  for (const a of verbose ? all : [...families.slice(0, 4), ...exes.slice(0, 6), ...startapps.slice(0, 4)])
    note(`${a.running ? 'running' : 'installed'}  ${a.id}  "${a.name}"${a.path ? `  ${a.path}` : ''}`);
  const again2 = await call('apps.list', { installed: true });
  check(ok(again2) && again2.ms < 5_000, `apps.list again comes from the 60 s cache (${again2.ms} ms)`);
  const runningOnly = await call('apps.list', { installed: false });
  check(
    ok(runningOnly) && runningOnly.result.apps.every((a) => a.running && isNum(a.pid) && appProblems(a).length === 0),
    `apps.list {installed: false}: ${runningOnly.result?.apps?.length} running apps`,
    runningOnly,
  );
  for (const a of runningOnly.result?.apps ?? [])
    note(`running  ${a.id}  "${a.name}" pid ${a.pid}${a.active ? ' active' : ''}${a.hidden ? ' hidden' : ''}`);
  const missing = await call('apps.list', {});
  check(
    errorCode(missing) === -32602 && /installed/.test(missing.error.message),
    'apps.list without `installed` is InvalidParams (-32602)',
    missing,
  );

  const front = await call('apps.frontmost', {});
  check(
    ok(front) && (front.result.app === null || (appProblems(front.result.app).length === 0 && front.result.app.active)),
    `apps.frontmost: ${front.result?.app?.id ?? 'none'}`,
    front,
  );

  const cursor = await call('cursor.position', {});
  check(
    ok(cursor) && isNum(cursor.result.x) && isNum(cursor.result.y),
    `cursor.position: ${cursor.result?.x},${cursor.result?.y}`,
    cursor,
  );

  const focused = await call('inspect.focused', {});
  check(
    ok(focused) && inspectProblems(focused.result).length === 0,
    `inspect.focused (${focused.ms} ms): ${JSON.stringify({ app: focused.result?.app?.id ?? null, role: focused.result?.role, secure: focused.result?.secure })}`,
    focused,
  );
  if (primary) {
    const point = await call('inspect.point', {
      x: primary.x + Math.floor(primary.width / 2),
      y: primary.y + Math.floor(primary.height / 2),
    });
    check(
      ok(point) && inspectProblems(point.result).length === 0,
      `inspect.point at the primary's centre (${point.ms} ms): ${JSON.stringify({ app: point.result?.app?.id ?? null, role: point.result?.role })}`,
      point,
    );
  }
  const badPoint = await call('inspect.point', { x: 'left', y: 0 });
  check(errorCode(badPoint) === -32602, 'inspect.point with a bad x is InvalidParams (-32602)', badPoint);

  const unknown = await call('no.such.method', {});
  check(errorCode(unknown) === -32601, 'an unknown method is MethodNotFound (-32601)', unknown);
  const badParams = await call('capture.display', {
    display: primary?.id ?? 'x',
    maxWidth: 0,
    maxHeight: 10,
    format: 'jpeg',
  });
  check(errorCode(badParams) === -32602, 'capture.display with maxWidth 0 is InvalidParams (-32602)', badParams);

  console.log('capture.display');
  const noDisplay = await call('capture.display', {
    display: '\\\\.\\DISPLAY99',
    maxWidth: 320,
    maxHeight: 200,
    format: 'jpeg',
  });
  check(errorCode(noDisplay) === -32033, 'an unknown display is NotFound (-32033)', noDisplay);
  if (capture && primary) {
    const shots = [
      [
        'the primary display, 320x200 JPEG',
        { display: primary.id, maxWidth: 320, maxHeight: 200, format: 'jpeg', quality: 0.5 },
        primary,
      ],
      [
        'a region as PNG',
        {
          display: primary.id,
          region: { x: primary.x + 10, y: primary.y + 10, width: 100, height: 50 },
          maxWidth: 1000,
          maxHeight: 1000,
          format: 'png',
        },
        { x: primary.x + 10, y: primary.y + 10, width: 100, height: 50 },
      ],
      [
        'only some apps (apps: [])',
        { display: primary.id, apps: [], maxWidth: 640, maxHeight: 640, format: 'jpeg' },
        primary,
      ],
      [
        'all but some (exclude: [])',
        { display: primary.id.toLowerCase(), exclude: [], maxWidth: 640, maxHeight: 640, format: 'png' },
        primary,
      ],
    ];
    for (const [label, params, rect] of shots) {
      const shot = await call('capture.display', params);
      // Over SSH there is no interactive desktop (session 0, its display "WinDisc"): BitBlt has nothing to read.
      if (primary.id === 'WinDisc' && errorCode(shot) === -32603) {
        console.log(`  skip  ${label}: no desktop in session 0 (${shot.error.message})`);
        continue;
      }
      if (!check(ok(shot), `${label}: answered (${shot.ms} ms)`, shot.error)) continue;
      const res = shot.result;
      const decoded = decodeImage(Buffer.from(res.data, 'base64'), res.mime);
      check(
        !decoded.error &&
          res.mime === (params.format === 'png' ? 'image/png' : 'image/jpeg') &&
          decoded.width === res.width &&
          decoded.height === res.height &&
          res.width <= params.maxWidth &&
          res.height <= params.maxHeight &&
          res.rect.x === rect.x &&
          res.rect.y === rect.y &&
          res.rect.width === rect.width &&
          res.rect.height === rect.height,
        `${label}: ${res.width}x${res.height} ${res.mime} for ${res.rect.width}x${res.rect.height} at ${res.rect.x},${res.rect.y}, decodes`,
        decoded.error ?? { width: res.width, height: res.height, rect: res.rect, decoded },
      );
    }
  } else console.log('  skip  --no-capture');

  console.log('shutdown');
  const bye = await call('shutdown', {});
  check(ok(bye) && Object.keys(bye.result).length === 0, 'shutdown answers {}', bye);
  const exit = await helper.exited;
  check(exit.code === 0, 'and exits 0', exit);
  check(helper.stray.length === 0, 'stdout carries only JSON-RPC answers', helper.stray.slice(0, 3));

  console.log('stdin EOF');
  const second = start();
  const init2 = await second.call('initialize', { protocolVersion: 1, client: { name: 'smoke', version: '0' } });
  check(ok(init2), 'initialize');
  second.child.stdin.end();
  const exit2 = await Promise.race([
    second.exited,
    new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 5_000)),
  ]);
  check(exit2.code === 0, 'EOF on stdin exits 0', exit2);

  const log = helper.stderr() + second.stderr();
  if (log) console.log(`\nhelper stderr:\n${log.trimEnd()}`);
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
