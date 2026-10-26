import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerMethods, ComputerNotification, ControllerEvent, HelperApp, InspectPointResult } from '@atelier/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComputerController, matchApp, parseKeys } from './controller.ts';
import type { ComputerHelper } from './helper.ts';
import { changeComputerSettings, readComputerSettings } from './store.ts';

const app = (id: string, name: string, running = true): HelperApp => ({ id, name, path: null, pid: running ? 1 : null, running, active: false, hidden: false, category: null });
const APPS = [
  app('com.apple.TextEdit', 'TextEdit'),
  app('com.apple.Safari', 'Safari'),
  app('com.apple.Terminal', 'Terminal'),
  app('com.apple.mail', 'Mail'),
  app('com.apple.Notes', 'Notes'),
  app('com.1password.1password', '1Password'),
  app('com.apple.systempreferences', 'System Settings'),
];

/** A pretend helper: what's under the pointer and has the keyboard is set by the test; every call is recorded. */
class FakeHelper {
  calls: { method: string; params: unknown }[] = [];
  under: Partial<InspectPointResult> & { app: HelperApp | null } = { app: APPS[0]!, secure: false, link: null };
  focused: Partial<InspectPointResult> & { app: HelperApp | null } = { app: APPS[0]!, secure: false, link: null };
  permissions = { accessibility: true, screenRecording: true };
  front: HelperApp | null = null;
  private listeners = new Set<(n: ComputerNotification) => void>();

