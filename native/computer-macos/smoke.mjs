#!/usr/bin/env node
// Smoke test for the built macOS helper (native/bin/atelier-computer-darwin, from `pnpm computer:build`): speaks
// computer protocol v1 to it over stdio and checks the shape of each answer. Read-only: it never moves the mouse,
// types, hides or opens apps, asks for permissions or starts control, and never calls the background input methods
// (bg.click, bg.scroll, bg.key, bg.type). With Screen Recording granted it takes screenshots (of the display, and with
// window.capture of one app's window) only when run with --capture, and prints just their size.
//
// The background checks use an app that has a window on screen already (so window.capture never restores a minimized
// one): a common app from the list below, or the one named with --window-app=<bundle id>.
//
//   node native/computer-macos/smoke.mjs [--capture] [--window-app=<bundle id>] [path/to/binary]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const capture = args.includes('--capture');
const windowApp = args.find((a) => a.startsWith('--window-app='))?.slice('--window-app='.length);
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

/** Apps whose windows the background checks may look at, in order: the first with a window on screen is used. */
const WINDOW_APPS = [
  'com.apple.finder',
  'com.apple.Terminal',
  'com.apple.Safari',
  'com.apple.dt.Xcode',
  'com.apple.TextEdit',
  'com.apple.Notes',
  'com.apple.ActivityMonitor',
  'com.apple.Console',
  'com.apple.systempreferences',
  'com.googlecode.iterm2',
  'com.mitchellh.ghostty',
  'dev.warp.Warp-Stable',
  'com.microsoft.VSCode',
  'com.anthropic.claudefordesktop',
  'dev.atelier.app',
];

/**
 * The windows on screen that the helper counts as normal (layer 0, not transparent, at least 40x40 points), front to
 * back, as the window server lists them (no permission needed). Read-only.
 */
