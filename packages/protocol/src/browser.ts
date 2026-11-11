/**
 * Atelier for Chrome (docs/ARCHITECTURE.md §22): the browser extension that works in web pages for computer use, in tabs
 * of its own. The core's Browser tool asks the desktop app's main process, which passes each call through the native
 * messaging host to the extension. The same methods are used on every hop.
 */

/** The native messaging host's name, as registered in each Chromium browser's `NativeMessagingHosts` folder. */
export const BROWSER_HOST_NAME = 'dev.atelier.browser';

/**
 * The extension ids allowed to reach the host. The unpacked build carries a public key in its manifest (apps/
 * browser-extension/manifest.json), so its id is the same on every computer; the Chrome Web Store id joins it once the
 * extension is published there.
 */
export const BROWSER_EXTENSION_IDS = ['ehblmofeglpkfcaejllehbbhhddchefk'] as const;

/** Protocol version, sent in the extension's hello; a mismatch is reported in Settings, not guessed around. */
export const BROWSER_PROTOCOL_VERSION = 1;

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
}

export interface BrowserPage extends BrowserTab {
  /** The page's text, as read (`read` with `text`), cut to `maxChars`; `truncated` when there was more. */
  text?: string;
  truncated?: boolean;
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
  /** Opens a tab of Atelier's own (in the background, in the "Atelier" tab group) and waits for the page to load. */
  'tabs.open': { params: { url: string }; result: BrowserTab };
  /** Atelier's own tabs. */
  'tabs.list': { params: Record<string, never>; result: { tabs: BrowserTab[] } };
  'tabs.close': { params: { tab: number }; result: Record<string, never> };
  'page.navigate': { params: { tab: number; url: string }; result: BrowserTab };
  'page.back': { params: { tab: number }; result: BrowserTab };
  /** The page's text and/or its usable elements. */
  'page.read': { params: { tab: number; text?: boolean; elements?: boolean; maxChars?: number; maxElements?: number }; result: BrowserPage };
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
  /** "Google Chrome 132", "Brave 1.74" … as the extension reports it. */
  browser?: string;
  extensionVersion?: string;
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

/** The extension's first message once connected. */
export interface BrowserHello {
  hello: { protocol: number; extensionVersion: string; browser: string };
}
