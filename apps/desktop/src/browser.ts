/**
 * The Code Browser pane's pages (packages/ui/src/features/code/browser-pane.tsx): `<webview>`s in the app's window,
 * which keep Base UI menus and popovers drawing over them (a WebContentsView would sit above every DOM overlay).
 * As one attaches, whatever the renderer asked for is replaced: no preload, no Node, context isolation, a sandbox and
 * the pane's own persistent session, and only http(s) pages or workspace files (workspace-pages.ts). In that session
 * nothing is granted (camera, location, …) and downloads are refused. A page that opens a window gets a tab in the pane instead.
 *
 * Every guest passes through `attachGuest`, which is where model-controlled browsing can hook in later (driving a
 * guest's webContents and annotating its page); nothing does yet.
 */
import type { Session, WebContents, WebPreferences } from 'electron';
import { PAGES_SCHEME, isWorkspacePage, sameGrant } from './workspace-pages.ts';

export const BROWSER_PARTITION = 'persist:atelier-browser';

/** Icons larger than this are not shown. */
const MAX_FAVICON_BYTES = 256 * 1024;

/** Pages the pane may show: the web, local dev servers included. */
export function browsable(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Pages a tab may start at: the web, or a workspace file the window was given an origin for (workspace-pages.ts). */
export function openable(url: string): boolean {
  return browsable(url) || isWorkspacePage(url);
}

/**
 * `will-attach-webview`: sets what a page gets, whatever the renderer asked for (both objects are changed in place).
 * False when it must not attach: a page that isn't http(s) or a workspace file.
 */
export function hardenWebview(webPreferences: WebPreferences & { preloadURL?: string }, params: Record<string, string>): boolean {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  delete params.preload;
  Object.assign(webPreferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    partition: BROWSER_PARTITION,
  } satisfies WebPreferences);
  delete webPreferences.enableBlinkFeatures;
  delete webPreferences.disableBlinkFeatures;
  params.partition = BROWSER_PARTITION;
  return openable(params.src ?? '');
}

/** What the main process tells the window showing the pane. */
export interface BrowserEvents {
  open(host: WebContents, event: { webContentsId: number; url: string }): void;
  downloadBlocked(host: WebContents, event: { webContentsId: number; filename: string }): void;
}

/**
 * Window opens a page may turn into tabs: one per this many ms, the rest dropped. Electron doesn't say whether a
 * window open came from a click, and a page can open them in a loop as it loads.
 */
const OPEN_INTERVAL_MS = 500;

/**
 * Rules for one page once it has attached: new windows become tabs (a few at most), and it stays on http(s) or, from a
 * workspace file, on files of the same workspace.
 */
export function attachGuest(guest: WebContents, host: WebContents, events: Pick<BrowserEvents, 'open'>, now: () => number = Date.now): void {
  let opened = -Infinity;
  // A web page can't lead into a workspace; a workspace page only to its own files.
  const reachable = (url: string) => browsable(url) || (isWorkspacePage(url) && sameGrant(guest.getURL(), url));
  guest.setWindowOpenHandler(({ url }) => {
    const at = now();
    if (reachable(url) && at - opened >= OPEN_INTERVAL_MS) {
      opened = at;
      events.open(host, { webContentsId: guest.id, url });
    }
    return { action: 'deny' };
  });
  const stayOnTheWeb = (event: { preventDefault(): void }, url: string) => {
    if (!reachable(url)) event.preventDefault();
  };
  guest.on('will-navigate', stayOnTheWeb);
  guest.on('will-redirect', stayOnTheWeb);
}

/**
 * Requests the pane's session refuses: any `file:` URL, and pages (top-level) that aren't http(s) or workspace files.
 * Frames inside a page may also be `about:`, `data:` or `blob:` (an opaque origin each), and resources the web's usual
 * `data:` and `blob:`.
 */
export function refusedRequest({ url, resourceType }: { url: string; resourceType: string }): boolean {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return true;
  }
  if (protocol === 'http:' || protocol === 'https:' || protocol === `${PAGES_SCHEME}:`) return false;
  if (resourceType === 'mainFrame') return true;
  return !['about:', 'data:', 'blob:'].includes(protocol);
}

/**
 * The pane's session: nothing granted, downloads refused (the window is told), and nothing but the web loads in it,
 * even when the window itself points a page somewhere else (`loadURL` fires no navigation event). Once, at startup.
 */
export function prepareBrowserSession(session: Session, events: Pick<BrowserEvents, 'downloadBlocked'>): void {
  session.protocol.handle('file', () => new Response('Files are not shown in the Browser pane.', { status: 403 }));
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: refusedRequest(details) }));
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event, item, contents) => {
    event.preventDefault();
    const host = contents.hostWebContents;
    if (host) events.downloadBlocked(host, { webContentsId: contents.id, filename: item.getFilename() });
  });
}

const FAVICON_TIMEOUT_MS = 3000;
const FAVICON_TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)$/;

/**
 * A page's icon as a data URL, fetched in the pane's session; null unless it is a small image over http(s) that
 * arrives within a few seconds. A page names the URL, so the body is read in chunks and dropped as soon as it is too
 * big (or a declared length says it will be), never held whole.
 */
export async function fetchFavicon(session: Pick<Session, 'fetch'>, url: string): Promise<string | null> {
  if (!browsable(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);
  try {
    const response = await session.fetch(url, { signal: controller.signal });
    const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (!response.ok || !FAVICON_TYPES.test(type) || !response.body || declared > MAX_FAVICON_BYTES) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FAVICON_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // Whatever is still coming is not wanted.
    controller.abort();
  }
}
