/**
 * Atelier for Chrome and Atelier for Firefox (docs/ARCHITECTURE.md §22): the browser extension that works in web pages for
 * computer use, in tabs of its own. The core's Browser tool asks the desktop app's main process, which passes each call
 * through the native messaging host to the extension. The same methods are used on every hop.
 */

/** The native messaging host's name, as registered with each browser (Chromium's and Firefox's `NativeMessagingHosts`). */
export const BROWSER_HOST_NAME = 'dev.atelier.browser';

/**
 * The extension ids allowed to reach the host: the unpacked build's (its manifest carries a public key, so the id is the
 * same on every computer) and the Chrome Web Store's (apps/browser-extension/store/listing.md).
 */
export const BROWSER_EXTENSION_IDS = ['ehblmofeglpkfcaejllehbbhhddchefk', 'efpchbhecdgeeadmefahpgidnfplajln'] as const;

/**
 * Atelier for Firefox's add-on id (its manifest's `browser_specific_settings.gecko.id`): the same for the build on
 * addons.mozilla.org and one loaded by hand, and the one Firefox's host manifest allows (`allowed_extensions`).
 */
export const FIREFOX_EXTENSION_ID = 'atelier@atelierhq.dev';

/**
 * How the extension's browser runs input: `trusted` through Chrome's debugger (clicks and typing as from the person, in a
 * background tab too), `page` inside the page (Firefox, which has no debugger for extensions: ordinary events that most
 * sites take, but that a few ignore).
 */
export type BrowserInput = 'trusted' | 'page';

/** Protocol version, sent in the extension's hello; a mismatch is reported in Settings, not guessed around. */
export const BROWSER_PROTOCOL_VERSION = 1;

/**
 * The extension version that groups tabs by chat, shows the glow and the steps in the page, and reads long pages in parts
 * (`tabs.open` and `tabs.list` with `session`, `tabs.closeSession`, `tabs.rename`, `overlay.*`, `page.read` with `from`). An
 * older extension ignores the new parameters and doesn't know the new methods, so the core asks only one that is this
 * version or newer for them (`browserFeatures`).
 */
export const BROWSER_SESSIONS_SINCE = '0.2.0';

/** A chat, as the extension shows it: its tab group is named after it, and the steps panel in the page says its name. */
export interface BrowserSession {
  id: string;
  title: string;
}

/**
 * What the connected extension can do, from the version it reports. (A plain x.y.z comparison of its own: the extension
 * imports this module alone, and versions.ts would bring zod with it.)
 */
export function browserFeatures(extensionVersion: string | undefined): { sessions: boolean } {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const have = parts(extensionVersion ?? '0');
  const since = parts(BROWSER_SESSIONS_SINCE);
  let newer = 0;
  for (let i = 0; i < 3 && newer === 0; i++) newer = (have[i] ?? 0) - (since[i] ?? 0);
  return { sessions: !!extensionVersion && newer >= 0 };
}

/** One element of a page the model can act on, by `ref` (valid until the page changes; read again after a navigation). */
export interface BrowserElement {
  ref: number;
  /** ARIA role, or the tag where it has none: link, button, textbox, checkbox, combobox, option, heading… */
  role: string;
  /** Its accessible name: the label, text, alt or title (cut to 120 characters). */
  name: string;
  /** A field's current value, a checkbox's state, a select's chosen option. */
  value?: string;
  /** The URL a link goes to. */
  href?: string;
  /** Disabled or read-only, so it can't be used. */
  disabled?: boolean;
  /** In the viewport now; the others are scrolled into view before they are used. */
  visible: boolean;
}

export interface BrowserTab {
  tab: number;
  url: string;
  title: string;
  /** In `tabs.list` (0.3.0 on): the name of the tab group it is in, its chat's. */
  group?: string;
}

export interface BrowserPage extends BrowserTab {
  /** The page's text, as read (`read` with `text`), from `from` on, cut to `maxChars`; `truncated` when there was more. */
  text?: string;
  truncated?: boolean;
  /** How long the whole text is, in characters (0.2.0 on): with `from`, a long page is read in parts. */
  textLength?: number;
  /** The elements that can be used (links, buttons, fields, …) in reading order, up to `maxElements`. */
  elements?: BrowserElement[];
}

export interface BrowserTarget {
  tab: number;
  /** An element from the latest `read` or `find`; or a point in the page's CSS pixels, from a screenshot. */
  ref?: number;
  x?: number;
  y?: number;
}