function normalWindows() {
  const script = `
    ObjC.import('CoreGraphics');
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(
      $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)));
    JSON.stringify(list
      .filter((w) => w.kCGWindowLayer === 0 && (w.kCGWindowAlpha ?? 1) > 0 && w.kCGWindowBounds.Width >= 40 && w.kCGWindowBounds.Height >= 40)
      .map((w) => ({ id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID, x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y,
        width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height })));`;
  try {
    return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }));
  } catch {
    return null;
  }
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
      r.supports?.background === true &&
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

  console.log('background (read-only)');
  const malformed = await call('bg.inspect', { window: 'abc', x: 0, y: 0 });
  check(errorCode(malformed) === -32602, 'bg.inspect with a malformed window is InvalidParams (-32602)', malformed);
  const goneInspect = await call('bg.inspect', { window: '4294967295', x: 0, y: 0 });
  check(
    errorCode(goneInspect) === -32033 && goneInspect.error.data?.reason === 'gone',
    'bg.inspect on an unknown window is NotFound (-32033, gone)',
    goneInspect,
  );
  const goneFocused = await call('bg.focused', { window: '4294967295' });
  check(
    errorCode(goneFocused) === -32033 && goneFocused.error.data?.reason === 'gone',
    'bg.focused on an unknown window is NotFound (-32033, gone)',
    goneFocused,
  );
  const badSize = await call('window.capture', { app: 'com.apple.finder', maxWidth: 0, maxHeight: 200, format: 'jpeg' });
  check(errorCode(badSize) === -32602, 'window.capture with maxWidth 0 is InvalidParams (-32602)', badSize);
  const noApp = await call('window.capture', {
    app: 'dev.atelier.smoke.no-such-app',
    maxWidth: 320,
    maxHeight: 200,
    format: 'jpeg',
  });
  if (granted.screenRecording)
    check(
      errorCode(noApp) === -32033 && noApp.error.data?.reason === 'notRunning',
      'window.capture of an app that isn\'t running is NotFound (-32033, notRunning)',
      noApp,
    );
  else
    check(
      errorCode(noApp) === -32030 && noApp.error.data?.permission === 'screenRecording',
      'window.capture without Screen Recording: -32030 {permission: screenRecording}',
      noApp,
    );

  // A window that is on screen already, of a common app (or the one asked for).
  const windows = normalWindows();
  const running = all.filter((a) => a.running && a.pid !== null);
  const wanted = windowApp ? [windowApp] : WINDOW_APPS;
  let target = null;
  for (const id of wanted) {
    const pids = new Set(running.filter((a) => a.id === id).map((a) => a.pid));
    const window = windows?.find((w) => pids.has(w.pid));
    if (window) {
      target = { id, window };
      break;
    }
  }
  if (!windows) console.log('  skip  the window list could not be read (osascript)');
  else if (!target)
    console.log(
      `  skip  ${windowApp ? `${windowApp} has` : 'none of the common apps has'} a window on screen: pass --window-app=<bundle id>`,
    );
  else {
    const { id: appId, window: w } = target;
    const center = { x: w.x + w.width / 2, y: w.y + w.height / 2 };
    const windowId = String(w.id);
    console.log(`        using ${appId}'s frontmost window (${w.width}x${w.height} pt)`);
    const inspect = await call('bg.inspect', { window: windowId, ...center });
    const focusedIn = await call('bg.focused', { window: windowId });
    const outside = await call('bg.inspect', { window: windowId, x: w.x - 5, y: w.y - 5 });
    const notANumber = await call('bg.inspect', { window: windowId, x: 'left', y: center.y });
    if (granted.accessibility) {
      check(
        ok(inspect) && inspectProblems(inspect.result).length === 0 && inspect.result.app?.id === appId,
        `bg.inspect at the window's center: role ${inspect.result?.role ?? 'none'}`,
        inspect.error ?? inspectProblems(inspect.result),
      );
      check(
        ok(focusedIn) && inspectProblems(focusedIn.result).length === 0 && focusedIn.result.app?.id === appId,
        `bg.focused: role ${focusedIn.result?.role ?? 'none'}`,
        focusedIn.error ?? inspectProblems(focusedIn.result),
      );
    } else {
      check(
        errorCode(inspect) === -32030 && inspect.error.data?.permission === 'accessibility',
        'bg.inspect without Accessibility is -32030',
        inspect,
      );
    }
    check(errorCode(outside) === -32602, 'bg.inspect at a point outside the window is InvalidParams (-32602)', outside);
    check(errorCode(notANumber) === -32602, 'bg.inspect with a bad x is InvalidParams (-32602)', notANumber);

    if (granted.screenRecording && capture) {
      const shot = await call('window.capture', { app: appId, maxWidth: 640, maxHeight: 400, format: 'jpeg', quality: 0.5 });
      const s = shot.result ?? {};
      const bytes = Buffer.from(s.data ?? '', 'base64');
      const title = s.title;
      check(
        ok(shot) &&
          s.mime === 'image/jpeg' &&
          bytes.subarray(0, 3).toString('hex') === 'ffd8ff' &&
          s.width <= 640 &&
          s.height <= 400 &&
          /^\d+$/.test(s.window) &&
          [s.rect?.x, s.rect?.y, s.rect?.width, s.rect?.height].every(isNum) &&
          (title === null || (isStr(title) && title.length > 0 && title.length <= 200)),
        `window.capture: ${s.width}x${s.height} px for ${s.rect?.width}x${s.rect?.height} pt, title ${title === null ? 'none' : `${title?.length} characters`}`,
        shot.error,
      );
      check(
        s.window === windowId && s.rect?.x === w.x && s.rect?.y === w.y && s.rect?.width === w.width && s.rect?.height === w.height,
        'window.capture took the frontmost window, its rect the window frame in global points',
        { window: s.window, expected: windowId },
      );
      check(
        Math.abs(s.width / s.height - s.rect?.width / s.rect?.height) < 0.02,
        'window.capture keeps the window\'s aspect ratio',
      );
      shot.result = undefined; // the image isn't kept
    } else if (granted.screenRecording) console.log('  skip  pass --capture to take a test window.capture');
  }

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
