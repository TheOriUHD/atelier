// Atelier for Chrome's service worker: connects to the desktop app through the native messaging host and runs its calls in
// tabs of Atelier's own. It never acts in the person's tabs: every page call checks the tab is one it opened.
//
// Input goes through Chrome's debugger on that tab (trusted clicks and typing that work while the tab is in the
// background); Chrome shows its "started debugging this browser" bar while it is attached, and it is detached again
// after 20 idle seconds. Reading goes through a script in the page.

// The protocol's browser module alone, not the package index, so the worker doesn't carry the app's schemas.
import { BROWSER_HOST_NAME, BROWSER_PROTOCOL_VERSION, type BrowserMethods, type BrowserRequest, type BrowserTab, type BrowserTarget } from '../../../packages/protocol/src/browser.ts';
import { parseChord, reachesTheBrowser } from './keys.ts';
import { chooseOption, keepInThisTab, locate, selectAll, snapshot, type Snapshot } from './page.ts';

const GROUP_TITLE = 'Atelier';
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
  current.onMessage.addListener((message) => void answer(current, message as BrowserRequest));
  current.onDisconnect.addListener(() => {
    if (port === current) port = null;
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

const ours = new Set<number>();
const remembered = chrome.storage.session.get('tabs').then((stored) => {
  for (const id of (stored.tabs as number[] | undefined) ?? []) ours.add(id);
});
const save = () => chrome.storage.session.set({ tabs: [...ours] });

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

async function keepLinksHere(tab: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId: tab }, func: keepInThisTab, world: 'MAIN', injectImmediately: true }).catch(() => undefined);
}

async function intoGroup(tab: chrome.tabs.Tab): Promise<void> {
  const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
  const groupId = await chrome.tabs.group(group ? { tabIds: tab.id!, groupId: group.id } : { tabIds: tab.id!, createProperties: { windowId: tab.windowId } });
  if (!group) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'orange', collapsed: true });
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

  'tabs.open': async ({ url }) => {
    const created = await chrome.tabs.create({ url, active: false });
    ours.add(created.id!);
    await save();
    await intoGroup(created).catch(() => undefined);
    await waitLoaded(created.id!);
    await keepLinksHere(created.id!);
    return describe(created.id!);
  },

  'tabs.list': async () => {
    await remembered;
    const tabs: BrowserTab[] = [];
    for (const id of [...ours]) {
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

  'page.read': async ({ tab, text = true, elements = true, maxChars, maxElements }) => {
    await own(tab);
    const page: Snapshot = await inPage(tab, snapshot, [{ text, elements, maxChars: maxChars ?? READ_DEFAULTS.maxChars, maxElements: maxElements ?? READ_DEFAULTS.maxElements }]);
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
    const shot = (await cdp(tab, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 70,
      clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale },
    })) as { data: string };
    const page = await describe(tab);
    return { data: shot.data, width: Math.round(view.clientWidth * scale), height: Math.round(view.clientHeight * scale), ...page };
  },
};

// ---------------------------------------------------------------- start

// A service worker only starts for an event it listens to: these bring it up with the browser and after an install.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('connect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
connect();
