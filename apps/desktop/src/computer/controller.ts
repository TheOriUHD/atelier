/**
 * Computer use on this computer (ARCHITECTURE §22), owned by main: which apps each session may use and how, full
 * control of the mouse and keyboard, the overlay, hiding and showing apps, and the person's way out (holding Esc).
 * Backends ask through `handle` (the desktop's own backend as `local`); they never reach the helper themselves. Every
 * action is checked here against what the person allowed on this computer, whatever a backend asks.
 */
import {
  appCategory,
  defaultTier,
  linkSensitive,
  maxTier,
  type AppGrant,
  type AppTier,
  type ComputerActionItem,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerNotification,
  type ComputerSettings,
  type ComputerStatus,
  type ControllerEvent,
  type ControllerMethods,
  type HelperApp,
  type HelperDisplay,
  type PermissionsStatus,
  type PreparedApp,
  type ScreenRect,
  type ScreenshotSize,
} from '@atelier/protocol';
import { HelperError, type ComputerHelper } from './helper.ts';
import { changeComputerSettings, readComputerSettings } from './store.ts';

/** The edge glow and the "Atelier is using your computer" popup while it has the mouse and keyboard. */
export interface Overlay {
  show(): void;
  hide(): void;
  esc(phase: 'down' | 'up' | 'stopped'): void;
  /** Its actions wait while the person uses the mouse or keyboard. */
  paused(on: boolean): void;
}

export interface ControllerDeps {
  helper: ComputerHelper;
  /** Whether a helper for this OS is there at all. */
  hasHelper: boolean;
  settingsPath: string;
  overlay: Overlay;
  /** Atelier's own windows step aside during full control (they would be in the way of clicks), and come back. */
  windows: {
    hide(): void;
    restore(): void;
    /** Shows a window of Atelier's in front (making Atelier the active app is the helper's part). */
    focus(): void;
  };
  /** Tells the backend that owns a session: the person held Esc, or took the mouse back. */
  event(backend: string, sessionId: string, event: ControllerEvent): void;
  /** The settings or the state changed: the windows read the status again. */
  changed(): void;
  platform: NodeJS.Platform;
  /** The OS's own answer on the permissions, where main can ask it (macOS); the helper keeps the one it started with. */
  permissions?(): PermissionsStatus;
}

/** What a session's latest screenshot showed: coordinates in later actions are its pixels. */
interface Frame {
  rect: ScreenRect;
  width: number;
  height: number;
}

interface SessionState {
  grants: Map<string, AppGrant>;
  /** The person let this session take the mouse and keyboard (for the rest of it). */
  control: boolean;
  frame: Frame | null;
}

/**
 * What a session may do in each app. Background: the apps the person allowed it, one by one. Full control: everything in
 * every app as the screen shows it, terminals and editors included, but for their denied apps, Atelier and the system's own.
 */
interface Policy {
  full: boolean;
  /** The most it may do in an app; null where it may do nothing. */
  tier(id: string): AppTier | null;
  /** The apps allowed one by one (Background); empty in Full control. */
  grants: AppGrant[];
  /** The person's denied apps. */
  denied: ComputerApp[];
}

interface Control {
  key: string;
  backend: string;
  sessionId: string;
  /** Apps this control hid, shown again when it ends. */
  hidden: string[];
  /** The person held Esc to end it. */
  stopped: boolean;
  /** When the person last used the mouse or keyboard themselves: its actions wait until they stop. */
  lastInput: number;
  /** The app that had the keyboard when a permission card came up (Full control): in front again before it acts. */
  front: string | null;
}

/** How long the person's own mouse and keyboard must be still before its next action. */
const IDLE_MS = 1200;
/** How long it waits for the person to stop before it goes on regardless (they can hold Esc to stop it). */
const IDLE_WAIT_MAX_MS = 5 * 60_000;

