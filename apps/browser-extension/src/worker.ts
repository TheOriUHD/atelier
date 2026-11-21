// Atelier for Chrome's service worker: connects to the desktop app through the native messaging host and runs its calls in
// tabs of Atelier's own. It never acts in the person's tabs: every page call checks the tab is one it opened.
//
// Input goes through Chrome's debugger on that tab (trusted clicks and typing that work while the tab is in the
// background); Chrome shows its "started debugging this browser" bar while it is attached, and it is detached again
// after 20 idle seconds. Reading goes through a script in the page.
//
// Each chat's tabs are in a tab group of their own, named after the chat; they stay open after a reply and close when the
// chat is deleted (or when the model closes them). The tab a chat works in glows orange and lists its steps (overlay.ts).

// The protocol's browser module alone, not the package index, so the worker doesn't carry the app's schemas.
import { BROWSER_HOST_NAME, BROWSER_PROTOCOL_VERSION, type BrowserMethods, type BrowserRequest, type BrowserSession, type BrowserTab, type BrowserTarget } from '../../../packages/protocol/src/browser.ts';
import { parseChord, reachesTheBrowser } from './keys.ts';
import { hideOverlay, removeOverlay, showOverlay, type OverlayView } from './overlay.ts';
import { chooseOption, keepInThisTab, locate, selectAll, snapshot, type Snapshot } from './page.ts';

/** The group of tabs opened without a chat (by an app older than this extension). */
const GROUP_TITLE = 'Atelier';
/** How many of a chat's steps the panel shows; the ones before are counted. */
const STEPS_SHOWN = 4;
/** A chat's glow with no step for this long is taken away (the page's own timer does the same). */
const OVERLAY_STALE_MS = 10 * 60_000;
/** How long a page may take to load before a call returns anyway. */
const LOAD_TIMEOUT = 20_000;
/** The debugger is detached after this long without input, so Chrome's bar goes away between tasks. */
const DETACH_AFTER = 20_000;

// ---------------------------------------------------------------- the connection

let port: chrome.runtime.Port | null = null;
let retryIn = 1_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function connect(): void {
  if (port) return;
  clearTimeout(retryTimer);
  try {
    port = chrome.runtime.connectNative(BROWSER_HOST_NAME);
  } catch {
    port = null;
    return scheduleRetry();
  }
  const current = port;
  let used = false;
  current.onMessage.addListener((message) => {
    used = true;
    void answer(current, message as BrowserRequest);
  });
  current.onDisconnect.addListener(() => {
    if (port === current) port = null;
    // The desktop app that sent the calls quit or restarted: no chat is working in a tab any more. (A connection that
    // never came up, with the app closed, has nothing to end.)
    if (used) void endAllOverlays();
    scheduleRetry();
  });
  current.postMessage({ hello: { protocol: BROWSER_PROTOCOL_VERSION, extensionVersion: chrome.runtime.getManifest().version, browser: browserName() } });
  retryIn = 1_000;
}

function scheduleRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryIn);
  retryIn = Math.min(retryIn * 2, 60_000);
}

function browserName(): string {
  const brands = navigator.userAgentData?.brands ?? [];
  const named = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? brands.find((b) => /chromium/i.test(b.brand));
  return named ? `${named.brand} ${named.version}` : 'Chromium';
}

