import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerMethods, ComputerNotification, ControllerEvent, HelperApp, InspectPointResult } from '@atelier/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComputerController, matchApp, parseKeys } from './controller.ts';
import { HelperError, type ComputerHelper } from './helper.ts';
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
  /** The apps `apps.list` answers with. */
  apps = APPS;
  front: HelperApp | null = null;
  /** Whether it can work in a window without the mouse and keyboard. */
  background = false;
  /** A background click the app won't take. */
  refuse: HelperError | null = null;
  /** The app brings itself to the front on a background key (a browser opening a tab). */
  fronts = false;
  /** Captures of a window that isn't there yet, before it appears (an app just opened). */
  noWindowFor = 0;
  async start() {
    return { protocolVersion: 1, helperVersion: 'fake', platform: 'darwin' as const, supports: { background: this.background, fullControl: true, filter: true } };
  }
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
          return { apps: this.apps };
        case 'apps.frontmost':
          return { app: this.front };
        case 'bg.click':
          return this.refuse ? Promise.reject(this.refuse) : {};
        case 'bg.key':
          return this.fronts ? { fronted: true } : {};
        case 'window.capture':
          if ((params as { app: string }).app === 'com.apple.Notes') return Promise.reject(new HelperError('no window', -32033));
          if (this.noWindowFor > 0) return (this.noWindowFor--, Promise.reject(new HelperError('no window', -32033)));
          return { data: 'BBBB', mime: 'image/jpeg', width: 400, height: 300, rect: { x: 100, y: 50, width: 800, height: 600 }, window: '42', title: 'Untitled' };
        case 'bg.inspect':
          return { role: null, title: null, secure: false, link: null, ...this.under };
        case 'bg.focused':
          return { role: null, title: null, secure: false, link: null, ...this.focused };
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
/** Whether another monitor takes Atelier's windows (the test's `windows.moveAway` answer). */
let otherMonitor: boolean;
/** What happened to Atelier's windows: stepped aside, moved, brought forward, asking for attention. */
let wins: string[];