  onNotification(listener: (n: ComputerNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  notify(n: ComputerNotification) {
    for (const l of this.listeners) l(n);
  }
  restart() {}
  async shutdown() {}
  async call<M extends keyof ComputerMethods>(method: M, params: ComputerMethods[M]['params']): Promise<ComputerMethods[M]['result']> {
    this.calls.push({ method, params });
    const result = (() => {
      switch (method) {
        case 'permissions.status':
          return this.permissions;
        case 'displays.list':
          return { displays: [{ id: '1', name: 'Main', x: 0, y: 0, width: 1000, height: 500, scale: 2, primary: true }] };
        case 'apps.list':
          return { apps: APPS };
        case 'apps.frontmost':
          return { app: this.front };
        case 'apps.hide':
          return { ids: (params as { ids: string[] }).ids };
        case 'capture.display':
          return { data: 'AAAA', mime: 'image/jpeg', width: 500, height: 250, rect: { x: 0, y: 0, width: 1000, height: 500 } };
        case 'inspect.point':
          return { role: null, title: null, secure: false, link: null, ...this.under };
        case 'inspect.focused':
          return { role: null, title: null, secure: false, link: null, ...this.focused };
        case 'cursor.position':
          return { x: 0, y: 0 };
        default:
          return {};
      }
    })();
    return result as ComputerMethods[M]['result'];
  }
  did(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

let dir: string;
let settingsPath: string;
let helper: FakeHelper;
let events: { sessionId: string; event: ControllerEvent }[];
let overlay: string[];
let controller: ComputerController;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-computer-'));
  settingsPath = join(dir, 'computer-use.json');
  helper = new FakeHelper();
  events = [];
  overlay = [];
  controller = new ComputerController({
    helper: helper as unknown as ComputerHelper,
    hasHelper: true,
    settingsPath,
    overlay: { show: () => overlay.push('show'), hide: () => overlay.push('hide'), esc: (phase) => overlay.push(`esc:${phase}`), paused: (on) => overlay.push(`paused:${on}`) },
    windows: { hide() {}, restore() {} },
    event: (_backend, sessionId, event) => events.push({ sessionId, event }),
    changed() {},
    platform: 'darwin',
  });
  await changeComputerSettings(settingsPath, (s) => ({ ...s, enabled: true }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SIZE = { maxWidth: 1280, maxHeight: 800 };
const ask = <M extends keyof ControllerMethods>(method: M, params: ControllerMethods[M]['params'], sessionId = 's1') => controller.handle('local', sessionId, method, params);
type ControllerMethods = import('@atelier/protocol').ControllerMethods;

/** Allows apps for s1, takes a screenshot (500×250 of a 1000×500 screen) and full control. */
async function ready(grants: { id: string; tier: 'view' | 'click' | 'full' }[]) {
  await controller.grant('local', 's1', grants, false);
  await controller.allowControl('local', 's1', false);
  await ask('screenshot', { size: SIZE });
  expect(await ask('control.request', {})).toEqual({ granted: true });
}

describe('computer use settings', () => {
  it('starts off, with the password managers denied', async () => {
    rmSync(settingsPath);
    const settings = await readComputerSettings(settingsPath);
    expect(settings.enabled).toBe(false);
    expect(settings.mode).toBe('background');
    expect(settings.denied.map((a) => a.name)).toContain('1Password');
  });

  it('refuses every request while it is off', async () => {
    await changeComputerSettings(settingsPath, (s) => ({ ...s, enabled: false }));
    await expect(ask('access.state', {})).rejects.toThrow(/off on this computer/);
  });
});

describe('what a session may use', () => {
  it('offers apps with their default tier, and never denied or system apps', async () => {
    const { apps, unknown } = await ask('access.prepare', { names: ['Safari', 'terminal', '1Password', 'System Settings', 'Nope'] });
    expect(unknown).toEqual(['Nope']);
    const by = Object.fromEntries(apps.map((a) => [a.app.name, a]));
    expect(by.Safari).toMatchObject({ category: 'browser', tier: 'view', maxTier: 'full', denied: false });
    expect(by.Terminal).toMatchObject({ category: 'terminal', tier: 'click', maxTier: 'click' });
    expect(by['1Password']).toMatchObject({ denied: true });
    expect(by['System Settings']).toMatchObject({ tier: null, maxTier: null });
    // Allowing them anyway gives nothing for those, and no more than a terminal may get.
    await controller.grant(
      'local',
      's1',
      [
        { id: 'com.apple.Terminal', tier: 'full' },
        { id: 'com.1password.1password', tier: 'full' },
        { id: 'com.apple.systempreferences', tier: 'full' },
      ],
      false,
    );
    expect((await ask('access.state', {})).apps).toEqual([{ app: { id: 'com.apple.Terminal', name: 'Terminal' }, tier: 'click' }]);
  });

  it('keeps grants to the session unless allowed always, and a denied app loses them', async () => {
    await controller.grant('local', 's1', [{ id: 'com.apple.Notes', tier: 'full' }], false);
    expect((await ask('access.state', {}, 's2')).apps).toEqual([]);
    await controller.grant('local', 's1', [{ id: 'com.apple.TextEdit', tier: 'full' }], true);
    expect((await ask('access.state', {}, 's2')).apps.map((g) => g.app.name)).toEqual(['TextEdit']);
    // Another backend (a server) doesn't get this computer's always-allowed apps.
    expect((await controller.handle('https://server.example', 's2', 'access.state', {})).apps).toEqual([]);
    await controller.settings((s) => ({ ...s, denied: [...s.denied, { id: 'com.apple.Notes', name: 'Notes' }] }));
    expect((await ask('access.state', {})).apps.map((g) => g.app.name)).toEqual(['TextEdit']);
  });

  it('shows only the allowed apps in screenshots', async () => {
    await expect(ask('screenshot', { size: SIZE })).rejects.toThrow(/ComputerAccess/);
    await controller.grant('local', 's1', [{ id: 'com.apple.Safari', tier: 'view' }], false);
    const shot = await ask('screenshot', { size: SIZE });
    expect(shot).toMatchObject({ width: 500, height: 250, display: 'Main' });
    expect(helper.did('capture.display').at(-1)?.params).toMatchObject({ apps: ['com.apple.Safari'] });
  });
});

describe('full control', () => {
  it('asks the person in background mode, hides what it may not use while it acts, and shows it again', async () => {
    await controller.grant('local', 's1', [{ id: 'com.apple.TextEdit', tier: 'full' }], false);
    expect(await ask('control.request', {})).toEqual({ granted: false, reason: 'ask' });
    await controller.allowControl('local', 's1', false);
    expect(await ask('control.request', {})).toEqual({ granted: true });
    expect(overlay).toContain('show');
    // Others are hidden while it works (not the allowed app, never the system's).
    expect(helper.did('apps.hide')[0]?.params).toEqual({ ids: ['com.apple.Safari', 'com.apple.Terminal', 'com.apple.mail', 'com.apple.Notes', 'com.1password.1password'] });
    // One conversation at a time.
    await controller.grant('local', 's2', [{ id: 'com.apple.TextEdit', tier: 'full' }], false);
    expect(await ask('control.request', {}, 's2')).toMatchObject({ granted: false, reason: /Another conversation/ });
    await ask('turn.end', {});
    expect(overlay.at(-1)).toBe('hide');
    expect(helper.did('apps.unhide')[0]?.params).toEqual({ ids: ['com.apple.Safari', 'com.apple.Terminal', 'com.apple.mail', 'com.apple.Notes', 'com.1password.1password'] });
  });

  it('takes the computer as it is in Full control: no asking, nothing hidden, every app but the denied ones', async () => {
    await controller.settings((s) => ({ ...s, mode: 'full' }));
    // No app allowed one by one, and none needed.
    const prepared = await ask('access.prepare', { names: ['Safari', 'Terminal', '1Password'] });
    expect(prepared.apps.map((a) => [a.app.name, a.granted])).toEqual([
      ['Safari', 'full'],
      ['Terminal', 'full'],
      ['1Password', null],
    ]);
    expect(await ask('access.state', {})).toMatchObject({ apps: [], mode: 'full', denied: expect.arrayContaining(['1Password']) });
    expect(await ask('screenshot', { size: SIZE })).toMatchObject({ note: 'The screen as the person sees it; their denied apps are left out.' });
    expect(helper.did('capture.display').at(-1)?.params).toMatchObject({ exclude: expect.arrayContaining(['com.1password.1password']) });
    expect(helper.did('capture.display').at(-1)?.params).not.toHaveProperty('apps');
    expect(await ask('control.request', {})).toEqual({ granted: true });
    expect(helper.did('apps.hide')).toHaveLength(0);
    expect(overlay).toEqual(['show']);

    const batch = async (actions: ControllerMethods['control.batch']['params']['actions']) => (await ask('control.batch', { actions, size: SIZE })).results;
    // Atelier has the keyboard at first: typing is refused, switching apps isn't.
    helper.focused = { app: app('dev.atelier.app', 'Atelier') };
    expect((await batch([{ action: 'type', text: 'x' }]))[0]).toMatchObject({ ok: false, note: /Atelier, part of the system or Atelier: never used\. Bring the app you need to the front/ });
    expect(await batch([{ action: 'key', text: 'cmd+space' }])).toEqual([{ action: 'key', ok: true }]);
    expect(await batch([{ action: 'key', text: 'Command+Tab' }])).toEqual([{ action: 'key', ok: true }]);
    expect(helper.did('key.press').map((c) => c.params)).toEqual([{ keys: ['cmd', 'space'] }, { keys: ['command', 'tab'] }]);
    // A browser and a terminal take clicks and typing; a denied app and Atelier nothing.
    helper.under = { app: APPS[1]! };
    helper.focused = { app: APPS[1]! };
    expect(await batch([{ action: 'left_click', coordinate: [10, 10] }, { action: 'type', text: 'amazon.de' }])).toEqual([
      { action: 'left_click', ok: true },
      { action: 'type', ok: true },
    ]);
    helper.under = { app: APPS[2]! };
    helper.focused = { app: APPS[2]! };
    expect(await batch([{ action: 'right_click', coordinate: [10, 10] }, { action: 'type', text: 'ls' }])).toEqual([
      { action: 'right_click', ok: true },
      { action: 'type', ok: true },
    ]);
    helper.under = { app: APPS[5]! };
    expect((await batch([{ action: 'left_click', coordinate: [10, 10] }]))[0]).toMatchObject({ ok: false, note: "1Password is on the person's denied list: never used." });
    helper.under = { app: app('dev.atelier.app', 'Atelier') };
    expect((await batch([{ action: 'left_click', coordinate: [10, 10] }]))[0]).toMatchObject({ ok: false, note: /part of the system or Atelier/ });
    await ask('turn.end', {});
    expect(helper.did('apps.unhide')).toHaveLength(0);
  });

  it('needs the Accessibility permission', async () => {
    helper.permissions = { accessibility: false, screenRecording: true };
    await controller.grant('local', 's1', [{ id: 'com.apple.TextEdit', tier: 'full' }], false);
    await controller.allowControl('local', 's1', false);
    expect(await ask('control.request', {})).toMatchObject({ granted: false, reason: /Accessibility/ });
  });

  it('maps screenshot pixels to the screen and acts only where it may', async () => {
    await ready([
      { id: 'com.apple.TextEdit', tier: 'full' },
      { id: 'com.apple.Safari', tier: 'view' },
    ]);
    const batch = (actions: ControllerMethods['control.batch']['params']['actions']) => ask('control.batch', { actions, size: SIZE });
    expect((await batch([{ action: 'left_click', coordinate: [100, 50] }])).results).toEqual([{ action: 'left_click', ok: true }]);
    expect(helper.did('mouse.click').at(-1)?.params).toMatchObject({ x: 200, y: 100, button: 'left', count: 1 });

    // Safari may only be looked at.
    helper.under = { app: APPS[1]! };
    expect((await batch([{ action: 'left_click', coordinate: [10, 10] }, { action: 'left_click', coordinate: [20, 20] }])).results).toEqual([
      { action: 'left_click', ok: false, note: 'You may only look at Safari.' },
    ]);
    // An app it wasn't given, or the system, is never clicked.
    helper.under = { app: APPS[3]! };
    expect((await batch([{ action: 'double_click', coordinate: [10, 10] }])).results[0]).toMatchObject({ ok: false, note: 'Mail is there, which you may not use.' });
    helper.under = { app: APPS[6]! };
    expect((await batch([{ action: 'left_click', coordinate: [10, 10] }])).results[0]).toMatchObject({ ok: false, note: /part of the system/ });
    expect(helper.did('mouse.click')).toHaveLength(1);
  });

  it('never types into a password field, an app it may only click, or under secure input', async () => {
    await ready([
      { id: 'com.apple.TextEdit', tier: 'full' },
      { id: 'com.apple.Terminal', tier: 'click' },
    ]);
    const type = async () => (await ask('control.batch', { actions: [{ action: 'type', text: 'secret' }], size: SIZE })).results[0];
    helper.focused = { app: APPS[0]!, secure: true };
    expect(await type()).toMatchObject({ ok: false, note: /password field/ });
    helper.focused = { app: APPS[2]! };
    expect(await type()).toMatchObject({ ok: false, note: 'You may not type in Terminal.' });
    helper.focused = { app: APPS[0]! };
    helper.notify({ method: 'control.secureInput', params: { on: true } });
    expect(await type()).toMatchObject({ ok: false, note: /secure input/ });
    helper.notify({ method: 'control.secureInput', params: { on: false } });
    expect(await type()).toEqual({ action: 'type', ok: true });
    expect(helper.did('key.type')).toHaveLength(1);
  });

  it("doesn't click links in mail", async () => {
    await ready([{ id: 'com.apple.mail', tier: 'full' }]);
    helper.under = { app: APPS[3]!, link: 'https://evil.example/' };
    const { results } = await ask('control.batch', { actions: [{ action: 'left_click', coordinate: [10, 10] }], size: SIZE });
    expect(results[0]).toMatchObject({ ok: false, note: /links in mail and messages aren't clicked/ });
    expect(helper.did('mouse.click')).toHaveLength(0);
  });

  it('stops when the person holds Esc, and gives the computer back when they use it', async () => {
    await ready([{ id: 'com.apple.TextEdit', tier: 'full' }]);
    helper.notify({ method: 'control.esc', params: { phase: 'down', heldMs: 0 } });
    helper.notify({ method: 'control.esc', params: { phase: 'stopped', heldMs: 1000 } });
    await expect.poll(() => events).toEqual([{ sessionId: 's1', event: { type: 'stopped' } }]);
    expect(overlay).toEqual(['show', 'esc:down', 'esc:stopped', 'hide']);
    expect(helper.did('control.end')).toHaveLength(1);
    await expect(ask('control.batch', { actions: [{ action: 'left_click', coordinate: [1, 1] }], size: SIZE })).rejects.toThrow(/FullControl/);

    // Taking it again lifts the stop.
    expect(await ask('control.request', {})).toEqual({ granted: true });
    expect(helper.did('control.resume')).toHaveLength(2);
    // The person reaching for the mouse pauses it: the rest of the batch waits, then stops so it looks again; control stays.
    await controller.settings((s) => ({ ...s, mode: 'full' }));
    const batch = ask('control.batch', { actions: [{ action: 'wait', duration: 0.2 }, { action: 'left_click', coordinate: [1, 1] }], size: SIZE });
    setTimeout(() => helper.notify({ method: 'control.userInput', params: { kind: 'mouse' } }), 50);
    expect((await batch).results).toEqual([
      { action: 'wait', ok: true },
      { action: 'left_click', ok: false, note: 'Not done: the person used the mouse or keyboard meanwhile, so the screen may have changed. Take a Screenshot, then go on.' },
    ]);
    expect(overlay.slice(-2)).toEqual(['paused:true', 'paused:false']);
    expect(events).toEqual([{ sessionId: 's1', event: { type: 'stopped' } }]);
    expect(helper.did('control.end')).toHaveLength(1);
    expect(await ask('control.batch', { actions: [{ action: 'left_click', coordinate: [1, 1] }], size: SIZE })).toEqual({ results: [{ action: 'left_click', ok: true }] });
  });

  it('keeps the computer through a permission card in Full control, and puts the app it worked in back in front', async () => {
    await controller.settings((s) => ({ ...s, mode: 'full' }));
    await ask('screenshot', { size: SIZE });
    expect(await ask('control.request', {})).toEqual({ granted: true });
    helper.front = APPS[1]!;
    await ask('turn.wait', { kind: 'permission' });
    expect(helper.did('control.end')).toHaveLength(0);
    // The person answers the card in Atelier, which takes the keyboard; the next batch brings Safari back first.
    helper.front = app('dev.atelier.app', 'Atelier');
    await ask('control.batch', { actions: [{ action: 'left_click', coordinate: [1, 1] }], size: SIZE });
    expect(helper.did('apps.open').at(-1)?.params).toEqual({ id: 'com.apple.Safari', activate: true });
    // A question ends it: the person answers, the agent waits.
    await ask('turn.wait', { kind: 'question' });
    expect(helper.did('control.end')).toHaveLength(1);
  });

  it('hands the computer back for any card in Background', async () => {
    await ready([{ id: 'com.apple.TextEdit', tier: 'full' }]);
    await ask('turn.wait', { kind: 'permission' });
    expect(helper.did('control.end')).toHaveLength(1);
  });
});

describe('keys and names', () => {
  it('splits key combinations', () => {
    expect(parseKeys('Cmd+Shift+T')).toEqual(['cmd', 'shift', 't']);
    expect(parseKeys(' return ')).toEqual(['return']);
    expect(parseKeys('')).toEqual([]);
  });

  it('finds an app by id, name, or part of its name', () => {
    expect(matchApp(APPS, 'com.apple.safari')?.name).toBe('Safari');
    expect(matchApp(APPS, 'TextEdit.app')?.name).toBe('TextEdit');
    expect(matchApp(APPS, 'term')?.name).toBe('Terminal');
    expect(matchApp(APPS, 'pass')?.name).toBe('1Password');
    expect(matchApp(APPS, 'Xcode')).toBeUndefined();
  });
});