async function answer(to: chrome.runtime.Port, request: BrowserRequest): Promise<void> {
  try {
    const result = await handle(request.method, request.params as never);
    to.postMessage({ id: request.id, result });
  } catch (error) {
    to.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
}

// ---------------------------------------------------------------- Atelier's own tabs

/** Atelier's tabs, each with the chat it was opened for ('' when the app didn't say). */
const ours = new Map<number, string>();
/** Each chat's tab group, and the name it was given (a group the person renamed keeps their name). */
const groups = new Map<string, { id: number; title: string }>();
const remembered = chrome.storage.session.get(['tabs', 'groups']).then((stored) => {
  // 0.1.0 kept the tab ids alone.
  for (const entry of (stored.tabs as (number | [number, string])[] | undefined) ?? []) {
    if (Array.isArray(entry)) ours.set(entry[0], entry[1]);
    else ours.set(entry, '');
  }
  for (const [session, group] of Object.entries((stored.groups as Record<string, { id: number; title: string }> | undefined) ?? {})) groups.set(session, group);
});
const save = () => chrome.storage.session.set({ tabs: [...ours], groups: Object.fromEntries(groups) });

async function own(tab: number): Promise<void> {
  await remembered;
  if (!ours.has(tab)) throw new Error(`Tab ${tab} isn't one of Atelier's tabs: open a page with open first (the person's own tabs aren't used).`);
}

chrome.tabs.onRemoved.addListener((tab) => {
  if (ours.delete(tab)) void save();
  attached.delete(tab);
});

// Links that would open a tab open in the same one, from the first moment of every page in Atelier's tabs.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0 && ours.has(tabId)) void keepLinksHere(tabId);
});

// A new page in a tab a chat works in gets the glow and the steps again (the old page took them with it).
chrome.webNavigation.onDOMContentLoaded.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  for (const overlay of overlays.values()) if (overlay.tab === tabId && overlay.view.state !== 'done') void paint(overlay);
});

async function keepLinksHere(tab: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId: tab }, func: keepInThisTab, world: 'MAIN', injectImmediately: true }).catch(() => undefined);
}

/** A chat's name as its group's title: on one line, and short enough for the tab strip. */
function groupTitle(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim() || GROUP_TITLE;
  return line.length > 40 ? `${line.slice(0, 39).trimEnd()}…` : line;
}

/** The chat's tab group, while it still exists. */
async function sessionGroup(session: string): Promise<chrome.tabGroups.TabGroup | null> {
  const known = groups.get(session);
  if (!known) return null;
  try {
    return await chrome.tabGroups.get(known.id);
  } catch {
    groups.delete(session);
    return null;
  }
}

/** Puts a new tab in its chat's group (made, orange and collapsed, in the tab's window when there is none there yet). */
async function intoGroup(tab: chrome.tabs.Tab, session?: BrowserSession): Promise<void> {
  if (!session) {
    const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
    const groupId = await chrome.tabs.group(group ? { tabIds: tab.id!, groupId: group.id } : { tabIds: tab.id!, createProperties: { windowId: tab.windowId } });
    if (!group) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'orange', collapsed: true });
    return;
  }
  const group = await sessionGroup(session.id);
  if (group && group.windowId === tab.windowId) {
    await chrome.tabs.group({ tabIds: tab.id!, groupId: group.id });
    return void (await retitle(session));
  }
  const groupId = await chrome.tabs.group({ tabIds: tab.id!, createProperties: { windowId: tab.windowId } });
  const title = groupTitle(session.title);
  groups.set(session.id, { id: groupId, title });
  await save();
  await chrome.tabGroups.update(groupId, { title, color: 'orange', collapsed: true });
}

/** The chat got its name (titles come after the first reply) or a new one: its group follows, unless the person renamed it. */
async function retitle(session: BrowserSession): Promise<void> {
  const known = groups.get(session.id);
  const title = groupTitle(session.title);
  if (!known || known.title === title) return;
  const group = await sessionGroup(session.id);
  if (!group) return;
  if (group.title === known.title) await chrome.tabGroups.update(group.id, { title });
  groups.set(session.id, { id: group.id, title });
  await save();
}

// ---------------------------------------------------------------- the glow and the steps

interface Overlay {
  session: string;
  /** The tab the chat works in now: the only one that glows. */
  tab: number;
  view: OverlayView;
  at: number;
}

/** Each working chat's overlay, by chat. */
const overlays = new Map<string, Overlay>();