beforeEach(async () => {
  otherMonitor = false;
  wins = [];
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
    windows: {
      hide: (display) => wins.push(`hide:${display?.id ?? 'all'}`),
      restore() {},
      focus: () => (overlay.push('focus'), wins.push('focus')),
      moveAway: (display) => (wins.push(`moveAway:${display.id}`), otherMonitor),
      moveBack: () => wins.push('moveBack'),
      attention: () => wins.push('attention'),
    },
    event: (_backend, sessionId, event) => events.push({ sessionId, event }),
    changed() {},
    platform: 'darwin',
  });
  await changeComputerSettings(settingsPath, (s) => ({ ...s, enabled: true }), 'darwin');
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
    const settings = await readComputerSettings(settingsPath, 'darwin');
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
    expect(by.Safari).toMatchObject({ category: 'browser', tier: 'full', maxTier: 'full', denied: false });
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
    expect(helper.did('apps.hide')[0]?.params).toEqual({ ids: ['com.apple.Safari', 'com.apple.Terminal', 'com.apple.mail', 'com.apple.Notes', 'com.1password.1password'], display: '1' });
    // One conversation at a time.
    await controller.grant('local', 's2', [{ id: 'com.apple.TextEdit', tier: 'full' }], false);
    expect(await ask('control.request', {}, 's2')).toMatchObject({ granted: false, reason: /Another conversation/ });
    await ask('turn.end', {});
    // Done: the overlay goes, and Atelier comes back to the front with the reply.
    expect(overlay.slice(-2)).toEqual(['hide', 'focus']);
    expect(helper.did('apps.activate').at(-1)?.params).toEqual({ pid: process.pid });
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
      { action: 'left_click', ok: false, note: 'You may only look at Safari. Ask with ComputerAccess for more: the person can allow it on the card.' },
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
    expect(await type()).toMatchObject({ ok: false, note: /^You may not type in Terminal\. Ask with ComputerAccess for more/ });
    helper.focused = { app: APPS[0]! };
    helper.notify({ method: 'control.secureInput', params: { on: true } });
    expect(await type()).toMatchObject({ ok: false, note: /secure input/ });
    helper.notify({ method: 'control.secureInput', params: { on: false } });
    expect(await type()).toEqual({ action: 'type', ok: true });
    expect(helper.did('key.type')).toHaveLength(1);
  });

  it('types long text in pieces the helper finishes in time, between characters', async () => {
    await ready([{ id: APPS[0]!.id, tier: 'full' }]);
    helper.focused = { app: APPS[0]! };
    const text = '🙂'.repeat(450);
    expect((await ask('control.batch', { actions: [{ action: 'type', text }], size: SIZE })).results[0]).toEqual({ action: 'type', ok: true });
    const pieces = helper.did('key.type').map((call) => (call.params as { text: string }).text);
    expect(pieces.map((piece) => Array.from(piece).length)).toEqual([400, 50]);
    expect(pieces.join('')).toBe(text);
  });

  it("doesn't click links in mail", async () => {
    await ready([{ id: 'com.apple.mail', tier: 'full' }]);
    helper.under = { app: APPS[3]!, link: 'https://evil.example/' };
    const { results } = await ask('control.batch', { actions: [{ action: 'left_click', coordinate: [10, 10] }], size: SIZE });
    expect(results[0]).toMatchObject({ ok: false, note: /links in mail and messages aren't clicked/ });
    expect(helper.did('mouse.click')).toHaveLength(0);
  });

  it('hands the computer back when the person holds Esc, and keeps it from the agent until the turn ends', async () => {
    await ready([{ id: 'com.apple.TextEdit', tier: 'full' }]);
    const batch = ask('control.batch', { actions: [{ action: 'wait', duration: 5 }, { action: 'left_click', coordinate: [1, 1] }], size: SIZE });
    setTimeout(() => {
      helper.notify({ method: 'control.esc', params: { phase: 'down', heldMs: 0 } });
      helper.notify({ method: 'control.esc', params: { phase: 'stopped', heldMs: 1000 } });
    }, 50);
    const started = Date.now();
    // The wait ends at once, and the agent hears that the computer is the person's for this turn.
    expect((await batch).results).toEqual([
      { action: 'wait', ok: true },
      { action: 'left_click', ok: false, note: expect.stringMatching(/^The person took the computer back \(held Esc\)\. Don’t use the computer again in this turn/) },
    ]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(events).toEqual([{ sessionId: 's1', event: { type: 'stopped' } }]);
    expect(overlay).toEqual(['show', 'esc:down', 'esc:stopped', 'hide']);
    expect(helper.did('control.end')).toHaveLength(1);
    // Until the turn ends nothing more is looked at or done; then it may again.
    expect(await ask('control.request', {})).toMatchObject({ granted: false, reason: expect.stringMatching(/took the computer back/) });
    await expect(ask('screenshot', { size: SIZE })).rejects.toThrow(/took the computer back/);
    await ask('turn.end', {});
    expect(await ask('control.request', {})).toEqual({ granted: true });
    // Once when it began, once when the turn ended (the lock lifted), once when it began again.
    expect(helper.did('control.resume')).toHaveLength(3);
  });

  it('goes on when the person moves the pointer, waits while they click or type, and stops only when they switch apps', async () => {
    await controller.settings((s) => ({ ...s, mode: 'full' }));
    await ask('screenshot', { size: SIZE });
    expect(await ask('control.request', {})).toEqual({ granted: true });
    helper.front = APPS[0]!;
    const run = (actions: ControllerMethods['control.batch']['params']['actions']) => ask('control.batch', { actions, size: SIZE });
    // Moving the pointer: nothing waits, nothing stops.
    let batch = run([{ action: 'wait', duration: 0.2 }, { action: 'left_click', coordinate: [1, 1] }]);
    setTimeout(() => helper.notify({ method: 'control.userInput', params: { kind: 'move' } }), 50);
    expect((await batch).results.map((r) => r.ok)).toEqual([true, true]);
    expect(overlay).not.toContain('paused:true');
    // A click in the same app: it waits until they stop, then goes on.
    batch = run([{ action: 'wait', duration: 0.2 }, { action: 'left_click', coordinate: [1, 1] }]);
    setTimeout(() => helper.notify({ method: 'control.userInput', params: { kind: 'mouse' } }), 50);
    expect((await batch).results.map((r) => r.ok)).toEqual([true, true]);
    expect(overlay.slice(-2)).toEqual(['paused:true', 'paused:false']);
    // They switch apps: the rest stops, and it looks again.
    batch = run([{ action: 'wait', duration: 0.2 }, { action: 'left_click', coordinate: [1, 1] }]);
    setTimeout(() => {
      helper.front = APPS[4]!;
      helper.notify({ method: 'control.userInput', params: { kind: 'key' } });
    }, 50);
    expect((await batch).results).toEqual([
      { action: 'wait', ok: true },
      { action: 'left_click', ok: false, note: 'Not done: the person brought Notes to the front meanwhile. Take a Screenshot, then go on.' },
    ]);
    expect(helper.did('control.end')).toHaveLength(0);
  });

  it('keeps the computer through a permission card in Full control, and puts the app it worked in back in front', async () => {
    await controller.settings((s) => ({ ...s, mode: 'full' }));
    await ask('screenshot', { size: SIZE });
    expect(await ask('control.request', {})).toEqual({ granted: true });
    helper.front = APPS[1]!;
    await ask('turn.wait', { kind: 'permission' });
    expect(helper.did('control.end')).toHaveLength(0);
    // Atelier comes forward, where the card is, while it keeps the computer (and says so if it can't).
    expect(overlay.at(-1)).toBe('focus');
    expect(wins.slice(-2)).toEqual(['focus', 'attention']);
    expect(helper.did('apps.activate')).toHaveLength(1);
    // The person answers the card in Atelier, which takes the keyboard; the next batch brings Safari back first.
    helper.front = app('dev.atelier.app', 'Atelier');
    await ask('control.batch', { actions: [{ action: 'left_click', coordinate: [1, 1] }], size: SIZE });
    expect(helper.did('apps.open').at(-1)?.params).toEqual({ id: 'com.apple.Safari', activate: true });
    // A question ends it: the person answers, the agent waits.
    await ask('turn.wait', { kind: 'question' });
    expect(helper.did('control.end')).toHaveLength(1);
  });

  it('brings Atelier forward for a question asked after it gave the mouse back, and says so where it can’t come forward', async () => {
    await controller.settings((s) => ({ ...s, mode: 'full' }));
    await ask('screenshot', { size: SIZE });
    expect(await ask('control.request', {})).toEqual({ granted: true });
    await ask('control.release', {});
    wins.length = 0;
    helper.front = APPS[1]!;
    await ask('turn.wait', { kind: 'question' });
    expect(wins).toEqual(['focus', 'attention']);
    // Answered, it acts again: the app Atelier came in front of goes back in front first.
    helper.front = app('dev.atelier.app', 'Atelier');
    await ask('control.request', {});
    await ask('control.batch', { actions: [{ action: 'left_click', coordinate: [1, 1] }], size: SIZE });
    expect(helper.did('apps.open').at(-1)?.params).toEqual({ id: APPS[1]!.id, activate: true });
    await ask('control.release', {});
    // A permission card without the mouse: it acts right after, so the keyboard stays where it is; Atelier only says it waits.
    wins.length = 0;
    await ask('turn.wait', { kind: 'permission' });
    expect(wins).toEqual(['attention']);
    // A session that didn't touch the computer this turn leaves the windows alone.
    await ask('turn.end', {});
    wins.length = 0;
    await ask('turn.wait', { kind: 'question' });
    expect(wins).toEqual([]);
  });

  it('moves Atelier to another monitor while it has the computer, back when the turn ends, and not with the setting off', async () => {
    await controller.settings((s) => ({ ...s, mode: 'full' }));
    otherMonitor = true;
    await ask('screenshot', { size: SIZE });
    await ask('control.request', {});
    expect(wins).toContain('moveAway:1');
    // A question keeps it there, in view; the end of the turn brings it back.
    await ask('turn.wait', { kind: 'question' });
    expect(wins).not.toContain('moveBack');
    await ask('turn.end', {});
    expect(wins.at(-1)).toBe('moveBack');
    wins.length = 0;
    await controller.settings((s) => ({ ...s, moveAway: false }));
    await ask('screenshot', { size: SIZE });
    await ask('control.request', {});
    expect(wins.filter((o) => o.startsWith('moveAway'))).toEqual([]);
  });

  it('hides other apps and steps Atelier aside only on the monitor it works on', async () => {
    await ready([{ id: 'com.apple.TextEdit', tier: 'full' }]);
    const hid = helper.did('apps.hide');
    expect(hid.length).toBeGreaterThan(0);
    expect(hid.every((c) => (c.params as { display?: string }).display === '1')).toBe(true);
    expect(wins).toContain('hide:1');
  });

  it('hands the computer back for any card in Background', async () => {
    await ready([{ id: 'com.apple.TextEdit', tier: 'full' }]);
    await ask('turn.wait', { kind: 'permission' });
    expect(helper.did('control.end')).toHaveLength(1);
  });
});

describe('in the background', () => {
  it('works in one app’s window without taking the mouse and keyboard, and refuses what needs Full control', async () => {
    helper.background = true;
    await controller.grant('local', 's1', [{ id: 'com.apple.TextEdit', tier: 'full' }, { id: 'com.apple.Safari', tier: 'click' }], false);
    expect(await ask('access.state', {})).toMatchObject({ mode: 'background', background: true });
    // Two apps: it must say which.
    await expect(ask('screenshot', { size: SIZE })).rejects.toThrow(/Say which app to look at/);
    const shot = await ask('screenshot', { app: 'textedit', size: SIZE });
    expect(shot).toMatchObject({ width: 400, height: 300, display: 'TextEdit’s window “Untitled”' });
    expect(helper.did('window.capture').at(-1)?.params).toMatchObject({ app: 'com.apple.TextEdit' });
    // Nothing shows on the screen: the person's screen stays as it is.
    expect(overlay).toEqual([]);
    // Image pixels map onto the window's rect; nothing takes the mouse.
    const batch = async (actions: ControllerMethods['control.batch']['params']['actions']) => (await ask('control.batch', { actions, size: SIZE })).results;
    expect(await batch([{ action: 'left_click', coordinate: [200, 150] }, { action: 'type', text: 'hi', replace: true }, { action: 'scroll', direction: 'down' }])).toEqual([
      { action: 'left_click', ok: true },
      { action: 'type', ok: true },
      { action: 'scroll', ok: true },
    ]);
    expect(helper.did('bg.click').at(-1)?.params).toEqual({ window: '42', x: 500, y: 350, button: 'left', count: 1, modifiers: [] });
    // On a Mac the helper clears the field itself, the way the app takes it.
    expect(helper.did('bg.key')).toHaveLength(0);
    expect(helper.did('bg.type').at(-1)?.params).toEqual({ window: '42', text: 'hi', replace: true });
    expect(helper.did('bg.scroll').at(-1)?.params).toMatchObject({ window: '42', x: 500, y: 350, dy: 3 });
    expect(helper.did('control.begin')).toHaveLength(0);
    expect(helper.did('mouse.click')).toHaveLength(0);
    // Its password fields, and what needs Full control.
    helper.focused = { app: APPS[0]!, secure: true };
    expect((await batch([{ action: 'type', text: 'x' }]))[0]).toMatchObject({ ok: false, note: /password field/ });
    expect((await batch([{ action: 'left_click_drag', start: [1, 1], coordinate: [5, 5] }]))[0]).toMatchObject({ ok: false, note: /Dragging needs Full control/ });
    // The other app, click only: typing refused, with how to get more.
    await ask('screenshot', { app: 'Safari', size: SIZE });
    helper.focused = { app: APPS[1]! };
    expect((await batch([{ action: 'type', text: 'x' }]))[0]).toMatchObject({ ok: false, note: /You may not type in Safari\. Ask with ComputerAccess for more/ });
    // An app it may not use isn't looked at.
    await expect(ask('screenshot', { app: 'Mail', size: SIZE })).rejects.toThrow(/You may not use Mail/);
    await ask('turn.end', {});
    expect(overlay).toEqual([]);
  });

  it('types a number given as a key', async () => {
    helper.background = true;
    await controller.grant('local', 's1', [{ id: 'com.apple.TextEdit', tier: 'full' }], false);
    await ask('screenshot', { app: 'TextEdit', size: SIZE });
    const { results } = await ask('control.batch', { actions: [{ action: 'key', text: '2340' }, { action: 'key', text: '2340*17.5%' }, { action: 'key', text: '7' }, { action: 'key', text: 'cmd+1' }], size: SIZE });
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
    expect(helper.did('bg.type').map((c) => (c.params as { text: string }).text)).toEqual(['2340', '2340*17.5%']);
    expect(helper.did('bg.key').map((c) => (c.params as { keys: string[] }).keys)).toEqual([['7'], ['cmd', '1']]);
  });

  it('types into the field a type action aims at, clicking it first', async () => {
    helper.background = true;
    await controller.grant('local', 's1', [{ id: 'com.apple.TextEdit', tier: 'full' }], false);
    await ask('screenshot', { app: 'TextEdit', size: SIZE });
    const { results } = await ask('control.batch', { actions: [{ action: 'type', text: 'Berlin', coordinate: [200, 150] }], size: SIZE });
    expect(results).toEqual([{ action: 'type', ok: true }]);
    const order = helper.calls.map((c) => c.method).filter((m) => m === 'bg.click' || m === 'bg.type');
    expect(order).toEqual(['bg.click', 'bg.type']);
    expect(helper.did('bg.click').at(-1)?.params).toMatchObject({ x: 500, y: 350 });
  });

  it('shows the software cursor where it clicks, keeps it there while typing, and takes it away at the end', async () => {
    helper.background = true;
    await controller.grant('local', 's1', [{ id: 'com.apple.TextEdit', tier: 'full' }], false);
    await ask('screenshot', { app: 'TextEdit', size: SIZE });
    await ask('control.batch', { actions: [{ action: 'left_click', coordinate: [200, 150] }, { action: 'type', text: 'hi' }], size: SIZE });
    expect(helper.did('bg.cursor').map((c) => c.params)).toEqual([
      { window: '42', x: 500, y: 350, click: true },
      { window: '42', x: 500, y: 350 },
    ]);
    await ask('turn.end', {});
    expect(helper.did('bg.cursorHide')).toHaveLength(1);
    // A new turn's typing has no point to show until it clicks.
    await ask('screenshot', { app: 'TextEdit', size: SIZE });
    await ask('control.batch', { actions: [{ action: 'type', text: 'more' }], size: SIZE });
    expect(helper.did('bg.cursor')).toHaveLength(2);
  });

  it('works again in the background after the person held Esc in an earlier turn', async () => {
    // Full control first, stopped with Esc: the helper refuses all input until it's told to go on.
    await ready([{ id: 'com.apple.TextEdit', tier: 'full' }]);
    helper.notify({ method: 'control.esc', params: { phase: 'stopped', heldMs: 1000 } });
    await ask('turn.end', {});
    const resumes = helper.did('control.resume').length;
    // The next turn, in the background: the lock is lifted before anything is done.
    await controller.settings((s) => ({ ...s, mode: 'background' }));
    helper.background = true;
    await ask('screenshot', { app: 'TextEdit', size: SIZE });
    expect((await ask('control.batch', { actions: [{ action: 'left_click', coordinate: [200, 150] }], size: SIZE })).results[0]).toEqual({ action: 'left_click', ok: true });
    expect(helper.did('control.resume')).toHaveLength(resumes);
    expect(helper.calls.findIndex((c) => c.method === 'bg.click')).toBeGreaterThan(helper.calls.findLastIndex((c) => c.method === 'control.resume'));
  });

  it('keeps the lock while the session that held Esc is still in its turn', async () => {
    await ready([{ id: 'com.apple.TextEdit', tier: 'full' }]);
    helper.notify({ method: 'control.esc', params: { phase: 'stopped', heldMs: 1000 } });
    const resumes = helper.did('control.resume').length;
    // Another session in the background: the computer is still the person's.
    await controller.grant('local', 's2', [{ id: 'com.apple.TextEdit', tier: 'full' }], false);
    await controller.settings((s) => ({ ...s, mode: 'background' }));
    helper.background = true;
    await ask('screenshot', { app: 'TextEdit', size: SIZE }, 's2');
    await ask('control.batch', { actions: [{ action: 'left_click', coordinate: [1, 1] }], size: SIZE }, 's2');
    expect(helper.did('control.resume')).toHaveLength(resumes);
  });

  it('works in a Chromium browser in the background, and says when a spot needs Full control', async () => {
    helper.background = true;
    helper.apps = [...APPS, app('com.google.Chrome', 'Google Chrome')];
    await controller.grant('local', 's1', [{ id: 'com.google.Chrome', tier: 'full' }], false);
    expect(await ask('screenshot', { app: 'chrome', size: SIZE })).toMatchObject({ width: 400 });
    const batch = async (actions: ControllerMethods['control.batch']['params']['actions']) => (await ask('control.batch', { actions, size: SIZE })).results;
    expect(await batch([{ action: 'left_click', coordinate: [200, 150] }, { action: 'type', text: 'lego', replace: true }])).toEqual([
      { action: 'left_click', ok: true },
      { action: 'type', ok: true },
    ]);
    expect(helper.did('bg.click').at(-1)?.params).toMatchObject({ window: '42', x: 500, y: 350 });
    expect(helper.did('bg.type').at(-1)?.params).toEqual({ window: '42', text: 'lego', replace: true });
    // A spot the helper can't click in the background (not a button, a link or a field): the agent hears how to go on.
    helper.refuse = new HelperError('In the background this app only takes clicks on buttons, links, checkboxes and fields, and that spot is none of them.', -32032);
    expect((await batch([{ action: 'left_click', coordinate: [5, 5] }]))[0]).toMatchObject({ ok: false, note: /none of them\. This app may need Full control: ask with FullControl\./ });
    // A key that made the app come forward: the helper put the person's app back, and the agent hears what to avoid.
    helper.refuse = null;
    helper.fronts = true;
    expect((await batch([{ action: 'key', text: 'cmd+comma' }]))[0]).toMatchObject({
      ok: true,
      note: /That brought Google Chrome to the front, so it was sent behind the person's app again\. In the background, avoid/,
    });
    // When the turn ends, what the helper turned on in the app for it goes off.
    await ask('turn.end', {});
    expect(helper.did('bg.end')).toHaveLength(1);
  });
});

describe('apps the person asked for', () => {
  it('are allowed without a card, at their usual tier, on this computer only', async () => {
    const allowed = await ask('access.allow', { ids: ['com.apple.TextEdit', 'com.apple.Terminal', 'com.1password.1password', 'com.apple.systempreferences', 'com.example.Missing'] });
    // A password manager is denied by default, System Settings isn't offered, an app that isn't installed isn't allowed.
    expect(allowed).toEqual({ allowed: ['com.apple.TextEdit', 'com.apple.Terminal'] });
    const state = await ask('access.state', {});
    expect(state.apps).toEqual([{ app: { id: 'com.apple.TextEdit', name: 'TextEdit' }, tier: 'full' }, { app: { id: 'com.apple.Terminal', name: 'Terminal' }, tier: 'click' }]);
    // A server's sessions can't: only the card on this computer allows anything.
    expect(await controller.handle('server-1', 's1', 'access.allow', { ids: ['com.apple.Notes'] })).toEqual({ allowed: [] });
  });

  it('waits for the first window of an app it just opened, and only then', async () => {
    helper.background = true;
    await controller.grant('local', 's1', [{ id: 'com.apple.TextEdit', tier: 'full' }], false);
    helper.noWindowFor = 2;
    await expect(ask('screenshot', { app: 'TextEdit', size: SIZE })).rejects.toThrow('TextEdit has no window open');
    helper.noWindowFor = 2;
    await ask('apps.open', { id: 'com.apple.TextEdit' });
    const shot = await ask('screenshot', { app: 'TextEdit', size: SIZE });
    expect(shot.width).toBe(400);
    expect(helper.did('window.capture')).toHaveLength(4);
  });

  it('says when an app has no window open', async () => {
    helper.background = true;
    await controller.grant('local', 's1', [{ id: 'com.apple.Notes', tier: 'full' }], false);
    await expect(ask('screenshot', { size: SIZE })).rejects.toThrow('Notes has no window open: open it with OpenApp first.');
  });
});

describe('on Windows', () => {
  it('lets alt+tab and the Windows key switch apps while Atelier has the keyboard, and reads cmd as ctrl', async () => {
    const windows = new ComputerController({
      helper: helper as unknown as ComputerHelper,
      hasHelper: true,
      settingsPath,
      overlay: { show() {}, hide() {}, esc() {}, paused() {} },
      windows: { hide() {}, restore() {}, focus() {}, moveAway: () => false, moveBack() {}, attention() {} },
      event() {},
      changed() {},
      platform: 'win32',
    });
    await changeComputerSettings(settingsPath, (s) => ({ ...s, mode: 'full' }));
    const run = <M extends keyof ControllerMethods>(method: M, params: ControllerMethods[M]['params']) => windows.handle('local', 'w1', method, params);
    expect(await run('access.state', {})).toMatchObject({ platform: 'win32' });
    expect(await run('control.request', {})).toEqual({ granted: true });
    helper.focused = { app: app('atelier.exe', 'Atelier') };
    const press = async (text: string) => (await run('control.batch', { actions: [{ action: 'key', text }], size: SIZE })).results[0];
    expect(await press('alt+tab')).toEqual({ action: 'key', ok: true });
    expect(await press('win')).toEqual({ action: 'key', ok: true });
    expect(await press('super')).toEqual({ action: 'key', ok: true });
    // cmd+tab is ctrl+tab there: typing into Atelier, refused.
    expect(await press('cmd+tab')).toMatchObject({ ok: false, note: /The keyboard goes to Atelier/ });
    await run('turn.end', {});
  });
});

describe('on Linux', () => {
  const LINUX = [app('xterm', 'XTerm'), app('org.mozilla.firefox', 'Firefox'), app('atelier', 'Atelier')];
  const linux = (extra: Partial<ConstructorParameters<typeof ComputerController>[0]> = {}, log: string[] = []) =>
    new ComputerController({
      helper: helper as unknown as ComputerHelper,
      hasHelper: true,
      settingsPath,
      overlay: {
        show() {},
        hide() {},
        esc() {},
        paused() {},
        capturing: async (on) => void log.push(`capturing:${on}`),
      },
      windows: { hide() {}, restore() {}, focus() {}, moveAway: () => false, moveBack() {}, attention() {} },
      event() {},
      changed() {},
      platform: 'linux',
      ...extra,
    });

  it('reads cmd as ctrl, lets alt+tab and the Super key switch apps, and refuses typing into Atelier', async () => {
    const c = linux();
    await changeComputerSettings(settingsPath, (s) => ({ ...s, mode: 'full' }));
    const run = <M extends keyof ControllerMethods>(method: M, params: ControllerMethods[M]['params']) => c.handle('local', 'l1', method, params);
    expect(await run('access.state', {})).toMatchObject({ platform: 'linux', background: false });
    expect(await run('control.request', {})).toEqual({ granted: true });
    helper.focused = { app: LINUX[2]! };
    const press = async (text: string) => (await run('control.batch', { actions: [{ action: 'key', text }], size: SIZE })).results[0];
    expect(await press('alt+tab')).toEqual({ action: 'key', ok: true });
    expect(await press('super')).toEqual({ action: 'key', ok: true });
    expect(await press('cmd+tab')).toMatchObject({ ok: false, note: /The keyboard goes to Atelier/ });
    // `replace` selects with ctrl+a there.
    helper.focused = { app: LINUX[0]! };
    await run('control.batch', { actions: [{ action: 'type', text: 'hi', replace: true }], size: SIZE });
    expect(helper.did('key.press').at(-1)?.params).toEqual({ keys: ['ctrl', 'a'] });
    await run('turn.end', {});
  });

  it('takes the overlay out of every screenshot and zoom, and puts it back even when the capture fails', async () => {
    const log: string[] = [];
    const c = linux({}, log);
    await changeComputerSettings(settingsPath, (s) => ({ ...s, mode: 'full' }));
    const run = <M extends keyof ControllerMethods>(method: M, params: ControllerMethods[M]['params']) => c.handle('local', 'l2', method, params);
    await run('control.request', {});
    await run('screenshot', { size: SIZE });
    expect(log).toEqual(['capturing:true', 'capturing:false']);
    log.length = 0;
    await run('control.batch', { actions: [{ action: 'screenshot' }], size: SIZE });
    expect(log).toEqual(['capturing:true', 'capturing:false']);
    log.length = 0;
    await run('control.batch', { actions: [{ action: 'zoom', region: [0, 0, 100, 50] }], size: SIZE });
    expect(log).toEqual(['capturing:true', 'capturing:false']);
    log.length = 0;
    const call = helper.call.bind(helper);
    helper.call = (async (method: string, params: unknown) => (method === 'capture.display' ? Promise.reject(new HelperError('boom', -32603)) : call(method as never, params as never))) as typeof helper.call;
    await expect(run('screenshot', { size: SIZE })).rejects.toThrow('boom');
    expect(log).toEqual(['capturing:true', 'capturing:false']);
    await run('turn.end', {});
  });

  it('says why there is no computer use, and which kind of session it is', async () => {
    const wayland = linux({ environment: { session: 'wayland' } });
    expect(await wayland.status()).toMatchObject({ available: true, platform: 'linux', session: 'wayland', background: false });
    const none = linux({ environment: { session: null, unavailable: 'There is no X server to talk to.' } });
    expect(await none.status()).toMatchObject({ available: false, unavailableReason: 'There is no X server to talk to.' });
    await expect(none.handle('local', 'l3', 'screenshot', { size: SIZE })).rejects.toThrow();
  });

  it('works through per-app cards when the helper has no Background mode, hiding the other apps while it controls', async () => {
    helper.apps = [...APPS, app('xterm', 'XTerm')];
    const c = linux();
    await c.grant('local', 'l4', [{ id: 'xterm', tier: 'click' }], false);
    expect(helper.background).toBe(false);
    expect(await c.handle('local', 'l4', 'control.request', {})).toEqual({ granted: false, reason: 'ask' });
    await c.allowControl('local', 'l4', false);
    expect(await c.handle('local', 'l4', 'control.request', {})).toEqual({ granted: true });
    expect(helper.did('control.begin')).toHaveLength(1);
    // Everything else running is minimized meanwhile, and shown again after.
    const hidden = (helper.did('apps.hide')[0]?.params as { ids: string[] }).ids;
    expect(hidden).toContain('com.apple.Safari');
    expect(hidden).not.toContain('xterm');
    expect(hidden).not.toContain('com.apple.systempreferences');
    await c.handle('local', 'l4', 'turn.end', {});
    expect(helper.did('apps.unhide')).toHaveLength(1);
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

describe('background screenshot controls', () => {
  it('numbers them from 1 with their centres in the screenshot’s pixels, leaving out what is outside it', async () => {
    const { screenshotElements } = await import('./controller.ts');
    const shot = {
      rect: { x: 100, y: 50, width: 800, height: 600 },
      width: 1280,
      height: 960,
      elements: [
        { role: 'button', name: 'Save', rect: { x: 120, y: 60, width: 60, height: 20 } },
        { role: 'textfield', name: 'Name', value: 'Ada', rect: { x: 200, y: 100, width: 200, height: 24 }, disabled: true },
        { role: 'button', name: 'Outside', rect: { x: 2000, y: 60, width: 60, height: 20 } },
      ],
    };
    expect(screenshotElements(shot)).toEqual([
      { n: 1, role: 'button', name: 'Save', x: 80, y: 32 },
      { n: 2, role: 'textfield', name: 'Name', value: 'Ada', x: 320, y: 99, disabled: true },
    ]);
    expect(screenshotElements({ ...shot, elements: null })).toEqual([]);
  });
});