export interface BrowserMethods {
  /** Whether an extension is connected, and which browser it is in. */
  status: { params: Record<string, never>; result: BrowserStatus };
  /**
   * Opens a tab of Atelier's own in the background and waits for the page to load. With `session` (0.2.0 on) it goes in
   * that chat's tab group, named after the chat; without, in one group called "Atelier".
   */
  'tabs.open': { params: { url: string; session?: BrowserSession }; result: BrowserTab };
  /** Atelier's own tabs; with `session` (0.2.0 on), only that chat's. */
  'tabs.list': { params: { session?: string }; result: { tabs: BrowserTab[] } };
  'tabs.close': { params: { tab: number }; result: Record<string, never> };
  /** Closes every tab of a chat (0.2.0 on): when the chat is deleted or archived. */
  'tabs.closeSession': { params: { session: string }; result: { closed: number } };
  /** The chat has a new name (0.2.0 on): its tab group takes it, unless the person renamed the group. */
  'tabs.rename': { params: { session: BrowserSession }; result: Record<string, never> };
  /**
   * A step of a chat's work in one of its tabs (0.2.0 on): that tab glows orange at its edges and shows the chat's steps
   * at its bottom left, the newest as the one under way; the chat's other tabs stop glowing. The glow goes by itself
   * after a few idle minutes, or when the desktop app disconnects.
   */
  'overlay.step': { params: { session: BrowserSession; tab: number; step: string }; result: Record<string, never> };
  /** The chat's turn ended (0.2.0 on): the glow fades; the steps say "Done", or that it waits for the person's answer. */
  'overlay.end': { params: { session: string; state: 'done' | 'waiting' }; result: Record<string, never> };
  'page.navigate': { params: { tab: number; url: string }; result: BrowserTab };
  'page.back': { params: { tab: number }; result: BrowserTab };
  /** The page's text and/or its usable elements; `from` (0.2.0 on) starts the text further in, for a long page. */
  'page.read': { params: { tab: number; text?: boolean; elements?: boolean; maxChars?: number; maxElements?: number; from?: number }; result: BrowserPage };
  /** Elements whose name, value or role contains `query` (case-insensitive). */
  'page.find': { params: { tab: number; query: string; maxElements?: number }; result: BrowserPage };
  'page.click': { params: BrowserTarget & { count?: number }; result: BrowserTab };
  /** Types where a click on the target puts the cursor (or where the focus is, without a target). */
  'page.type': { params: BrowserTarget & { text: string; replace?: boolean; submit?: boolean }; result: BrowserTab };
  /** A key or a chord, `["Enter"]`, `["Meta","a"]`, pressed in the page. */
  'page.key': { params: { tab: number; keys: string[] }; result: BrowserTab };
  'page.scroll': { params: BrowserTarget & { dy: number }; result: BrowserTab };
  /** Chooses an option of a `<select>` by its text or value. */
  'page.select': { params: BrowserTarget & { option: string }; result: BrowserTab };
  /** A JPEG of the tab as it is, at most `maxWidth` CSS pixels wide (base64). */
  'page.screenshot': { params: { tab: number; maxWidth?: number }; result: { data: string; width: number; height: number; tab: number; url: string; title: string } };
}

export interface BrowserStatus {
  connected: boolean;
  /** "Google Chrome 132", "Brave 1.74", "Firefox 158" … as the extension reports it. */
  browser?: string;
  extensionVersion?: string;
  /** How it runs input (absent from extensions before 0.3.0, which are all Chrome's: trusted). */
  input?: BrowserInput;
  /** Other browsers connected at the same time: Atelier uses the one the person used last (and a chat's tabs stay where they are). */
  others?: { browser: string; extensionVersion: string }[];
  /** Why it isn't connected, in the person's words ("The extension isn't installed", "Atelier for Chrome is out of date"). */
  problem?: string;
}

export type BrowserMethod = keyof BrowserMethods;

/** A request on the native messaging channel and over the host's socket. */
export interface BrowserRequest {
  id: number;
  method: BrowserMethod;
  params: unknown;
}

export interface BrowserResponse {
  id: number;
  result?: unknown;
  error?: string;
}

/** The extension's first message once connected; `engine` and `input` from 0.3.0 on. */
export interface BrowserHello {
  hello: { protocol: number; extensionVersion: string; browser: string; engine?: 'chromium' | 'gecko'; input?: BrowserInput };
}

/** Sent by the extension (0.3.0 on) when one of its browser's windows gets the focus: the browser the person is using now. */
export interface BrowserFocus {
  focus: true;
}