async function paint(overlay: Overlay): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId: overlay.tab }, func: showOverlay, args: [overlay.view] }).catch(() => undefined);
}

async function unpaint(tab: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId: tab }, func: removeOverlay }).catch(() => undefined);
}

/** A step text as the panel shows it: one line, not too long. */
const stepText = (step: string) => {
  const line = step.replace(/\s+/g, ' ').trim() || 'Working';
  return line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line;
};

async function endAllOverlays(): Promise<void> {
  const all = [...overlays.values()];
  overlays.clear();
  for (const overlay of all) {
    overlay.view = { ...overlay.view, state: 'done' };
    await paint(overlay);
  }
}

/** Glows that nothing has updated for a while go (a turn that ended without telling the extension). */
async function sweepOverlays(): Promise<void> {
  const now = Date.now();
  for (const [session, overlay] of overlays) {
    if (now - overlay.at < OVERLAY_STALE_MS) continue;
    overlays.delete(session);
    overlay.view = { ...overlay.view, state: 'done' };
    await paint(overlay);
  }
}

function waitLoaded(tab: number, timeout = LOAD_TIMEOUT): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, change: { status?: string }) => {
      if (id === tab && change.status === 'complete') done();
    };
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tab).then((t) => t.status === 'complete' && done(), done);
  });
}

async function describe(tab: number): Promise<BrowserTab> {
  const t = await chrome.tabs.get(tab);
  return { tab, url: t.url ?? t.pendingUrl ?? '', title: t.title ?? '' };
}

/** After an action: a moment for the page to react, then the load it started, if any. */
async function settle(tab: number): Promise<BrowserTab> {
  await new Promise((r) => setTimeout(r, 250));
  if ((await chrome.tabs.get(tab)).status === 'loading') await waitLoaded(tab, 10_000);
  return describe(tab);
}

async function inPage<A extends unknown[], R>(tab: number, func: (...args: A) => R, args: A): Promise<Awaited<R>> {
  const [first] = await chrome.scripting.executeScript({ target: { tabId: tab }, func, args });
  return first?.result as Awaited<R>;
}

// ---------------------------------------------------------------- the debugger

const attached = new Set<number>();
const stoppedByPerson = new Set<number>();
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  if (reason === 'canceled_by_user') stoppedByPerson.add(source.tabId);
});

async function cdp(tab: number, method: string, params: object = {}): Promise<unknown> {
  if (stoppedByPerson.has(tab)) throw new Error('The person stopped Atelier in this tab (Cancel on Chrome’s debugging bar): ask them before going on.');
  if (!attached.has(tab)) {
    await chrome.debugger.attach({ tabId: tab }, '1.3');
    attached.add(tab);
    // A tab in the background isn't focused: without this, clicks and typing in it are dropped.
    await chrome.debugger.sendCommand({ tabId: tab }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  }
  clearTimeout(idleTimers.get(tab));
  idleTimers.set(tab, setTimeout(() => void chrome.debugger.detach({ tabId: tab }).catch(() => undefined), DETACH_AFTER));
  return chrome.debugger.sendCommand({ tabId: tab }, method, params);
}

async function pointOf(target: BrowserTarget): Promise<{ x: number; y: number }> {
  if (target.ref !== undefined) {
    const point = await inPage(target.tab, locate, [target.ref]);
    if (!point) throw new Error(`Element ${target.ref} isn't on the page any more: read the page again.`);
    return point;
  }
  if (target.x !== undefined && target.y !== undefined) return { x: target.x, y: target.y };
  throw new Error('Name an element (ref) or a point (x and y).');
}

async function click(target: BrowserTarget, count = 1): Promise<BrowserTab> {
  const { x, y } = await pointOf(target);
  await cdp(target.tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let n = 1; n <= count; n++) {
    await cdp(target.tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n });
    await cdp(target.tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n });
  }
  return settle(target.tab);
}

