#!/usr/bin/env node
// Smoke test for the built macOS helper (native/bin/atelier-computer-darwin, from `pnpm computer:build`): speaks
// computer protocol v1 to it over stdio and checks the shape of each answer. Read-only: it never moves the mouse,
// types, hides or opens apps, asks for permissions or starts control. With Screen Recording granted it takes a
// screenshot only when run with --capture (and prints just its size).
//
//   node native/computer-macos/smoke.mjs [--capture] [path/to/binary]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const capture = args.includes('--capture');
const binary =
  args.find((a) => !a.startsWith('--')) ??
  join(dirname(fileURLToPath(import.meta.url)), '../bin/atelier-computer-darwin');
if (!existsSync(binary)) {
  console.error(`no helper at ${binary}: run \`pnpm computer:build\` first`);
  process.exit(1);
}

let failures = 0;
const check = (ok, label, detail) => {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(
      `  FAIL  ${label}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
    );
  }
  return ok;
};

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
  if (!isNullOr(isStr)(app?.category)) problems.push('category');
  if (app?.running === false && app?.pid !== null) problems.push('pid of a stopped app');
  return problems;
}

function inspectProblems(result) {
  const problems = [];
  if (result?.app !== null && appProblems(result?.app).length > 0) problems.push('app');
  if (!isNullOr(isStr)(result?.role)) problems.push('role');
  if (!isNullOr(isStr)(result?.title) || (result?.title?.length ?? 0) > 200) problems.push('title');
  if (!isBool(result?.secure)) problems.push('secure');
  if (!isNullOr(isStr)(result?.link)) problems.push('link');
  return problems;
}

/** Starts the helper; `call` sends a request and resolves with the whole response message. */
function start() {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  const call = (method, params, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
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
    errorCode(wrong) === -32032 && wrong.error.data?.protocolVersion === 1,
    'another protocol version is refused (-32032)',
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
      r.platform === 'darwin' &&
      r.supports?.background === false &&
      r.supports?.fullControl === true &&
      r.supports?.filter === true,
    `initialize (helper ${r?.helperVersion})`,
    init,
  );
  const again = await call('initialize', { protocolVersion: 1, client: { name: 'smoke', version: '0' } });
  check(errorCode(again) === -32600, 'a second initialize is InvalidRequest (-32600)', again);

  console.log('read-only methods');
  const permissions = await call('permissions.status', {});
  check(
    ok(permissions) && isBool(permissions.result.accessibility) && isBool(permissions.result.screenRecording),
    'permissions.status',
    permissions,
  );
  const granted = permissions.result ?? {};
  console.log(`        accessibility=${granted.accessibility} screenRecording=${granted.screenRecording}`);

  const displays = await call('displays.list', {});
  const list = displays.result?.displays;
  check(
    ok(displays) &&
      Array.isArray(list) &&
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
      list.filter((d) => d.primary).length === 1,
    `displays.list (${list?.length} display(s), primary ${list?.find((d) => d.primary)?.width}x${list?.find((d) => d.primary)?.height} pt @${list?.find((d) => d.primary)?.scale}x)`,
    displays,
  );

  const apps = await call('apps.list', { installed: true });
  const all = apps.result?.apps ?? [];
  const bad = all.filter((a) => appProblems(a).length > 0);
  const ids = new Set(all.map((a) => a.id));
  check(
    ok(apps) && all.length > 0 && bad.length === 0,
    `apps.list {installed: true}: ${all.length} apps`,
    bad.slice(0, 3),
  );
  check(ids.size === all.length, 'apps.list: one entry per bundle id');
  check(all.some((a) => a.running) && all.some((a) => !a.running), 'apps.list: running and installed-only apps');
  const runningOnly = await call('apps.list', { installed: false });
  check(
    ok(runningOnly) && runningOnly.result.apps.every((a) => a.running),
    `apps.list {installed: false}: ${runningOnly.result?.apps?.length} running apps`,
  );
  const missing = await call('apps.list', {});
  check(errorCode(missing) === -32602, 'apps.list without `installed` is InvalidParams (-32602)', missing);

  const front = await call('apps.frontmost', {});
  check(
    ok(front) && (front.result.app === null || (appProblems(front.result.app).length === 0 && front.result.app.active)),
    'apps.frontmost',
    front,
  );

  const cursor = await call('cursor.position', {});
  check(ok(cursor) && isNum(cursor.result.x) && isNum(cursor.result.y), 'cursor.position', cursor);

  const focused = await call('inspect.focused', {});
  if (granted.accessibility)
    check(ok(focused) && inspectProblems(focused.result).length === 0, 'inspect.focused', focused);
  else
    check(
      errorCode(focused) === -32030 && focused.error.data?.permission === 'accessibility',
      'inspect.focused without Accessibility is -32030',
      focused,
    );
  const badPoint = await call('inspect.point', { x: 'left', y: 0 });
  check(errorCode(badPoint) === -32602, 'inspect.point with a bad x is InvalidParams (-32602)', badPoint);

  const unknown = await call('no.such.method', {});
  check(errorCode(unknown) === -32601, 'an unknown method is MethodNotFound (-32601)', unknown);

  console.log('capture.display');
  const primary = list?.find((d) => d.primary);
  const noDisplay = await call('capture.display', {
    display: '4294967295',
    maxWidth: 320,
    maxHeight: 200,
    format: 'jpeg',
  });
  check(errorCode(noDisplay) === -32033, 'an unknown display is NotFound (-32033)', noDisplay);
  if (!granted.screenRecording) {
    const denied = await call('capture.display', {
      display: primary.id,
      maxWidth: 320,
      maxHeight: 200,
      format: 'jpeg',
    });
    check(
      errorCode(denied) === -32030 && denied.error.data?.permission === 'screenRecording',
      'without Screen Recording: -32030 {permission: screenRecording}',
      denied,
    );
  } else if (capture) {
    const shot = await call('capture.display', {
      display: primary.id,
      maxWidth: 320,
      maxHeight: 200,
      format: 'jpeg',
      quality: 0.5,
    });
    const bytes = Buffer.from(shot.result?.data ?? '', 'base64');
    check(
      ok(shot) &&
        shot.result.mime === 'image/jpeg' &&
        bytes.subarray(0, 3).toString('hex') === 'ffd8ff' &&
        shot.result.width <= 320 &&
        shot.result.height <= 200 &&
        shot.result.rect.width === primary.width,
      `a 320x200 JPEG of the primary display: ${shot.result?.width}x${shot.result?.height}, ${bytes.length} bytes`,
      shot.error,
    );
    const png = await call('capture.display', {
      display: primary.id,
      region: { x: primary.x + 10, y: primary.y + 10, width: 100, height: 50 },
      maxWidth: 1000,
      maxHeight: 1000,
      format: 'png',
    });
    const pngBytes = Buffer.from(png.result?.data ?? '', 'base64');
    check(
      ok(png) &&
        pngBytes.subarray(0, 4).toString('hex') === '89504e47' &&
        png.result.rect.width === 100 &&
        png.result.width === Math.round(100 * primary.scale),
      `a region as PNG: ${png.result?.width}x${png.result?.height} px for ${png.result?.rect?.width}x${png.result?.rect?.height} pt`,
      png.error,
    );
  } else console.log('  skip  Screen Recording is granted: pass --capture to take a test screenshot');

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
  const exit2 = await second.exited;
  check(exit2.code === 0, 'EOF on stdin exits 0', exit2);

  if (failures > 0) {
    const log = helper.stderr() + second.stderr();
    if (log) console.log(`\nhelper stderr:\n${log}`);
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