const TIER_RANK: Record<AppTier, number> = { view: 0, click: 1, full: 2 };
const atLeast = (have: AppTier, need: AppTier) => TIER_RANK[have] >= TIER_RANK[need];
const keyOf = (backend: string, sessionId: string) => `${backend}\0${sessionId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What each action needs of the app it lands in. */
const NEEDS: Partial<Record<ComputerActionItem['action'], AppTier>> = {
  left_click: 'click',
  double_click: 'click',
  triple_click: 'click',
  scroll: 'click',
  mouse_move: 'view',
  right_click: 'full',
  middle_click: 'full',
  left_click_drag: 'full',
};

/** Keys that switch apps rather than type into one: fine whatever app has the keyboard (Full control). */
const SWITCH_KEYS = new Set(['cmd+tab', 'cmd+shift+tab', 'cmd+space']);
const KEY_ALIASES: Record<string, string> = { command: 'cmd', meta: 'cmd', super: 'cmd', option: 'alt', opt: 'alt', control: 'ctrl' };

/** What the model hears when the mouse and keyboard went back in the middle of its actions. */
const ENDED = {
  esc: 'The person took the computer back (held Esc). Stop and ask before going on.',
  other: 'You no longer have the mouse and keyboard.',
} as const;
const MEANWHILE = 'Not done: the person used the mouse or keyboard meanwhile, so the screen may have changed. Take a Screenshot, then go on.';

/** "cmd+shift+t" → ['cmd', 'shift', 't']. */
export const parseKeys = (combo: string): string[] =>
  combo
    .split('+')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

export class ComputerController {
  private sessions = new Map<string, SessionState>();
  private control: Control | null = null;
  private apps: { at: number; list: HelperApp[] } | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  /** Secure input is on (a password field somewhere): typing is refused, the Esc watch is blind. */
  private secureInput = false;

  constructor(private readonly deps: ControllerDeps) {
    deps.helper.onNotification((n) => this.notified(n));
  }

  /** The installed apps, for the denied list's picker. */
  async installed(query: string): Promise<{ id: string; name: string }[]> {
    const q = query.trim().toLowerCase();
    return (await this.appList())
      .filter((a) => appCategory(a.id) !== 'system' && (!q || a.name.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200)
      .map((a) => ({ id: a.id, name: a.name }));
  }

  /** macOS asks the person (once; after that only System Settings can change it). Other systems don't ask. */
  async requestPermission(kind: 'accessibility' | 'screenRecording'): Promise<void> {
    if (this.deps.hasHelper && this.deps.platform === 'darwin') await this.deps.helper.call('permissions.request', { kind });
  }

  /**
   * The permissions as the OS has them now. When the helper still has an older answer (the person just switched one
   * on), it starts again, since a process keeps the answer it got.
   */
  private async permissions(): Promise<PermissionsStatus> {
    if (!this.deps.hasHelper) return { accessibility: false, screenRecording: false };
    const helper = await this.deps.helper.call('permissions.status', {}).catch(() => ({ accessibility: false, screenRecording: false }));
    const os = this.deps.permissions?.();
    if (os && !this.control && (os.accessibility !== helper.accessibility || os.screenRecording !== helper.screenRecording)) this.deps.helper.restart();
    return os ?? helper;
  }

  /** Computer use is on and possible on this computer. */
  async available(): Promise<boolean> {
    return this.deps.hasHelper && (await readComputerSettings(this.deps.settingsPath)).enabled;
  }

  async status(): Promise<ComputerStatus> {
    const settings = await readComputerSettings(this.deps.settingsPath);
    const platform = this.deps.platform === 'win32' || this.deps.platform === 'linux' ? this.deps.platform : 'darwin';
    const permissions = await this.permissions();
    return {
      available: this.deps.hasHelper,
      platform,
      permissions,
      background: false,
      settings,
      control: this.control ? { sessionId: this.control.sessionId, paused: false } : null,
    };
  }

  /** Changes the settings (from this computer's Settings page). Turning it off ends full control at once. */
  async settings(change: (s: ComputerSettings) => ComputerSettings): Promise<ComputerSettings> {
    const next = (await this.write(() => changeComputerSettings(this.deps.settingsPath, change))) as ComputerSettings;
    if (!next.enabled && this.control) await this.end(this.control, { unhide: true });
    // A denied app loses what it was allowed.
    for (const state of this.sessions.values()) for (const app of next.denied) state.grants.delete(app.id);
    this.deps.changed();
    return next;
  }

  /** The person allowed apps on a card in this computer's window (only there: a backend can't allow anything). */
  async grant(backend: string, sessionId: string, grants: { id: string; tier: AppTier }[], always: boolean): Promise<void> {
    const settings = await readComputerSettings(this.deps.settingsPath);
    const installed = await this.appList();
    const state = this.session(backend, sessionId);
    const allowed: AppGrant[] = [];
    for (const { id, tier } of grants) {
      const app = installed.find((a) => a.id === id);
      const top = maxTier(appCategory(id));
      if (!app || !top || settings.denied.some((d) => d.id === id)) continue;
      const grant = { app: { id, name: app.name }, tier: atLeast(top, tier) ? tier : top };
      state.grants.set(id, grant);
      allowed.push(grant);
    }
    if (always && allowed.length) {
      await this.settings((s) => ({ ...s, always: { ...s.always, [backend]: [...(s.always[backend] ?? []).filter((g) => !allowed.some((a) => a.app.id === g.app.id)), ...allowed] } }));
    }
    this.deps.changed();
  }

  /** The person let a session take the mouse and keyboard: for the session, or always (the Full control mode). */
  async allowControl(backend: string, sessionId: string, always: boolean): Promise<void> {
    const state = this.session(backend, sessionId);
    state.control = true;
    if (always) await this.settings((s) => ({ ...s, mode: 'full' }));
  }

  /** The person stopped it from a window (or the session went away): full control ends and its run stops. */
  async stop(backend: string, sessionId: string): Promise<void> {
    const control = this.control;
    if (control?.key !== keyOf(backend, sessionId)) return;
    await this.end(control);
    this.deps.event(backend, sessionId, { type: 'stopped' });
  }

  async handle<M extends keyof ControllerMethods>(backend: string, sessionId: string, method: M, params: ControllerMethods[M]['params']): Promise<ControllerMethods[M]['result']> {
    const settings = await readComputerSettings(this.deps.settingsPath);
    if (!this.deps.hasHelper || !settings.enabled) throw new Error('Computer use is off on this computer: turn it on in Settings › System.');
    const run = this.methods(backend, sessionId, settings) as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const handler = run[method];
    if (!handler) throw new Error(`Unknown computer use request ${method}.`);
    return handler(params) as Promise<ControllerMethods[M]['result']>;
  }

  async dispose(): Promise<void> {
    if (this.control) await this.end(this.control, { unhide: true });
    await this.deps.helper.shutdown();
  }

  // ---------------------------------------------------------------- what backends ask

  private methods(backend: string, sessionId: string, settings: ComputerSettings) {
    const key = keyOf(backend, sessionId);
    const state = () => this.session(backend, sessionId);
    const policy = this.policy(backend, sessionId, settings);
    return {
      'access.prepare': async ({ names }: ControllerMethods['access.prepare']['params']): Promise<ControllerMethods['access.prepare']['result']> => {
        const installed = await this.appList();
        const apps: PreparedApp[] = [];
        const unknown: string[] = [];
        for (const name of names) {
          const app = matchApp(installed, name);
          if (!app) {
            unknown.push(name);
            continue;
          }
          if (apps.some((p) => p.app.id === app.id)) continue;
          const category = appCategory(app.id);
          apps.push({
            app: { id: app.id, name: app.name },
            category,
            tier: defaultTier(category),
            maxTier: maxTier(category),
            denied: settings.denied.some((d) => d.id === app.id),
            // In Full control every app it may use is allowed already: no card.
            granted: policy.tier(app.id),
          });
        }
        return { apps, unknown };
      },
      'access.state': async (): Promise<ControllerMethods['access.state']['result']> => {
        const { displays } = await this.deps.helper.call('displays.list', {});
        return {
          apps: policy.grants,
          mode: settings.mode,
          denied: policy.denied.map((d) => d.name),
          control: this.control?.key === key,
          displays: displays.map((d) => ({ id: d.id, name: d.name, primary: d.primary })),
        };
      },
      'apps.list': async ({ query }: ControllerMethods['apps.list']['params']): Promise<ControllerMethods['apps.list']['result']> => {
        const q = query?.trim().toLowerCase();
        const list = (await this.appList()).filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
        list.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
        return { apps: list.slice(0, 100).map((a) => ({ app: { id: a.id, name: a.name }, category: appCategory(a.id), running: a.running, granted: policy.tier(a.id) })) };
      },
      'apps.open': async ({ id }: ControllerMethods['apps.open']['params']) => {
        if (!policy.tier(id)) throw new Error('That app isn’t one you may use.');
        await this.deps.helper.call('apps.open', { id, activate: this.control?.key === key });
        this.apps = null;
        return {};
      },
      screenshot: async ({ display, size }: ControllerMethods['screenshot']['params']): Promise<ControllerMethods['screenshot']['result']> => {
        if (!policy.full && !policy.grants.length) throw new Error('You may use no apps yet: ask with ComputerAccess first.');
        const target = await this.display(display);
        const shot = await this.capture(target, policy, size).catch((e: unknown) => Promise.reject(new Error(helperMessage(e))));
        state().frame = { rect: shot.rect, width: shot.width, height: shot.height };
        const note = policy.full ? 'The screen as the person sees it; their denied apps are left out.' : 'Only the apps you may use are shown.';
        return { data: shot.data, mime: shot.mime, width: shot.width, height: shot.height, display: target.name, note };
      },
      'control.request': async (): Promise<ControllerMethods['control.request']['result']> => {
        if (this.control?.key === key) return { granted: true };
        if (this.control) return { granted: false, reason: 'Another conversation is using the mouse and keyboard right now.' };
        if (!policy.full && !policy.grants.length) return { granted: false, reason: 'You may use no apps yet: ask with ComputerAccess first.' };
        if (settings.mode !== 'full' && !state().control) return { granted: false, reason: 'ask' };
        const permissions = await this.permissions();
        if (!permissions.accessibility) return { granted: false, reason: 'Atelier needs the Accessibility permission to use the mouse and keyboard: the person turns it on in Settings › System › Computer use.' };
        await this.begin(backend, sessionId, settings);
        return { granted: true };
      },
      'control.batch': async ({ actions, size }: ControllerMethods['control.batch']['params']): Promise<ControllerMethods['control.batch']['result']> => {
        const control = this.control;
        if (control?.key !== key) throw new Error('You don’t have the mouse and keyboard: take them with FullControl first.');
        const results: ComputerActionResult[] = [];
        // The person may be using the computer (answering a card, say): it waits until they stop, then puts the app it
        // was working in back in front if Atelier took the keyboard meanwhile.
        await this.whenIdle(control);
        await this.refront(control);
        const started = Date.now();
        for (const item of actions) {
          if (this.control === control && control.lastInput > started) {
            await this.whenIdle(control);
            if (this.control === control) {
              results.push({ action: item.action, ok: false, note: MEANWHILE });
              break;
            }
          }
          if (this.control !== control) {
            results.push({ action: item.action, ok: false, note: ENDED[control.stopped ? 'esc' : 'other'] });
            break;
          }
          const result = await this.act(backend, sessionId, item, size, policy).catch((e: unknown) => ({ action: item.action, ok: false, note: helperMessage(e) }));
          results.push(result);
          if (!result.ok) break;
        }
        return { results };
      },
      // Done with the computer (the agent says so, or its turn ends): Atelier comes back to the front with the reply.
      'control.release': async () => {
        if (this.control?.key === key) await this.end(this.control, { focus: true });
        return {};
      },
      'turn.end': async () => {
        if (this.control?.key === key) await this.end(this.control, { focus: true });
        return {};
      },
      'turn.wait': async ({ kind }: ControllerMethods['turn.wait']['params']) => {
        const control = this.control;
        if (control?.key !== key) return {};
        // Full control keeps the computer through a permission card (Atelier stays on screen there); anything else the
        // person must answer, and Background (its windows stepped aside), hands it back.
        // Either way Atelier comes to the front, where the card is.
        if (settings.mode === 'full' && kind === 'permission') {
          const { app } = await this.deps.helper.call('apps.frontmost', {});
          control.front = app && appCategory(app.id) !== 'system' ? app.id : null;
          await this.focusAtelier();
          return {};
        }
        await this.end(control, { focus: true });
        return {};
      },
    };
  }

  // ---------------------------------------------------------------- acting

  private async act(backend: string, sessionId: string, item: ComputerActionItem, size: ScreenshotSize, policy: Policy): Promise<ComputerActionResult> {
    const helper = this.deps.helper;
    const state = this.session(backend, sessionId);
    const done = (note?: string): ComputerActionResult => ({ action: item.action, ok: true, ...(note ? { note } : {}) });
    const refuse = (note: string): ComputerActionResult => ({ action: item.action, ok: false, note });
    const point = (c: [number, number] | undefined) => {
      if (!c) throw new Error('It needs a coordinate.');
      const frame = state.frame;
      if (!frame) throw new Error('Take a screenshot first: coordinates are its pixels.');
      return { x: frame.rect.x + (c[0] * frame.rect.width) / frame.width, y: frame.rect.y + (c[1] * frame.rect.height) / frame.height };
    };
    /** The app under a point, and whether this action may land there. */
    const check = async (p: { x: number; y: number }, need: AppTier): Promise<string | null> => {
      const under = await helper.call('inspect.point', p);
      const id = under.app?.id;
      if (!id) return 'Nothing you may use is there.';
      const category = appCategory(id);
      const name = under.app!.name;
      const tier = policy.tier(id);
      if (category === 'system') return `${name} is part of the system or Atelier: never used.`;
      if (!tier) return policy.full ? `${name} is on the person's denied list: never used.` : `${name} is there, which you may not use.`;
      if (!atLeast(tier, need)) return `You may only ${tier === 'view' ? 'look at' : 'click and scroll in'} ${name}.`;
      if (under.link !== null && linkSensitive(category) && item.action !== 'mouse_move' && item.action !== 'scroll') {
        return `That's a link in ${name}${under.link ? ` (${under.link})` : ''}: links in mail and messages aren't clicked. Check it with WebFetch, or ask the person.`;
      }
      return null;
    };
    /** Typing and keys go to the frontmost app's focused element. */
    const checkKeys = async (): Promise<string | null> => {
      if (this.secureInput) return 'A password field has the keyboard (secure input is on): nothing is typed.';
      const focused = await helper.call('inspect.focused', {});
      const id = focused.app?.id;
      const tier = id ? policy.tier(id) : null;
      const name = focused.app?.name ?? 'an app';
      if (id && appCategory(id) === 'system') {
        return `The keyboard goes to ${name}, part of the system or Atelier: never used.${policy.full ? ' Bring the app you need to the front first (OpenApp, or cmd+tab).' : ''}`;
      }
      if (!id || !tier) return `The keyboard goes to ${name}, which you may not use.`;
      if (tier !== 'full') return `You may not type in ${name}.`;
      if (focused.secure) return 'That is a password field: you never type passwords.';
      return null;
    };

    switch (item.action) {
      case 'screenshot': {
        const target = await this.display();
        const shot = await this.capture(target, policy, size);
        state.frame = { rect: shot.rect, width: shot.width, height: shot.height };
        return { action: item.action, ok: true, screenshot: { data: shot.data, mime: shot.mime, width: shot.width, height: shot.height } };
      }
      case 'zoom': {
        const frame = state.frame;
        if (!frame || !item.region) return refuse('It needs a region of a screenshot taken before.');
        const [x0, y0, x1, y1] = item.region;
        const a = point([Math.min(x0, x1), Math.min(y0, y1)]);
        const b = point([Math.max(x0, x1), Math.max(y0, y1)]);
        const target = await this.display();
        const shot = await helper.call('capture.display', { display: target.id, ...this.shows(policy), region: { x: a.x, y: a.y, width: Math.max(1, b.x - a.x), height: Math.max(1, b.y - a.y) }, maxWidth: size.maxWidth, maxHeight: size.maxHeight, format: 'png' });
        // The zoom is for reading; coordinates stay those of the screenshot it came from.
        return { action: item.action, ok: true, note: 'Coordinates still refer to the screenshot before.', screenshot: { data: shot.data, mime: shot.mime, width: shot.width, height: shot.height } };
      }
      case 'wait':
        await sleep(Math.min(10, item.duration ?? 1) * 1000);
        return done();
      case 'cursor_position': {
        const at = await helper.call('cursor.position', {});
        const frame = state.frame;
        if (!frame) return done(`${Math.round(at.x)}, ${Math.round(at.y)} (screen points; take a screenshot for pixels)`);
        return done(`${Math.round(((at.x - frame.rect.x) * frame.width) / frame.rect.width)}, ${Math.round(((at.y - frame.rect.y) * frame.height) / frame.rect.height)}`);
      }
      case 'type': {
        if (!item.text) return refuse('Nothing to type.');
        const why = await checkKeys();
        if (why) return refuse(why);
        await helper.call('key.type', { text: item.text });
        return done();
      }
      case 'key': {
        const keys = parseKeys(item.text ?? '');
        if (!keys.length) return refuse('Which keys? Like "cmd+s" or "return".');
        const switching = policy.full && SWITCH_KEYS.has(keys.map((k) => KEY_ALIASES[k] ?? k).join('+'));
        const why = switching ? null : await checkKeys();
        if (why) return refuse(why);
        await helper.call('key.press', { keys, ...(item.amount ? { repeat: item.amount } : {}) });
        return done();
      }
      case 'left_click_drag': {
        const from = point(item.start);
        const to = point(item.coordinate);
        const why = (await check(from, 'full')) ?? (await check(to, 'full'));
        if (why) return refuse(why);
        await helper.call('mouse.drag', { from, to, button: 'left' });
        return done();
      }
      case 'scroll': {
        // Without a coordinate it scrolls where the pointer is.
        const at = item.coordinate ? point(item.coordinate) : await helper.call('cursor.position', {});
        const why = await check(at, 'click');
        if (why) return refuse(why);
        const amount = item.amount ?? 3;
        const d = item.direction ?? 'down';
        await helper.call('mouse.scroll', { ...at, dx: d === 'right' ? amount : d === 'left' ? -amount : 0, dy: d === 'down' ? amount : d === 'up' ? -amount : 0 });
        return done();
      }
      case 'mouse_move': {
        const at = point(item.coordinate);
        await helper.call('mouse.move', at);
        return done();
      }
      default: {
        const at = point(item.coordinate);
        const why = await check(at, NEEDS[item.action] ?? 'full');
        if (why) return refuse(why);
        const button = item.action === 'right_click' ? 'right' : item.action === 'middle_click' ? 'middle' : 'left';
        const count = item.action === 'double_click' ? 2 : item.action === 'triple_click' ? 3 : 1;
        await helper.call('mouse.click', { ...at, button, count, modifiers: [] });
        // Give the app a moment to react before the next step looks at it.
        await sleep(150);
        return done();
      }
    }
  }

  // ---------------------------------------------------------------- full control

  private async begin(backend: string, sessionId: string, settings: ComputerSettings): Promise<void> {
    const helper = this.deps.helper;
    const control: Control = { key: keyOf(backend, sessionId), backend, sessionId, hidden: [], stopped: false, lastInput: 0, front: null };
    this.control = control;
    await helper.call('control.resume', {});
    await helper.call('control.begin', {});
    this.deps.overlay.show();
    this.deps.changed();
    // Full control takes the computer as it is. In Background only the allowed apps stay in view, and Atelier's own
    // windows too step aside, until it's done.
    if (settings.mode === 'full') return;
    const allowed = new Set(this.grants(backend, sessionId, settings).map((g) => g.app.id));
    const others = (await helper.call('apps.list', { installed: false })).apps.filter((a) => a.running && !a.hidden && !allowed.has(a.id) && appCategory(a.id) !== 'system');
    // Every app it asked to hide is shown again afterwards, whatever the hide call reported.
    if (others.length) {
      control.hidden = others.map((a) => a.id);
      await helper.call('apps.hide', { ids: control.hidden });
    }
    this.deps.windows.hide();
  }

  /**
   * Gives the mouse and keyboard back: overlay off, Atelier's windows back, and the apps it hid back when the person
   * wants that ("Unhide apps when Atelier finishes"), or always (`unhide`) when computer use goes off or the app quits.
   */
  /**
   * `unhide`: show the apps it hid whatever the setting says (computer use turned off, the app quitting). `focus`: bring
   * Atelier to the front (the task is done, or it asks the person something).
   */
  private async end(control: Control, { unhide = false, focus = false }: { unhide?: boolean; focus?: boolean } = {}): Promise<void> {
    if (this.control !== control) return;
    this.control = null;
    const helper = this.deps.helper;
    await helper.call('input.releaseAll', {}).catch(() => undefined);
    await helper.call('control.end', {}).catch(() => undefined);
    this.deps.overlay.hide();
    this.deps.windows.restore();
    const settings = await readComputerSettings(this.deps.settingsPath);
    if (control.hidden.length && (settings.unhideOnFinish || unhide)) await helper.call('apps.unhide', { ids: control.hidden }).catch(() => undefined);
    if (focus) await this.focusAtelier();
    this.deps.changed();
  }

  /** Atelier in front: its window shown, and the app made active through the helper (macOS 14+ ignores its own ask). */
  private async focusAtelier(): Promise<void> {
    this.deps.windows.focus();
    await this.deps.helper.call('apps.activate', { pid: process.pid }).catch(() => undefined);
  }

  private notified(n: ComputerNotification): void {
    const control = this.control;
    if (n.method === 'control.secureInput') {
      this.secureInput = n.params.on;
      return;
    }
    if (!control || control.stopped) return;
    if (n.method === 'control.userInput') {
      // They reached for the mouse or keyboard: its actions wait until they stop. Holding Esc is how they end it.
      control.lastInput = Date.now();
    } else if (n.method === 'control.esc') {
      this.deps.overlay.esc(n.params.phase);
      if (n.params.phase === 'stopped') {
        control.stopped = true;
        void this.end(control).then(() => this.deps.event(control.backend, control.sessionId, { type: 'stopped' }));
      }
    }
  }

  /** Waits while the person uses the mouse or keyboard (the popup says so), at most a few minutes. */
  private async whenIdle(control: Control): Promise<void> {
    const since = Date.now();
    let paused = false;
    while (this.control === control && Date.now() - control.lastInput < IDLE_MS && Date.now() - since < IDLE_WAIT_MAX_MS) {
      if (!paused) this.deps.overlay.paused(true);
      paused = true;
      await sleep(150);
    }
    if (paused) this.deps.overlay.paused(false);
  }

  /** After a permission card: the app it was working in goes back in front when Atelier (or the system) took it. */
  private async refront(control: Control): Promise<void> {
    const front = control.front;
    control.front = null;
    if (!front || this.control !== control) return;
    const { app } = await this.deps.helper.call('apps.frontmost', {});
    if (app && appCategory(app.id) !== 'system') return;
    await this.deps.helper.call('apps.open', { id: front, activate: true }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- helpers

  private session(backend: string, sessionId: string): SessionState {
    const key = keyOf(backend, sessionId);
    let state = this.sessions.get(key);
    if (!state) {
      state = { grants: new Map(), control: false, frame: null };
      this.sessions.set(key, state);
    }
    return state;
  }

  /** What a session may use: its own grants, then the apps allowed always for its backend; never a denied app. */
  private grants(backend: string, sessionId: string, settings: ComputerSettings): AppGrant[] {
    const own = this.session(backend, sessionId).grants;
    const all = new Map<string, AppGrant>();
    for (const g of settings.always[backend] ?? []) all.set(g.app.id, g);
    for (const g of own.values()) all.set(g.app.id, g);
    return [...all.values()].filter((g) => !settings.denied.some((d) => d.id === g.app.id) && appCategory(g.app.id) !== 'system');
  }

  private async appList(): Promise<HelperApp[]> {
    if (this.apps && Date.now() - this.apps.at < 30_000) return this.apps.list;
    const { apps } = await this.deps.helper.call('apps.list', { installed: true });
    this.apps = { at: Date.now(), list: apps };
    return apps;
  }

  private async display(name?: string): Promise<HelperDisplay> {
    const { displays } = await this.deps.helper.call('displays.list', {});
    const wanted = name?.trim().toLowerCase();
    const found = wanted ? displays.find((d) => d.name.toLowerCase() === wanted || d.id === wanted) : displays.find((d) => d.primary);
    if (!found) throw new Error(wanted ? `No display called ${name}: ${displays.map((d) => d.name).join(', ')}.` : 'No display.');
    return found;
  }

  private policy(backend: string, sessionId: string, settings: ComputerSettings): Policy {
    const denied = settings.denied;
    if (settings.mode === 'full') {
      return { full: true, grants: [], denied, tier: (id) => (settings.denied.some((d) => d.id === id) || !maxTier(appCategory(id)) ? null : 'full') };
    }
    const grants = this.grants(backend, sessionId, settings);
    return { full: false, grants, denied, tier: (id) => grants.find((g) => g.app.id === id)?.tier ?? null };
  }

  /** What a screenshot shows: the allowed apps (Background), or the screen but for the denied apps (Full control). */
  private shows(policy: Policy): { apps: string[] } | { exclude: string[] } {
    if (!policy.full) return { apps: policy.grants.map((g) => g.app.id) };
    return { exclude: policy.denied.map((d) => d.id) };
  }

  private capture(display: HelperDisplay, policy: Policy, size: ScreenshotSize) {
    return this.deps.helper.call('capture.display', { display: display.id, ...this.shows(policy), maxWidth: size.maxWidth, maxHeight: size.maxHeight, format: 'jpeg', quality: 0.8 });
  }

  private write<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

/** An app by its id, its name, or the start or part of its name. */
export function matchApp(apps: HelperApp[], name: string): HelperApp | undefined {
  const n = name.trim().toLowerCase().replace(/\.app$/, '');
  return (
    apps.find((a) => a.id.toLowerCase() === n) ??
    apps.find((a) => a.name.toLowerCase() === n) ??
    apps.find((a) => a.name.toLowerCase().startsWith(n)) ??
    apps.find((a) => a.name.toLowerCase().includes(n))
  );
}

/** What a helper error means for the model. */
function helperMessage(e: unknown): string {
  if (e instanceof HelperError && e.data?.permission) {
    return `Atelier needs the ${e.data.permission === 'accessibility' ? 'Accessibility' : 'Screen Recording'} permission: the person turns it on in Settings › System › Computer use.`;
  }
  if (e instanceof HelperError && e.code === -32031) return 'The person held Esc to stop you. Stop and ask before going on.';
  return e instanceof Error ? e.message : String(e);
}