async function press(tab: number, keys: string[]): Promise<void> {
  const chord = parseChord(keys);
  if (reachesTheBrowser(chord)) throw new Error(`${keys.join('+')} would reach the browser itself (a tab, a window, the address bar), not the page: use open, navigate or close instead.`);
  const { key, modifiers } = chord;
  const base = { modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode, nativeVirtualKeyCode: key.windowsVirtualKeyCode };
  await cdp(tab, 'Input.dispatchKeyEvent', { ...base, type: key.text ? 'keyDown' : 'rawKeyDown', ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) });
  await cdp(tab, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// ---------------------------------------------------------------- the calls

type Params<M extends keyof BrowserMethods> = BrowserMethods[M]['params'];
type Result<M extends keyof BrowserMethods> = BrowserMethods[M]['result'];

const READ_DEFAULTS = { maxChars: 6_000, maxElements: 120 };

async function handle<M extends keyof BrowserMethods>(method: M, params: Params<M>): Promise<Result<M>> {
  return (await calls[method](params as never)) as Result<M>;
}

const calls: { [M in keyof BrowserMethods]: (params: Params<M>) => Promise<Result<M>> } = {
  status: async () => ({ connected: true, browser: browserName(), extensionVersion: chrome.runtime.getManifest().version }),

  'tabs.open': async ({ url, session }) => {
    await remembered;
    // A chat's tabs stay together: a new one opens in the window its group is in.
    const group = session ? await sessionGroup(session.id) : null;
    const created = await chrome.tabs.create({ url, active: false, ...(group ? { windowId: group.windowId } : {}) });
    ours.set(created.id!, session?.id ?? '');
    await save();
    await intoGroup(created, session).catch(() => undefined);
    await waitLoaded(created.id!);
    await keepLinksHere(created.id!);
    return describe(created.id!);
  },

  'tabs.list': async ({ session } = {}) => {
    await remembered;
    const tabs: BrowserTab[] = [];
    for (const [id, owner] of [...ours]) {
      if (session !== undefined && owner !== session) continue;
      try {
        tabs.push(await describe(id));
      } catch {
        ours.delete(id);
      }
    }
    await save();
    return { tabs };
  },

  'tabs.close': async ({ tab }) => {
    await own(tab);
    await chrome.tabs.remove(tab);
    ours.delete(tab);
    await save();
    return {};
  },

  'tabs.closeSession': async ({ session }) => {
    await remembered;
    const tabs = [...ours].filter(([, owner]) => owner === session).map(([id]) => id);
    overlays.delete(session);
    groups.delete(session);
    for (const id of tabs) ours.delete(id);
    await save();
    let closed = 0;
    for (const id of tabs) {
      try {
        await chrome.tabs.remove(id);
        closed++;
      } catch {
        // Closed already.
      }
    }
    return { closed };
  },

  'tabs.rename': async ({ session }) => {
    await remembered;
    await retitle(session);
    const overlay = overlays.get(session.id);
    if (overlay && overlay.view.title !== session.title) {
      overlay.view = { ...overlay.view, title: session.title };
      await paint(overlay);
    }
    return {};
  },

  'overlay.step': async ({ session, tab, step }) => {
    await own(tab);
    const previous = overlays.get(session.id);
    const steps = [...(previous && previous.view.state !== 'done' ? previous.view.steps : []), stepText(step)];
    const earlier = (previous && previous.view.state !== 'done' ? previous.view.earlier : 0) + Math.max(0, steps.length - STEPS_SHOWN);
    const overlay: Overlay = { session: session.id, tab, at: Date.now(), view: { title: session.title, steps: steps.slice(-STEPS_SHOWN), earlier, state: 'working' } };
    overlays.set(session.id, overlay);
    // The chat moved on to another of its tabs: the one before stops glowing.
    if (previous && previous.tab !== tab) await unpaint(previous.tab);
    await paint(overlay);
    await retitle(session).catch(() => undefined);
    return {};
  },

  'overlay.end': async ({ session, state }) => {
    const overlay = overlays.get(session);
    if (!overlay) return {};
    overlay.view = { ...overlay.view, state };
    overlay.at = Date.now();
    if (state === 'done') overlays.delete(session);
    await paint(overlay);
    return {};
  },

  'page.navigate': async ({ tab, url }) => {
    await own(tab);
    await chrome.tabs.update(tab, { url });
    await new Promise((r) => setTimeout(r, 100));
    await waitLoaded(tab);
    return describe(tab);
  },

  'page.back': async ({ tab }) => {
    await own(tab);
    await chrome.tabs.goBack(tab);
    await new Promise((r) => setTimeout(r, 100));
    await waitLoaded(tab);
    return describe(tab);
  },

  'page.read': async ({ tab, text = true, elements = true, maxChars, maxElements, from }) => {
    await own(tab);
    const page: Snapshot = await inPage(tab, snapshot, [{ text, elements, maxChars: maxChars ?? READ_DEFAULTS.maxChars, maxElements: maxElements ?? READ_DEFAULTS.maxElements, from }]);
    return { tab, ...page };
  },

  'page.find': async ({ tab, query, maxElements }) => {
    await own(tab);
    const page: Snapshot = await inPage(tab, snapshot, [{ text: false, elements: true, maxChars: 0, maxElements: maxElements ?? 40, query }]);
    return { tab, ...page };
  },

  'page.click': async (params) => {
    await own(params.tab);
    return click(params, params.count ?? 1);
  },

  'page.type': async ({ text, replace, submit, ...target }) => {
    await own(target.tab);
    const hasTarget = target.ref !== undefined || (target.x !== undefined && target.y !== undefined);
    if (hasTarget) await click(target);
    if (replace) await inPage(target.tab, selectAll, [target.ref ?? null]);
    await cdp(target.tab, 'Input.insertText', { text });
    if (submit) await press(target.tab, ['Enter']);
    return settle(target.tab);
  },

  'page.key': async ({ tab, keys }) => {
    await own(tab);
    await press(tab, keys);
    return settle(tab);
  },

  'page.scroll': async ({ dy, ...target }) => {
    await own(target.tab);
    const point =
      target.ref !== undefined || target.x !== undefined
        ? await pointOf(target)
        : await inPage(target.tab, () => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }), []);
    await cdp(target.tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: dy });
    return settle(target.tab);
  },

  'page.select': async ({ option, ...target }) => {
    await own(target.tab);
    if (target.ref === undefined) throw new Error('Name the list (ref) to choose from.');
    const chosen = await inPage(target.tab, chooseOption, [target.ref, option]);
    if (chosen === null) throw new Error(`Element ${target.ref} isn't a list with an option "${option}": read the page again.`);
    return settle(target.tab);
  },

  'page.screenshot': async ({ tab, maxWidth = 1280 }) => {
    await own(tab);
    const metrics = (await cdp(tab, 'Page.getLayoutMetrics')) as { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } };
    const view = metrics.cssVisualViewport;
    const scale = Math.min(1, maxWidth / view.clientWidth);
    // The glow and the steps aren't part of the page: the model sees it without them.
    await chrome.scripting.executeScript({ target: { tabId: tab }, func: hideOverlay, args: [true] }).catch(() => undefined);
    let shot: { data: string };
    try {
      shot = (await cdp(tab, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 70,
        clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale },
      })) as { data: string };
    } finally {
      await chrome.scripting.executeScript({ target: { tabId: tab }, func: hideOverlay, args: [false] }).catch(() => undefined);
    }
    const page = await describe(tab);
    return { data: shot.data, width: Math.round(view.clientWidth * scale), height: Math.round(view.clientHeight * scale), ...page };
  },
};

// ---------------------------------------------------------------- start

// A service worker only starts for an event it listens to: these bring it up with the browser and after an install.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('connect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  connect();
  void sweepOverlays();
});
connect();
