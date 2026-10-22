import type { Session, WebContents, WebPreferences } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PARTITION, attachGuest, browsable, fetchFavicon, hardenWebview, prepareBrowserSession } from './browser.ts';

describe('the Browser pane’s pages', () => {
  it('only shows http(s)', () => {
    expect(browsable('http://localhost:5173/')).toBe(true);
    expect(browsable('https://docs.example.com/a')).toBe(true);
    for (const url of ['file:///etc/passwd', 'app://ui/index.html', 'atelier-blob://abc', 'javascript:alert(1)', 'chrome://gpu', 'about:blank', 'not a url'])
      expect(browsable(url)).toBe(false);
  });

  it('attach without preload or Node, isolated and sandboxed, in the pane’s own session, whatever was asked', () => {
    const webPreferences: WebPreferences & { preloadURL?: string } = {
      preload: '/evil.js',
      preloadURL: 'file:///evil.js',
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      webviewTag: true,
      enableBlinkFeatures: 'Something',
      partition: 'persist:app',
    };
    const params: Record<string, string> = { src: 'http://localhost:3000/', partition: 'persist:app', preload: 'file:///evil.js' };
    expect(hardenWebview(webPreferences, params)).toBe(true);
    expect(webPreferences).toEqual({
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
    });
    expect(params).toEqual({ src: 'http://localhost:3000/', partition: BROWSER_PARTITION });
  });

  it('attach to a workspace file the app serves', () => {
    expect(hardenWebview({}, { src: 'atelier-files://g1/site/index.html' })).toBe(true);
  });

  it('refuse to attach to anything but a web page', () => {
    for (const src of ['file:///Users/me/secret.txt', 'app://ui/index.html', 'data:text/html,<p>hi', ''])
      expect(hardenWebview({}, { src })).toBe(false);
  });

  it('open new windows as tabs in the pane and stay on the web', () => {
    const handlers: Record<string, (event: { preventDefault(): void }, url: string) => void> = {};
    let openHandler!: (details: { url: string }) => { action: string };
    const guest = {
      id: 42,
      setWindowOpenHandler: (fn: typeof openHandler) => void (openHandler = fn),
      on: (name: string, fn: (typeof handlers)[string]) => void (handlers[name] = fn),
    } as unknown as WebContents;
    const host = {} as WebContents;
    const open = vi.fn();
    attachGuest(guest, host, { open });

    expect(openHandler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' });
    expect(open).toHaveBeenCalledWith(host, { webContentsId: 42, url: 'https://example.com/docs' });
    expect(openHandler({ url: 'file:///etc/hosts' })).toEqual({ action: 'deny' });
    expect(open).toHaveBeenCalledTimes(1);

    for (const name of ['will-navigate', 'will-redirect']) {
      const event = { preventDefault: vi.fn() };
      handlers[name]!(event, 'http://localhost:8080/');
      expect(event.preventDefault).not.toHaveBeenCalled();
      handlers[name]!(event, 'file:///etc/hosts');
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it('let a workspace page lead only to files of its own workspace, and no web page into one', () => {
    const handlers: Record<string, (event: { preventDefault(): void }, url: string) => void> = {};
    let openHandler!: (details: { url: string }) => { action: string };
    let at = 'atelier-files://g1/site/index.html';
    const guest = {
      id: 5,
      getURL: () => at,
      setWindowOpenHandler: (fn: typeof openHandler) => void (openHandler = fn),
      on: (name: string, fn: (typeof handlers)[string]) => void (handlers[name] = fn),
    } as unknown as WebContents;
    const open = vi.fn();
    attachGuest(guest, {} as WebContents, { open }, () => 0);
    const navigates = (url: string) => {
      const event = { preventDefault: vi.fn() };
      handlers['will-navigate']!(event, url);
      return !event.preventDefault.mock.calls.length;
    };
    expect(navigates('atelier-files://g1/site/about.html')).toBe(true);
    expect(navigates('https://example.com/')).toBe(true);
    expect(navigates('atelier-files://g2/other.html')).toBe(false);
    openHandler({ url: 'atelier-files://g1/site/other.html' });
    expect(open).toHaveBeenCalledWith(expect.anything(), { webContentsId: 5, url: 'atelier-files://g1/site/other.html' });
    at = 'https://example.com/';
    expect(navigates('atelier-files://g1/site/index.html')).toBe(false);
  });

  it('turn at most one window open every half second into a tab, dropping the rest', () => {
    let openHandler!: (details: { url: string }) => { action: string };
    const guest = { id: 7, setWindowOpenHandler: (fn: typeof openHandler) => void (openHandler = fn), on: () => {} } as unknown as WebContents;
    const open = vi.fn();
    let now = 1000;
    attachGuest(guest, {} as WebContents, { open }, () => now);
    // A page opening windows in a loop as it loads.
    for (let i = 0; i < 200; i++) expect(openHandler({ url: `http://localhost:3000/popup${i}` })).toEqual({ action: 'deny' });
    expect(open).toHaveBeenCalledTimes(1);
    now += 499;
    openHandler({ url: 'http://localhost:3000/again' });
    expect(open).toHaveBeenCalledTimes(1);
    now += 1;
    openHandler({ url: 'http://localhost:3000/later' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('grant nothing and refuse downloads, telling the window', () => {
    let request!: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void;
    let check!: () => boolean;
    let download!: (event: { preventDefault(): void }, item: { getFilename(): string }, contents: { id: number; hostWebContents: WebContents | null }) => void;
    const session = {
      setPermissionRequestHandler: (fn: typeof request) => void (request = fn),
      setPermissionCheckHandler: (fn: typeof check) => void (check = fn),
      on: (_name: string, fn: typeof download) => void (download = fn),
      protocol: { handle: () => {} },
      webRequest: { onBeforeRequest: () => {} },
    } as unknown as Session;
    const downloadBlocked = vi.fn();
    prepareBrowserSession(session, { downloadBlocked });

    const granted = vi.fn();
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) request(null, permission, granted);
    expect(granted.mock.calls.every(([g]) => g === false)).toBe(true);
    expect(check()).toBe(false);

    const host = {} as WebContents;
    const event = { preventDefault: vi.fn() };
    download(event, { getFilename: () => 'setup.dmg' }, { id: 7, hostWebContents: host });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(downloadBlocked).toHaveBeenCalledWith(host, { webContentsId: 7, filename: 'setup.dmg' });
  });

  it('keep the session off files and anything but the web, whatever the window asks a page to load', async () => {
    // A compromised window could point a page at file: with loadURL, which no navigation event sees.
    const schemes: Record<string, (request: Request) => Response | Promise<Response>> = {};
    let filter!: (details: { url: string; resourceType: string }, callback: (response: { cancel: boolean }) => void) => void;
    const session = {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      on: () => {},
      protocol: { handle: (scheme: string, handler: (typeof schemes)[string]) => void (schemes[scheme] = handler) },
      webRequest: { onBeforeRequest: (fn: typeof filter) => void (filter = fn) },
    } as unknown as Session;
    prepareBrowserSession(session, { downloadBlocked: () => {} });

    expect((await schemes.file!(new Request('file:///etc/passwd'))).status).toBe(403);
    const cancelled = (url: string, resourceType: string) => {
      let answer: boolean | undefined;
      filter({ url, resourceType }, (r) => (answer = r.cancel));
      return answer;
    };
    expect(cancelled('file:///etc/passwd', 'mainFrame')).toBe(true);
    expect(cancelled('file:///Users/me/.ssh/id_ed25519', 'xhr')).toBe(true);
    expect(cancelled('chrome://settings', 'mainFrame')).toBe(true);
    expect(cancelled('data:text/html,<p>hi', 'mainFrame')).toBe(true);
    expect(cancelled('http://localhost:3000/', 'mainFrame')).toBe(false);
    expect(cancelled('https://example.com/a.js', 'script')).toBe(false);
    expect(cancelled('data:image/png;base64,AA', 'image')).toBe(false);
    expect(cancelled('about:blank', 'subFrame')).toBe(false);
    expect(cancelled('atelier-files://g1/index.html', 'mainFrame')).toBe(false);
    expect(cancelled('atelier-files://g1/style.css', 'stylesheet')).toBe(false);
  });

  it('fetch small image icons only', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('big.png')
        ? new Response(new Uint8Array(300 * 1024), { headers: { 'content-type': 'image/png' } })
        : url.endsWith('page.html')
          ? new Response('<html>', { headers: { 'content-type': 'text/html' } })
          : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/x-icon' } }),
    );
    const session = { fetch } as unknown as Pick<Session, 'fetch'>;
    expect(await fetchFavicon(session, 'http://localhost:3000/favicon.ico')).toBe('data:image/x-icon;base64,AQID');
    expect(await fetchFavicon(session, 'http://localhost:3000/big.png')).toBeNull();
    expect(await fetchFavicon(session, 'http://localhost:3000/page.html')).toBeNull();
    expect(await fetchFavicon(session, 'file:///favicon.ico')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  /** A body of `chunks` 64 KiB chunks, counting how many were read. */
  function endless(chunks: number) {
    const read = { count: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (read.count++ >= chunks) return controller.close();
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        read.cancelled = true;
      },
    });
    return { read, body };
  }

  it('stop reading an icon as soon as it is too big, and trust a length that says so', async () => {
    // A page names the URL: a huge body must never be held in memory.
    const huge = endless(6400);
    const streamed = { fetch: async () => new Response(huge.body, { headers: { 'content-type': 'image/png' } }) } as unknown as Pick<Session, 'fetch'>;
    expect(await fetchFavicon(streamed, 'http://localhost:3000/huge.png')).toBeNull();
    expect(huge.read.count).toBeLessThanOrEqual(6);
    expect(huge.read.cancelled).toBe(true);

    const declared = endless(6400);
    const announced = {
      fetch: async () => new Response(declared.body, { headers: { 'content-type': 'image/png', 'content-length': String(400 * 1024 * 1024) } }),
    } as unknown as Pick<Session, 'fetch'>;
    expect(await fetchFavicon(announced, 'http://localhost:3000/huge.png')).toBeNull();
    expect(declared.read.count).toBeLessThanOrEqual(1);
  });

  it('give up on an icon that takes too long', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const session = {
        fetch: (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            }),
          ),
      } as unknown as Pick<Session, 'fetch'>;
      const icon = fetchFavicon(session, 'http://localhost:3000/slow.ico');
      await vi.advanceTimersByTimeAsync(3000);
      expect(aborted).toBe(true);
      expect(await icon).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
